"use client";

import { useEffect, useState } from "react";

import { authTelegram, getMe, isUnauthorized } from "../src/lib/api";
import { clearToken, getToken, setToken } from "../src/lib/auth";
import { getTelegramInitData } from "../src/lib/telegram";

type Status = "loading" | "unauthorized" | "authorized" | "error";

type Profile = {
  user_id: string;
  telegram_id: number;
  username?: string;
  first_name?: string;
};

type Diagnostics = {
  tgPresent: boolean;
  initDataLength: number;
  userId: number | null;
  origin: string;
  apiBaseUrl: string;
  healthUrl: string;
  healthCheck: "ok" | "fail" | "pending";
  healthErrorType?: "network" | "cors" | "http";
  healthHttpStatus?: number;
  healthMessage?: string;
};

const getErrorMessage = (error: unknown): string => {
  if (isUnauthorized(error)) {
    return "Auth failed";
  }

  if (error instanceof Error && error.message === "API недоступен") {
    return "API недоступен";
  }

  return "Произошла ошибка";
};

export default function HomePage() {
  const [status, setStatus] = useState<Status>("loading");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [message, setMessage] = useState<string>("");
  const [diagnostics, setDiagnostics] = useState<Diagnostics>({
    tgPresent: false,
    initDataLength: 0,
    userId: null,
    origin: "",
    apiBaseUrl: "",
    healthUrl: "",
    healthCheck: "pending",
  });

  useEffect(() => {
    const loadProfile = async () => {
      const telegramWindow = window as typeof window & {
        Telegram?: {
          WebApp?: {
            initData?: string;
            initDataUnsafe?: { user?: { id?: number } };
            ready?: () => void;
            expand?: () => void;
          };
        };
      };
      const telegram = telegramWindow.Telegram?.WebApp;
      if (telegram) {
        telegram.ready?.();
        telegram.expand?.();
      }

      const initData =
        typeof telegram?.initData === "string" ? telegram.initData : "";

      const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
      const healthUrl = apiBaseUrl ? `${apiBaseUrl}/health` : "";

      setDiagnostics({
        tgPresent: Boolean(telegram),
        initDataLength: initData.length,
        userId: telegram?.initDataUnsafe?.user?.id ?? null,
        origin: window.location.origin,
        apiBaseUrl,
        healthUrl,
        healthCheck: "pending",
      });

      setStatus("loading");
      setMessage("");

      if (!apiBaseUrl) {
        setDiagnostics((prev) => ({
          ...prev,
          healthCheck: "fail",
          healthErrorType: "network",
          healthMessage: "NEXT_PUBLIC_API_BASE_URL не задан",
        }));
        setStatus("error");
        setMessage("NEXT_PUBLIC_API_BASE_URL не задан");
        return;
      }

      try {
        const response = await fetch(healthUrl, { method: "GET" });
        if (response.ok) {
          setDiagnostics((prev) => ({
            ...prev,
            healthCheck: "ok",
          }));
        } else {
          setDiagnostics((prev) => ({
            ...prev,
            healthCheck: "fail",
            healthErrorType: "http",
            healthHttpStatus: response.status,
            healthMessage: response.statusText || "HTTP error",
          }));
        }
      } catch (error) {
        let errorType: "network" | "cors" = "network";
        try {
          if (
            new URL(apiBaseUrl).origin !== window.location.origin &&
            error instanceof TypeError
          ) {
            errorType = "cors";
          }
        } catch {
          errorType = "network";
        }
        setDiagnostics((prev) => ({
          ...prev,
          healthCheck: "fail",
          healthErrorType: errorType,
          healthMessage: error instanceof Error ? error.message : "Network error",
        }));
      }

      const token = getToken();
      if (token) {
        try {
          const me = await getMe(token);
          setProfile(me);
          setStatus("authorized");
          return;
        } catch (error) {
          if (isUnauthorized(error)) {
            clearToken();
          } else {
            setStatus("error");
            setMessage(getErrorMessage(error));
            return;
          }
        }
      }

      const telegramInitData = initData || getTelegramInitData();
      if (!telegramInitData) {
        setStatus("unauthorized");
        setMessage("Нет initData");
        return;
      }

      try {
        const authResponse = await authTelegram(telegramInitData);
        setToken(authResponse.access_token);

        const me = await getMe(authResponse.access_token);
        setProfile(me);
        setStatus("authorized");
      } catch (error) {
        setStatus("error");
        setMessage(getErrorMessage(error));
      }
    };

    void loadProfile();
  }, []);

  const handleLogout = () => {
    clearToken();
    setProfile(null);
    setStatus("unauthorized");
    setMessage("");
  };

  return (
    <main>
      <h1>Мои финансы</h1>
      <section>
        <p>
          <strong>Статус:</strong> {status}
        </p>
        {status === "unauthorized" && (
          <>
            {message && <p>{message}</p>}
            <p>Откройте в Telegram Mini App</p>
          </>
        )}
        {status === "error" && message && <p>{message}</p>}
      </section>

      <section>
        <h2>Диагностика</h2>
        <ul>
          <li>
            <strong>tg_present:</strong> {String(diagnostics.tgPresent)}
          </li>
          <li>
            <strong>initData_length:</strong> {diagnostics.initDataLength}
          </li>
          <li>
            <strong>user_id:</strong> {diagnostics.userId ?? "-"}
          </li>
          <li>
            <strong>origin:</strong> {diagnostics.origin || "-"}
          </li>
          <li>
            <strong>api_base_url:</strong> {diagnostics.apiBaseUrl || "-"}
          </li>
          <li>
            <strong>health_url:</strong> {diagnostics.healthUrl || "-"}
          </li>
          <li>
            <strong>health_check:</strong> {diagnostics.healthCheck}
          </li>
          {diagnostics.healthCheck === "fail" && (
            <>
              <li>
                <strong>error_type:</strong>{" "}
                {diagnostics.healthErrorType ?? "-"}
              </li>
              <li>
                <strong>http_status:</strong>{" "}
                {diagnostics.healthHttpStatus ?? "-"}
              </li>
              <li>
                <strong>message:</strong> {diagnostics.healthMessage ?? "-"}
              </li>
            </>
          )}
        </ul>
      </section>

      {status === "authorized" && profile && (
        <section>
          <h2>Профиль</h2>
          <ul>
            <li>
              <strong>user_id:</strong> {profile.user_id}
            </li>
            <li>
              <strong>telegram_id:</strong> {profile.telegram_id}
            </li>
            <li>
              <strong>username:</strong> {profile.username ?? "-"}
            </li>
            <li>
              <strong>first_name:</strong> {profile.first_name ?? "-"}
            </li>
          </ul>
          <button type="button" onClick={handleLogout}>
            Logout
          </button>
        </section>
      )}
    </main>
  );
}
