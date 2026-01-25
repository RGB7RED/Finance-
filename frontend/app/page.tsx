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
  type AuthError,
  type Budget,
  type Category,
  type DailyState,
  type Transaction,
  authTelegram,
  createAccount,
  createCategory,
  createTransaction,
  deleteTransaction,
  ensureDefaultBudgets,
  getDailyDelta,
  getDailyState,
  getApiBaseUrl,
  getMe,
  isUnauthorized,
  listAccounts,
  listBudgets,
  listCategories,
  listTransactions,
  updateDailyState,
} from "../src/lib/api";
import { clearToken, getToken, setToken } from "../src/lib/auth";
import { getTelegramInitData } from "../src/lib/telegram";

type Status = "loading" | "unauthorized" | "ready" | "error";

const ACTIVE_BUDGET_STORAGE_KEY = "mf_active_budget_id";

type AuthErrorDetails = {
  authUrl: string;
  errorCode: "NO_INITDATA" | "NETWORK" | "HTTP_401" | "HTTP_500" | "UNKNOWN";
  httpStatus?: number;
  responseText?: string;
  initDataLength: number;
};

type HealthErrorDetails = {
  url: string;
};

type FormErrorDetails = {
  httpStatus?: number;
  responseText?: string;
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
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [dailyState, setDailyState] = useState<DailyState | null>(null);
  const [dailyDelta, setDailyDelta] = useState<number | null>(null);
  const [dailyStateForm, setDailyStateForm] = useState({
    cash_total: "",
    bank_total: "",
    debt_cards_total: "",
    debt_other_total: "",
  });
  const [accountName, setAccountName] = useState("");
  const [accountKind, setAccountKind] = useState("cash");
  const [categoryName, setCategoryName] = useState("");
  const [categoryParent, setCategoryParent] = useState("");
  const [selectedDate, setSelectedDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [incomeAccountId, setIncomeAccountId] = useState("");
  const [incomeAmount, setIncomeAmount] = useState("");
  const [incomeNote, setIncomeNote] = useState("");
  const [expenseAccountId, setExpenseAccountId] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseCategoryId, setExpenseCategoryId] = useState("");
  const [expenseTag, setExpenseTag] = useState<"one_time" | "subscription">(
    "one_time",
  );
  const [expenseNote, setExpenseNote] = useState("");
  const [transferFromAccountId, setTransferFromAccountId] = useState("");
  const [transferToAccountId, setTransferToAccountId] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [transferNote, setTransferNote] = useState("");
  const [authErrorDetails, setAuthErrorDetails] =
    useState<AuthErrorDetails | null>(null);
  const [healthErrorDetails, setHealthErrorDetails] =
    useState<HealthErrorDetails | null>(null);
  const [accountErrorDetails, setAccountErrorDetails] =
    useState<FormErrorDetails | null>(null);
  const [categoryErrorDetails, setCategoryErrorDetails] =
    useState<FormErrorDetails | null>(null);
  const [incomeErrorDetails, setIncomeErrorDetails] =
    useState<FormErrorDetails | null>(null);
  const [expenseErrorDetails, setExpenseErrorDetails] =
    useState<FormErrorDetails | null>(null);
  const [transferErrorDetails, setTransferErrorDetails] =
    useState<FormErrorDetails | null>(null);

  const setDailyStateFromData = (state: DailyState) => {
    setDailyState(state);
    setDailyStateForm({
      cash_total: String(state.cash_total ?? 0),
      bank_total: String(state.bank_total ?? 0),
      debt_cards_total: String(state.debt_cards_total ?? 0),
      debt_other_total: String(state.debt_other_total ?? 0),
    });
  };

  const parseAmount = (value: string): number => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const loadDailyStateData = async (
    authToken: string,
    budgetId: string,
    dateValue: string,
  ) => {
    const [state, delta] = await Promise.all([
      getDailyState(authToken, budgetId, dateValue),
      getDailyDelta(authToken, budgetId, dateValue),
    ]);
    setDailyStateFromData(state);
    setDailyDelta(delta.top_day_total);
  };

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

      const initDataFromTelegram =
        typeof telegram?.initData === "string" ? telegram.initData : "";
      const apiBaseUrl = getApiBaseUrl() ?? "";
      const authUrl = apiBaseUrl ? `${apiBaseUrl}/auth/telegram` : "";
      const healthUrl = apiBaseUrl ? `${apiBaseUrl}/health` : "/health";

      setStatus("loading");
      setMessage("");
      setAuthErrorDetails(null);
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
        const telegramInitData = initDataFromTelegram || getTelegramInitData();
        if (!telegramInitData) {
          setStatus("unauthorized");
          setAuthErrorDetails({
            authUrl,
            errorCode: "NO_INITDATA",
            initDataLength: 0,
          });
          setMessage("Ошибка авторизации");
          return;
        }
        const initDataLength = telegramInitData.length;

        try {
          const authResponse = await authTelegram(telegramInitData);
          setToken(authResponse.access_token);
          resolvedToken = authResponse.access_token;
        } catch (error) {
          setStatus("error");
          const authError = error as AuthError;
          const isNetworkError = authError?.code === "NETWORK_ERROR";
          const statusCode = authError?.status;
          let errorCode: AuthErrorDetails["errorCode"] = "UNKNOWN";
          if (isNetworkError) {
            errorCode = "NETWORK";
          } else if (statusCode === 401) {
            errorCode = "HTTP_401";
          } else if (statusCode && statusCode >= 500) {
            errorCode = "HTTP_500";
          }
          setAuthErrorDetails({
            authUrl,
            errorCode,
            httpStatus: statusCode,
            responseText: authError?.text,
            initDataLength,
          });
          setMessage(buildErrorMessage("Ошибка авторизации", error));
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
        const [loadedAccounts, loadedCategories, loadedTransactions] =
          await Promise.all([
            listAccounts(resolvedToken, nextBudgetId),
            listCategories(resolvedToken, nextBudgetId),
            listTransactions(resolvedToken, nextBudgetId, selectedDate),
            loadDailyStateData(resolvedToken, nextBudgetId, selectedDate),
          ]);
        setAccounts(loadedAccounts);
        setCategories(loadedCategories);
        setTransactions(loadedTransactions);
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
    setTransactions([]);
    setDailyState(null);
    setDailyDelta(null);
    setDailyStateForm({
      cash_total: "",
      bank_total: "",
      debt_cards_total: "",
      debt_other_total: "",
    });
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

  const accountMap = useMemo(() => {
    const map = new Map<string, Account>();
    accounts.forEach((account) => {
      map.set(account.id, account);
    });
    return map;
  }, [accounts]);

  const dailyTotal = useMemo(() => {
    return transactions.reduce((total, tx) => {
      if (tx.type === "income") {
        return total + tx.amount;
      }
      if (tx.type === "expense") {
        return total - tx.amount;
      }
      return total;
    }, 0);
  }, [transactions]);

  const assetsTotal = useMemo(() => {
    return (
      parseAmount(dailyStateForm.cash_total) +
      parseAmount(dailyStateForm.bank_total)
    );
  }, [dailyStateForm.bank_total, dailyStateForm.cash_total]);

  const debtsTotal = useMemo(() => {
    return (
      parseAmount(dailyStateForm.debt_cards_total) +
      parseAmount(dailyStateForm.debt_other_total)
    );
  }, [dailyStateForm.debt_cards_total, dailyStateForm.debt_other_total]);

  const balanceTotal = useMemo(() => {
    return assetsTotal - debtsTotal;
  }, [assetsTotal, debtsTotal]);

  const topDayTotal = dailyDelta ?? 0;
  const dayDiff = topDayTotal - dailyTotal;
  const dayDiffAbs = Math.abs(dayDiff);
  const isReconciled = dayDiffAbs <= 1;

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
      const [loadedAccounts, loadedCategories, loadedTransactions] =
        await Promise.all([
          listAccounts(token, nextBudgetId),
          listCategories(token, nextBudgetId),
          listTransactions(token, nextBudgetId, selectedDate),
          loadDailyStateData(token, nextBudgetId, selectedDate),
        ]);
      setAccounts(loadedAccounts);
      setCategories(loadedCategories);
      setTransactions(loadedTransactions);
    } catch (error) {
      setMessage(
        buildErrorMessage("Не удалось загрузить счета и категории", error),
      );
    }
  };

  useEffect(() => {
    const loadTransactionsForDate = async () => {
      if (!token || !activeBudgetId) {
        return;
      }
      try {
        const [loadedTransactions] = await Promise.all([
          listTransactions(token, activeBudgetId, selectedDate),
          loadDailyStateData(token, activeBudgetId, selectedDate),
        ]);
        setTransactions(loadedTransactions);
      } catch (error) {
        setMessage(buildErrorMessage("Не удалось загрузить операции", error));
      }
    };

    void loadTransactionsForDate();
  }, [token, activeBudgetId, selectedDate]);

  const handleCreateAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !activeBudgetId) {
      return;
    }
    setMessage("");
    setAccountErrorDetails(null);
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
      const apiError = error as Error & { status?: number; text?: string };
      setAccountErrorDetails({
        httpStatus: apiError.status,
        responseText: apiError.text,
      });
      setMessage(buildErrorMessage("Не удалось добавить счет", error));
    }
  };

  const handleCreateCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !activeBudgetId) {
      return;
    }
    setMessage("");
    setCategoryErrorDetails(null);
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
      const apiError = error as Error & { status?: number; text?: string };
      setCategoryErrorDetails({
        httpStatus: apiError.status,
        responseText: apiError.text,
      });
      setMessage(buildErrorMessage("Не удалось добавить категорию", error));
    }
  };

  const handleCreateIncome = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !activeBudgetId) {
      return;
    }
    const amount = Number.parseInt(incomeAmount, 10);
    if (!incomeAccountId) {
      setMessage("Выберите счет");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setMessage("Сумма должна быть больше нуля");
      return;
    }
    setMessage("");
    setIncomeErrorDetails(null);
    try {
      await createTransaction(token, {
        budget_id: activeBudgetId,
        type: "income",
        amount,
        date: selectedDate,
        account_id: incomeAccountId,
        tag: "one_time",
        note: incomeNote ? incomeNote : null,
      });
      setIncomeAmount("");
      setIncomeNote("");
      const updatedTransactions = await listTransactions(
        token,
        activeBudgetId,
        selectedDate,
      );
      setTransactions(updatedTransactions);
    } catch (error) {
      const apiError = error as Error & { status?: number; text?: string };
      setIncomeErrorDetails({
        httpStatus: apiError.status,
        responseText: apiError.text,
      });
      setMessage(buildErrorMessage("Не удалось добавить доход", error));
    }
  };

  const handleCreateExpense = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !activeBudgetId) {
      return;
    }
    const amount = Number.parseInt(expenseAmount, 10);
    if (!expenseAccountId) {
      setMessage("Выберите счет");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setMessage("Сумма должна быть больше нуля");
      return;
    }
    setMessage("");
    setExpenseErrorDetails(null);
    const categoryId = expenseCategoryId ? expenseCategoryId : null;
    try {
      await createTransaction(token, {
        budget_id: activeBudgetId,
        type: "expense",
        amount,
        date: selectedDate,
        account_id: expenseAccountId,
        category_id: categoryId,
        tag: expenseTag,
        note: expenseNote ? expenseNote : null,
      });
      setExpenseAmount("");
      setExpenseNote("");
      const updatedTransactions = await listTransactions(
        token,
        activeBudgetId,
        selectedDate,
      );
      setTransactions(updatedTransactions);
    } catch (error) {
      const apiError = error as Error & { status?: number; text?: string };
      setExpenseErrorDetails({
        httpStatus: apiError.status,
        responseText: apiError.text,
      });
      setMessage(buildErrorMessage("Не удалось добавить расход", error));
    }
  };

  const handleCreateTransfer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !activeBudgetId) {
      return;
    }
    const amount = Number.parseInt(transferAmount, 10);
    if (!transferFromAccountId || !transferToAccountId) {
      setMessage("Выберите счета");
      return;
    }
    if (transferFromAccountId === transferToAccountId) {
      setMessage("Счета перевода должны различаться");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setMessage("Сумма должна быть больше нуля");
      return;
    }
    setMessage("");
    setTransferErrorDetails(null);
    try {
      await createTransaction(token, {
        budget_id: activeBudgetId,
        type: "transfer",
        amount,
        date: selectedDate,
        account_id: transferFromAccountId,
        to_account_id: transferToAccountId,
        tag: "one_time",
        note: transferNote ? transferNote : null,
      });
      setTransferAmount("");
      setTransferNote("");
      const updatedTransactions = await listTransactions(
        token,
        activeBudgetId,
        selectedDate,
      );
      setTransactions(updatedTransactions);
    } catch (error) {
      const apiError = error as Error & { status?: number; text?: string };
      setTransferErrorDetails({
        httpStatus: apiError.status,
        responseText: apiError.text,
      });
      setMessage(buildErrorMessage("Не удалось добавить перевод", error));
    }
  };

  const handleDeleteTransaction = async (txId: string) => {
    if (!token || !activeBudgetId) {
      return;
    }
    setMessage("");
    try {
      await deleteTransaction(token, txId);
      const updatedTransactions = await listTransactions(
        token,
        activeBudgetId,
        selectedDate,
      );
      setTransactions(updatedTransactions);
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось удалить операцию", error));
    }
  };

  const handleDailyStateChange = (
    field: keyof typeof dailyStateForm,
    value: string,
  ) => {
    if (Number.parseInt(value, 10) < 0) {
      return;
    }
    setDailyStateForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSaveDailyState = async () => {
    if (!token || !activeBudgetId) {
      return;
    }
    setMessage("");
    try {
      const payload = {
        budget_id: activeBudgetId,
        date: selectedDate,
        cash_total: parseAmount(dailyStateForm.cash_total),
        bank_total: parseAmount(dailyStateForm.bank_total),
        debt_cards_total: parseAmount(dailyStateForm.debt_cards_total),
        debt_other_total: parseAmount(dailyStateForm.debt_other_total),
      };
      const updated = await updateDailyState(token, payload);
      setDailyStateFromData(updated);
      const delta = await getDailyDelta(token, activeBudgetId, selectedDate);
      setDailyDelta(delta.top_day_total);
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось сохранить состояние дня", error));
    }
  };

  const handleQuickAdjust = async (
    field: "cash_total" | "bank_total",
    delta: number,
  ) => {
    if (!token || !activeBudgetId) {
      return;
    }
    const currentValue = parseAmount(dailyStateForm[field]);
    const nextValue = currentValue + delta;
    if (nextValue < 0) {
      setMessage("Нельзя уменьшить ниже нуля");
      return;
    }
    setMessage("");
    try {
      const updated = await updateDailyState(token, {
        budget_id: activeBudgetId,
        date: selectedDate,
        [field]: nextValue,
      });
      setDailyStateFromData(updated);
      const updatedDelta = await getDailyDelta(
        token,
        activeBudgetId,
        selectedDate,
      );
      setDailyDelta(updatedDelta.top_day_total);
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось обновить состояние дня", error));
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
            {authErrorDetails && (
              <div>
                <p>auth_url: {authErrorDetails.authUrl}</p>
                <p>error_code: {authErrorDetails.errorCode}</p>
                <p>initData_length: {authErrorDetails.initDataLength}</p>
                {authErrorDetails.httpStatus !== undefined && (
                  <p>http_status: {authErrorDetails.httpStatus}</p>
                )}
                {authErrorDetails.responseText && (
                  <p>response_text: {authErrorDetails.responseText}</p>
                )}
              </div>
            )}
            <p>Откройте в Telegram Mini App</p>
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
            {authErrorDetails && !healthErrorDetails && (
              <div>
                <p>auth_url: {authErrorDetails.authUrl}</p>
                <p>error_code: {authErrorDetails.errorCode}</p>
                <p>initData_length: {authErrorDetails.initDataLength}</p>
                {authErrorDetails.httpStatus !== undefined && (
                  <p>http_status: {authErrorDetails.httpStatus}</p>
                )}
                {authErrorDetails.responseText && (
                  <p>response_text: {authErrorDetails.responseText}</p>
                )}
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
            <h2>Состояние дня (верхняя таблица)</h2>
            <div>
              <label>
                Наличка:
                <input
                  type="number"
                  min="0"
                  value={dailyStateForm.cash_total}
                  onChange={(event) =>
                    handleDailyStateChange("cash_total", event.target.value)
                  }
                />
              </label>
              <label>
                Безнал:
                <input
                  type="number"
                  min="0"
                  value={dailyStateForm.bank_total}
                  onChange={(event) =>
                    handleDailyStateChange("bank_total", event.target.value)
                  }
                />
              </label>
              <label>
                Кредитки/рассрочки:
                <input
                  type="number"
                  min="0"
                  value={dailyStateForm.debt_cards_total}
                  onChange={(event) =>
                    handleDailyStateChange(
                      "debt_cards_total",
                      event.target.value,
                    )
                  }
                />
              </label>
              <label>
                Долги людям:
                <input
                  type="number"
                  min="0"
                  value={dailyStateForm.debt_other_total}
                  onChange={(event) =>
                    handleDailyStateChange(
                      "debt_other_total",
                      event.target.value,
                    )
                  }
                />
              </label>
            </div>
            <p>Остаток: {assetsTotal} ₽</p>
            <p>Долги: {debtsTotal} ₽</p>
            <p>Баланс: {balanceTotal} ₽</p>
            <p>Итог за день (верхний): {topDayTotal} ₽</p>
            <button type="button" onClick={handleSaveDailyState}>
              Сохранить состояние дня
            </button>
          </section>

          <section>
            <h2>Операции за день</h2>
            <label>
              Дата:
              <input
                type="date"
                value={selectedDate}
                onChange={(event) => setSelectedDate(event.target.value)}
              />
            </label>
            {transactions.length ? (
              <ul>
                {transactions.map((tx) => {
                  const accountName =
                    (tx.account_id && accountMap.get(tx.account_id)?.name) ||
                    "Счет";
                  const toAccountName =
                    (tx.to_account_id &&
                      accountMap.get(tx.to_account_id)?.name) ||
                    "Счет";
                  const categoryName =
                    (tx.category_id &&
                      categories.find((cat) => cat.id === tx.category_id)
                        ?.name) ||
                    null;
                  return (
                    <li key={tx.id}>
                      <div>
                        <strong>{tx.type}</strong>: {tx.amount} ₽{" "}
                        {tx.type === "transfer" && (
                          <span>
                            {accountName} → {toAccountName}
                          </span>
                        )}
                        {tx.type !== "transfer" && <span>{accountName}</span>}
                        {tx.type === "expense" && (
                          <span>
                            {" "}
                            {categoryName ? `(${categoryName})` : "(Без категории)"}
                          </span>
                        )}
                        {tx.note && <span> — {tx.note}</span>}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDeleteTransaction(tx.id)}
                      >
                        Удалить
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p>Нет операций</p>
            )}
            <p>Итог за день (нижний): {dailyTotal} ₽</p>
          </section>

          <section>
            <h2>Сверка</h2>
            {isReconciled ? (
              <p>Сверка: OK</p>
            ) : (
              <>
                <p>Сверка: расхождение {dayDiffAbs} ₽</p>
                <p>
                  {dayDiff < 0
                    ? "Не учтены изменения остатков (наличка/безнал)"
                    : "Не учтены расходы/переводы в операциях"}
                </p>
                <div>
                  <button
                    type="button"
                    onClick={() => handleQuickAdjust("cash_total", -dayDiffAbs)}
                  >
                    Уменьшить наличку на {dayDiffAbs} ₽
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      handleQuickAdjust("bank_total", -dayDiffAbs)
                    }
                  >
                    Уменьшить безнал на {dayDiffAbs} ₽
                  </button>
                  <button
                    type="button"
                    onClick={() => handleQuickAdjust("cash_total", dayDiffAbs)}
                  >
                    Увеличить наличку на {dayDiffAbs} ₽
                  </button>
                  <button
                    type="button"
                    onClick={() => handleQuickAdjust("bank_total", dayDiffAbs)}
                  >
                    Увеличить безнал на {dayDiffAbs} ₽
                  </button>
                </div>
              </>
            )}
          </section>

          <section>
            <h2>Добавить доход</h2>
            <form onSubmit={handleCreateIncome}>
              <label>
                Счет:
                <select
                  value={incomeAccountId}
                  onChange={(event) => setIncomeAccountId(event.target.value)}
                  required
                >
                  <option value="">Выберите счет</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Сумма:
                <input
                  type="number"
                  min="1"
                  value={incomeAmount}
                  onChange={(event) => setIncomeAmount(event.target.value)}
                  required
                />
              </label>
              <label>
                Заметка:
                <input
                  type="text"
                  value={incomeNote}
                  onChange={(event) => setIncomeNote(event.target.value)}
                />
              </label>
              <button type="submit">Добавить</button>
            </form>
            {incomeErrorDetails && (
              <div>
                <p>
                  tx_http_status: {incomeErrorDetails.httpStatus ?? "unknown"}
                </p>
                <p>
                  tx_response_text:{" "}
                  {incomeErrorDetails.responseText ?? "unknown"}
                </p>
              </div>
            )}
          </section>

          <section>
            <h2>Добавить расход</h2>
            <form onSubmit={handleCreateExpense}>
              <label>
                Счет:
                <select
                  value={expenseAccountId}
                  onChange={(event) => setExpenseAccountId(event.target.value)}
                  required
                >
                  <option value="">Выберите счет</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Сумма:
                <input
                  type="number"
                  min="1"
                  value={expenseAmount}
                  onChange={(event) => setExpenseAmount(event.target.value)}
                  required
                />
              </label>
              <label>
                Категория:
                <select
                  value={expenseCategoryId}
                  onChange={(event) => setExpenseCategoryId(event.target.value)}
                >
                  <option value="">Без категории</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Тег:
                <select
                  value={expenseTag}
                  onChange={(event) =>
                    setExpenseTag(
                      event.target.value as "one_time" | "subscription",
                    )
                  }
                >
                  <option value="one_time">Разовый</option>
                  <option value="subscription">Подписка</option>
                </select>
              </label>
              <label>
                Заметка:
                <input
                  type="text"
                  value={expenseNote}
                  onChange={(event) => setExpenseNote(event.target.value)}
                />
              </label>
              <button type="submit">Добавить</button>
            </form>
            {expenseErrorDetails && (
              <div>
                <p>
                  tx_http_status: {expenseErrorDetails.httpStatus ?? "unknown"}
                </p>
                <p>
                  tx_response_text:{" "}
                  {expenseErrorDetails.responseText ?? "unknown"}
                </p>
              </div>
            )}
          </section>

          <section>
            <h2>Добавить перевод</h2>
            <form onSubmit={handleCreateTransfer}>
              <label>
                Откуда:
                <select
                  value={transferFromAccountId}
                  onChange={(event) =>
                    setTransferFromAccountId(event.target.value)
                  }
                  required
                >
                  <option value="">Выберите счет</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Куда:
                <select
                  value={transferToAccountId}
                  onChange={(event) =>
                    setTransferToAccountId(event.target.value)
                  }
                  required
                >
                  <option value="">Выберите счет</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Сумма:
                <input
                  type="number"
                  min="1"
                  value={transferAmount}
                  onChange={(event) => setTransferAmount(event.target.value)}
                  required
                />
              </label>
              <label>
                Заметка:
                <input
                  type="text"
                  value={transferNote}
                  onChange={(event) => setTransferNote(event.target.value)}
                />
              </label>
              <button type="submit">Добавить</button>
            </form>
            {transferErrorDetails && (
              <div>
                <p>
                  tx_http_status: {transferErrorDetails.httpStatus ?? "unknown"}
                </p>
                <p>
                  tx_response_text:{" "}
                  {transferErrorDetails.responseText ?? "unknown"}
                </p>
              </div>
            )}
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
            {accountErrorDetails && (
              <div>
                <p>
                  http_status: {accountErrorDetails.httpStatus ?? "unknown"}
                </p>
                <p>
                  response_text: {accountErrorDetails.responseText ?? "unknown"}
                </p>
              </div>
            )}
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
            {categoryErrorDetails && (
              <div>
                <p>
                  http_status: {categoryErrorDetails.httpStatus ?? "unknown"}
                </p>
                <p>
                  response_text: {categoryErrorDetails.responseText ?? "unknown"}
                </p>
              </div>
            )}
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
