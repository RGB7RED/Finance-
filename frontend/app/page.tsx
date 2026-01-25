"use client";

import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";

import {
  type Account,
  type Budget,
  type Category,
  createAccount,
  createCategory,
  ensureDefaultBudgets,
  getApiBaseUrl,
  getMe,
  isUnauthorized,
  listAccounts,
  listBudgets,
  listCategories,
} from "../src/lib/api";
import { clearToken, getToken, setToken } from "../src/lib/auth";
import { supabase } from "../src/lib/supabase";

type Status = "loading" | "unauthorized" | "ready" | "error";

const ACTIVE_BUDGET_STORAGE_KEY = "mf_active_budget_id";

type HealthErrorDetails = {
  url: string;
};

const buildErrorMessage = (fallback: string, error: unknown): string => {
  if (isUnauthorized(error)) {
    return "Сессия истекла, войдите заново";
  }

  if (error instanceof Error && error.message === "API недоступен") {
    return "API недоступен";
  }

  return fallback;
};

export default function HomePage() {
  const [status, setStatus] = useState<Status>("loading");
  const [token, setTokenState] = useState<string | null>(null);
  const [message, setMessage] = useState<string>("");
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [activeBudgetId, setActiveBudgetId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accountName, setAccountName] = useState("");
  const [accountKind, setAccountKind] = useState("cash");
  const [categoryName, setCategoryName] = useState("");
  const [categoryParent, setCategoryParent] = useState("");
  const [healthErrorDetails, setHealthErrorDetails] =
    useState<HealthErrorDetails | null>(null);
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);

  const loadDashboard = async (resolvedToken: string) => {
    setTokenState(resolvedToken);

    try {
      await ensureDefaultBudgets(resolvedToken);
    } catch (error) {
      setStatus("error");
      setMessage(buildErrorMessage("Не удалось создать бюджеты", error));
      return;
    }

    let loadedBudgets: Budget[];
    try {
      loadedBudgets = await listBudgets(resolvedToken);
      setBudgets(loadedBudgets);
    } catch (error) {
      setStatus("error");
      setMessage(buildErrorMessage("Не удалось загрузить бюджеты", error));
      return;
    }

    if (!loadedBudgets.length) {
      setStatus("error");
      setMessage("Бюджеты не найдены");
      return;
    }

    const storedBudgetId = localStorage.getItem(ACTIVE_BUDGET_STORAGE_KEY);
    const matchedBudget =
      storedBudgetId &&
      loadedBudgets.find((budget) => budget.id === storedBudgetId);
    const nextBudgetId = matchedBudget
      ? matchedBudget.id
      : loadedBudgets[0].id;
    localStorage.setItem(ACTIVE_BUDGET_STORAGE_KEY, nextBudgetId);
    setActiveBudgetId(nextBudgetId);

    try {
      const [loadedAccounts, loadedCategories] = await Promise.all([
        listAccounts(resolvedToken, nextBudgetId),
        listCategories(resolvedToken, nextBudgetId),
      ]);
      setAccounts(loadedAccounts);
      setCategories(loadedCategories);
      setStatus("ready");
    } catch (error) {
      setStatus("error");
      setMessage(
        buildErrorMessage("Не удалось загрузить счета и категории", error),
      );
    }
  };

  useEffect(() => {
    const bootstrap = async () => {
      const apiBaseUrl = getApiBaseUrl() ?? "";
      const healthUrl = apiBaseUrl ? `${apiBaseUrl}/health` : "/health";

      setStatus("loading");
      setMessage("");
      setHealthErrorDetails(null);

      if (!apiBaseUrl) {
        setStatus("error");
        setHealthErrorDetails({ url: "/health" });
        setMessage("API недоступен");
        return;
      }

      try {
        const healthResponse = await fetch(healthUrl);
        if (!healthResponse.ok) {
          setStatus("error");
          setHealthErrorDetails({ url: healthUrl });
          setMessage("API недоступен");
          return;
        }
      } catch (error) {
        setStatus("error");
        setHealthErrorDetails({ url: healthUrl });
        setMessage("API недоступен");
        return;
      }

      let resolvedToken = getToken();
      if (resolvedToken) {
        try {
          await getMe(resolvedToken);
        } catch (error) {
          if (isUnauthorized(error)) {
            clearToken();
            resolvedToken = null;
          } else {
            setStatus("error");
            setMessage(buildErrorMessage("Не удалось загрузить профиль", error));
            return;
          }
        }
      }

      if (!resolvedToken) {
        setStatus("unauthorized");
        return;
      }

      await loadDashboard(resolvedToken);
    };

    void bootstrap();
  }, []);

  const handleSendOtp = async () => {
    setMessage("");
    try {
      const { error } = await supabase.auth.signInWithOtp({ email });
      if (error) {
        throw error;
      }
      setOtpSent(true);
      setMessage("Код отправлен на почту");
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось отправить код", error));
    }
  };

  const handleVerifyOtp = async () => {
    setMessage("");
    try {
      const { data, error } = await supabase.auth.verifyOtp({
        email,
        token: otp,
        type: "email",
      });
      if (error) {
        throw error;
      }
      const accessToken = data.session?.access_token;
      if (!accessToken) {
        setMessage("Не удалось получить access token");
        return;
      }
      setToken(accessToken);
      setStatus("loading");
      await loadDashboard(accessToken);
      setOtp("");
      setOtpSent(false);
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось подтвердить код", error));
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    clearToken();
    setTokenState(null);
    setStatus("unauthorized");
    setMessage("");
    setBudgets([]);
    setActiveBudgetId(null);
    setAccounts([]);
    setCategories([]);
    setEmail("");
    setOtp("");
    setOtpSent(false);
  };

  const categoryMap = useMemo(() => {
    const map = new Map<string, Category[]>();
    categories.forEach((category) => {
      const key = category.parent_id ?? "root";
      const existing = map.get(key) ?? [];
      existing.push(category);
      map.set(key, existing);
    });
    return map;
  }, [categories]);

  const renderCategoryTree = (parentId: string | null) => {
    const key = parentId ?? "root";
    const items = categoryMap.get(key) ?? [];
    if (!items.length) {
      return null;
    }
    return (
      <ul>
        {items.map((category) => (
          <li key={category.id}>
            {category.name}
            {renderCategoryTree(category.id)}
          </li>
        ))}
      </ul>
    );
  };

  const handleBudgetChange = async (event: ChangeEvent<HTMLSelectElement>) => {
    const nextBudgetId = event.target.value;
    if (!token || !nextBudgetId) {
      return;
    }
    setMessage("");
    setActiveBudgetId(nextBudgetId);
    localStorage.setItem(ACTIVE_BUDGET_STORAGE_KEY, nextBudgetId);
    try {
      const [loadedAccounts, loadedCategories] = await Promise.all([
        listAccounts(token, nextBudgetId),
        listCategories(token, nextBudgetId),
      ]);
      setAccounts(loadedAccounts);
      setCategories(loadedCategories);
    } catch (error) {
      setMessage(
        buildErrorMessage("Не удалось загрузить счета и категории", error),
      );
    }
  };

  const handleCreateAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !activeBudgetId) {
      return;
    }
    setMessage("");
    try {
      await createAccount(token, {
        budget_id: activeBudgetId,
        name: accountName,
        kind: accountKind,
      });
      setAccountName("");
      const updatedAccounts = await listAccounts(token, activeBudgetId);
      setAccounts(updatedAccounts);
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось добавить счет", error));
    }
  };

  const handleCreateCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !activeBudgetId) {
      return;
    }
    setMessage("");
    const parentId = categoryParent ? categoryParent : null;
    try {
      await createCategory(token, {
        budget_id: activeBudgetId,
        name: categoryName,
        parent_id: parentId,
      });
      setCategoryName("");
      setCategoryParent("");
      const updatedCategories = await listCategories(token, activeBudgetId);
      setCategories(updatedCategories);
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось добавить категорию", error));
    }
  };

  return (
    <main>
      <h1>Мои финансы</h1>
      <section>
        {status === "loading" && <p>Загрузка...</p>}
        {status === "unauthorized" && (
          <>
            {message && <p>{message}</p>}
            <div>
              <label>
                Email:
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </label>
            </div>
            <button type="button" onClick={handleSendOtp} disabled={!email}>
              Отправить код
            </button>
            {otpSent && (
              <div>
                <label>
                  Код:
                  <input
                    type="text"
                    value={otp}
                    onChange={(event) => setOtp(event.target.value)}
                  />
                </label>
                <button type="button" onClick={handleVerifyOtp} disabled={!otp}>
                  Подтвердить
                </button>
              </div>
            )}
          </>
        )}
        {status === "error" && (
          <>
            {message && <p>{message}</p>}
            {healthErrorDetails && (
              <div>
                <p>API недоступен</p>
                <p>url: {healthErrorDetails.url}</p>
              </div>
            )}
          </>
        )}
        {status === "ready" && message && <p>{message}</p>}
      </section>

      {status === "ready" && (
        <>
          <section>
            <h2>Бюджеты</h2>
            <label>
              Активный бюджет:
              <select
                value={activeBudgetId ?? ""}
                onChange={handleBudgetChange}
              >
                {budgets.map((budget) => (
                  <option key={budget.id} value={budget.id}>
                    {budget.name} ({budget.type})
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section>
            <h2>Счета</h2>
            {accounts.length ? (
              <ul>
                {accounts.map((account) => (
                  <li key={account.id}>
                    {account.name} ({account.kind})
                  </li>
                ))}
              </ul>
            ) : (
              <p>Нет счетов</p>
            )}
          </section>

          <section>
            <h2>Категории</h2>
            {categories.length ? renderCategoryTree(null) : <p>Нет категорий</p>}
          </section>

          <section>
            <h2>Добавить счёт</h2>
            <form onSubmit={handleCreateAccount}>
              <label>
                Название:
                <input
                  type="text"
                  value={accountName}
                  onChange={(event) => setAccountName(event.target.value)}
                  required
                />
              </label>
              <label>
                Тип:
                <select
                  value={accountKind}
                  onChange={(event) => setAccountKind(event.target.value)}
                >
                  <option value="cash">Наличные</option>
                  <option value="bank">Банк</option>
                </select>
              </label>
              <button type="submit">Добавить</button>
            </form>
          </section>

          <section>
            <h2>Добавить категорию</h2>
            <form onSubmit={handleCreateCategory}>
              <label>
                Название:
                <input
                  type="text"
                  value={categoryName}
                  onChange={(event) => setCategoryName(event.target.value)}
                  required
                />
              </label>
              <label>
                Родитель:
                <select
                  value={categoryParent}
                  onChange={(event) => setCategoryParent(event.target.value)}
                >
                  <option value="">None</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit">Добавить</button>
            </form>
          </section>

          <section>
            <button type="button" onClick={handleLogout}>
              Logout
            </button>
          </section>
        </>
      )}
    </main>
  );
}
