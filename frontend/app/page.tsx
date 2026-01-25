"use client";

import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";

import {
  type Account,
  type Budget,
  type Category,
  authTelegram,
  createAccount,
  createCategory,
  ensureDefaultBudgets,
  getMe,
  isUnauthorized,
  listAccounts,
  listBudgets,
  listCategories,
} from "../src/lib/api";
import { clearToken, getToken, setToken } from "../src/lib/auth";
import { getTelegramInitData } from "../src/lib/telegram";

type Status = "loading" | "unauthorized" | "ready" | "error";

const ACTIVE_BUDGET_STORAGE_KEY = "mf_active_budget_id";

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

  useEffect(() => {
    const loadDashboard = async () => {
      const telegramWindow = window as typeof window & {
        Telegram?: {
          WebApp?: {
            initData?: string;
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

      setStatus("loading");
      setMessage("");

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
        const telegramInitData = initData || getTelegramInitData();
        if (!telegramInitData) {
          setStatus("unauthorized");
          setMessage("Нет initData");
          return;
        }

        try {
          const authResponse = await authTelegram(telegramInitData);
          setToken(authResponse.access_token);
          resolvedToken = authResponse.access_token;
        } catch (error) {
          setStatus("error");
          setMessage(buildErrorMessage("Не удалось выполнить авторизацию", error));
          return;
        }
      }

      if (!resolvedToken) {
        setStatus("unauthorized");
        setMessage("Нет токена авторизации");
        return;
      }

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

    void loadDashboard();
  }, []);

  const handleLogout = () => {
    clearToken();
    setTokenState(null);
    setStatus("unauthorized");
    setMessage("");
    setBudgets([]);
    setActiveBudgetId(null);
    setAccounts([]);
    setCategories([]);
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
            <p>Откройте в Telegram Mini App</p>
          </>
        )}
        {status === "error" && message && <p>{message}</p>}
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
