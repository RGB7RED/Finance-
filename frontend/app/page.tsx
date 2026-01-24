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

  useEffect(() => {
    const loadProfile = async () => {
      setStatus("loading");
      setMessage("");

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

      const initData = getTelegramInitData();
      if (!initData) {
        setStatus("unauthorized");
        setMessage("Нет initData");
        return;
      }

      try {
        const authResponse = await authTelegram(initData);
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
