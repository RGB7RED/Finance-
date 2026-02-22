"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";

import { Button } from "../src/components/ui/Button";
import { Card } from "../src/components/ui/Card";
import { Input } from "../src/components/ui/Input";
import { Pill } from "../src/components/ui/Pill";
import { Tabs } from "../src/components/ui/Tabs";
import {
  type Account,
  type ActiveDebt,
  type AuthError,
  type BalanceByAccountsReport,
  type Budget,
  type BalanceDay,
  type CashflowDay,
  type Category,
  type DailyState,
  type DailyStateAccount,
  type ExpensesByCategoryReport,
  type Goal,
  type MonthReport,
  type MonthReportDay,
  type ReconcileSummary,
  type ReportsSummary,
  type Rule,
  type Transaction,
  adjustAccountBalance,
  authTelegram,
  applyRules,
  createAccount,
  createCategory,
  createDebtOther,
  createGoal,
  createRule,
  deleteAccount,
  deleteCategory,
  createTransaction,
  deleteRule,
  deleteGoal,
  adjustGoal,
  deleteTransaction,
  ensureDefaultBudgets,
  getDailyState,
  getApiBaseUrl,
  getExpensesByCategoryReport,
  getMe,
  getMonthReport,
  getReconcile,
  getReportBalance,
  getReportBalanceByAccounts,
  getReportCashflow,
  getReportSummary,
  isUnauthorized,
  listAccounts,
  listActiveDebts,
  listBudgets,
  listCategories,
  listGoals,
  listRules,
  listTransactions,
  resetAll,
  updateAccount,
  updateCategory,
  updateGoal,
} from "../src/lib/api";
import { clearToken, getToken, setToken } from "../src/lib/auth";
import { formatRub } from "../src/lib/format";
import { getTelegramInitData } from "../src/lib/telegram";

type Status = "loading" | "unauthorized" | "ready" | "error";

const ACTIVE_BUDGET_STORAGE_KEY = "mf_active_budget_id";
const LAST_ACCOUNT_STORAGE_KEY = "mf_last_account_id";

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

type DebtMetadata = {
  debt_type?: "people" | "cards";
  direction: "borrowed" | "repaid";
  note?: string | null;
  creditor?: string | null;
};

const getDebtCreditor = (
  debtMetadata: DebtMetadata | null,
  fallbackNote: string | null,
): string => {
  const creditor = debtMetadata?.creditor ?? debtMetadata?.note ?? fallbackNote;
  return creditor?.trim() || "—";
};

type EditingTransaction = {
  id: string;
  kind: Transaction["kind"];
  type: Transaction["type"];
};

type DayModal =
  | null
  | "account-create"
  | "account-edit"
  | "category-create"
  | "category-edit"
  | "goal-create"
  | "debt-create"
  | "debt-edit";

const buildErrorMessage = (fallback: string, error: unknown): string => {
  if (isUnauthorized(error)) {
    return "Сессия истекла, войдите заново";
  }

  if (error instanceof Error && error.message === "API недоступен") {
    return "API недоступен";
  }

  return fallback;
};

const extractErrorDetail = (responseText?: string): string | null => {
  if (!responseText) {
    return null;
  }
  try {
    const parsed = JSON.parse(responseText) as { detail?: string } | string;
    if (typeof parsed === "string") {
      return parsed;
    }
    if (parsed && typeof parsed === "object" && parsed.detail) {
      return parsed.detail;
    }
  } catch (error) {
    return responseText;
  }
  return responseText;
};

const getDefaultReportRange = (): { from: string; to: string } => {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  return {
    from: monthStart.toISOString().slice(0, 10),
    to: monthEnd.toISOString().slice(0, 10),
  };
};

const getDefaultMonth = (): string =>
  new Date().toISOString().slice(0, 7);

const SHORT_RU_MONTHS = [
  "янв",
  "фев",
  "мар",
  "апр",
  "май",
  "июн",
  "июл",
  "авг",
  "сен",
  "окт",
  "ноя",
  "дек",
];

const formatShortRuDate = (value: string): string => {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) {
    return value;
  }
  const monthLabel = SHORT_RU_MONTHS[month - 1];
  if (!monthLabel) {
    return value;
  }
  return `${day} ${monthLabel} ${year}`;
};

const parseDebtMetadata = (note: string | null): DebtMetadata | null => {
  if (!note) {
    return null;
  }
  try {
    const parsed = JSON.parse(note) as DebtMetadata;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed.direction === "borrowed" || parsed.direction === "repaid")
    ) {
      return parsed;
    }
  } catch (error) {
    return null;
  }
  return null;
};

export default function HomePage() {
  const [status, setStatus] = useState<Status>("loading");
  const [viewMode, setViewMode] = useState<"day" | "month">("day");
  const [activeTab, setActiveTab] = useState<
    "day" | "ops" | "reports" | "settings"
  >("day");
  const [token, setTokenState] = useState<string | null>(null);
  const [message, setMessage] = useState<string>("");
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [activeBudgetId, setActiveBudgetId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [activeDebts, setActiveDebts] = useState<ActiveDebt[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [dailyState, setDailyState] = useState<DailyState | null>(null);
  const [reconcileSummary, setReconcileSummary] =
    useState<ReconcileSummary | null>(null);
  const [reconcileAccountId, setReconcileAccountId] = useState("");
  const [accountName, setAccountName] = useState("");
  const [accountKind, setAccountKind] = useState("cash");
  const [accountActiveFrom, setAccountActiveFrom] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [accountInitialAmount, setAccountInitialAmount] = useState("0");
  const [categoryName, setCategoryName] = useState("");
  const [categoryParent, setCategoryParent] = useState("");
  const [selectedDate, setSelectedDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [opsDate, setOpsDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [isOpsDateEdited, setIsOpsDateEdited] = useState(false);
  const [reportFrom, setReportFrom] = useState(
    () => getDefaultReportRange().from,
  );
  const [reportTo, setReportTo] = useState(
    () => getDefaultReportRange().to,
  );
  const [reportCashflow, setReportCashflow] = useState<CashflowDay[]>([]);
  const [reportBalance, setReportBalance] = useState<BalanceDay[]>([]);
  const [reportBalanceByAccounts, setReportBalanceByAccounts] =
    useState<BalanceByAccountsReport | null>(null);
  const [isReportBalanceByAccountsOpen, setIsReportBalanceByAccountsOpen] =
    useState(false);
  const [reportSummary, setReportSummary] = useState<ReportsSummary | null>(
    null,
  );
  const [reportExpensesByCategory, setReportExpensesByCategory] =
    useState<ExpensesByCategoryReport | null>(null);
  const [reportExpensesLimit, setReportExpensesLimit] = useState(10);
  const [expandedReportCategories, setExpandedReportCategories] = useState<
    Record<string, boolean>
  >({});
  const [selectedMonth, setSelectedMonth] = useState(() =>
    getDefaultMonth(),
  );
  const [monthReport, setMonthReport] = useState<MonthReport | null>(null);
  const [incomeAccountId, setIncomeAccountId] = useState("");
  const [incomeAmount, setIncomeAmount] = useState("");
  const [incomeCategoryId, setIncomeCategoryId] = useState("");
  const [incomeTag, setIncomeTag] = useState<"one_time" | "subscription">(
    "one_time",
  );
  const [incomeNote, setIncomeNote] = useState("");
  const [expenseAccountId, setExpenseAccountId] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseCategoryId, setExpenseCategoryId] = useState("");
  const [expenseTag, setExpenseTag] = useState<"one_time" | "subscription">(
    "one_time",
  );
  const [expenseNote, setExpenseNote] = useState("");
  const [rulePattern, setRulePattern] = useState("");
  const [ruleAccountId, setRuleAccountId] = useState("");
  const [ruleCategoryId, setRuleCategoryId] = useState("");
  const [ruleTag, setRuleTag] = useState<"one_time" | "subscription">(
    "one_time",
  );
  const [transferFromAccountId, setTransferFromAccountId] = useState("");
  const [transferToAccountId, setTransferToAccountId] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [transferNote, setTransferNote] = useState("");
  const [debtOtherAmount, setDebtOtherAmount] = useState("");
  const [debtOtherDirection, setDebtOtherDirection] = useState<
    "borrowed" | "repaid"
  >("borrowed");
  const [debtOtherAccountId, setDebtOtherAccountId] = useState("");
  const [debtOtherCreditor, setDebtOtherCreditor] = useState("");
  const [editingTransaction, setEditingTransaction] =
    useState<EditingTransaction | null>(null);
  const [editingDebtTransaction, setEditingDebtTransaction] =
    useState<Transaction | null>(null);
  const [dayModal, setDayModal] = useState<DayModal>(null);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [editingCategory, setEditingCategory] =
    useState<Category | null>(null);
  const [opsMode, setOpsMode] = useState<"create" | "edit">("create");
  const [goalAccountId, setGoalAccountId] = useState("");
  const [goalTitle, setGoalTitle] = useState("");
  const [goalTargetAmount, setGoalTargetAmount] = useState("");
  const [goalDeadline, setGoalDeadline] = useState("");
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
  const [debtOtherErrorDetails, setDebtOtherErrorDetails] =
    useState<FormErrorDetails | null>(null);
  const [reconcileErrorDetails, setReconcileErrorDetails] =
    useState<FormErrorDetails | null>(null);

  const setDailyStateFromData = (state: DailyState) => {
    setDailyState(state);
  };

  const loadDailyStateData = async (
    authToken: string,
    budgetId: string,
    dateValue: string,
  ) => {
    const [state, reconcile] = await Promise.all([
      getDailyState(authToken, budgetId, dateValue),
      getReconcile(authToken, budgetId, dateValue),
    ]);
    setDailyStateFromData(state);
    setReconcileSummary(reconcile);
  };

  const loadReports = useCallback(async () => {
    if (!token || !activeBudgetId) {
      return;
    }
    if (!reportFrom || !reportTo) {
      return;
    }
    if (reportFrom > reportTo) {
      setMessage("Некорректный период отчета");
      return;
    }
    try {
      const [cashflow, balance, summary, expensesByCategory] =
        await Promise.all([
        getReportCashflow(token, activeBudgetId, reportFrom, reportTo),
        getReportBalance(token, activeBudgetId, reportFrom, reportTo),
        getReportSummary(token, activeBudgetId),
        getExpensesByCategoryReport(
          token,
          activeBudgetId,
          reportFrom,
          reportTo,
          reportExpensesLimit,
        ),
      ]);
      setReportCashflow(cashflow);
      setReportBalance(balance);
      setReportSummary(summary);
      setReportExpensesByCategory(expensesByCategory);
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось загрузить отчеты", error));
    }
  }, [
    token,
    activeBudgetId,
    reportFrom,
    reportTo,
    reportExpensesLimit,
  ]);

  const loadMonthReport = async () => {
    if (!token || !activeBudgetId || !selectedMonth) {
      return;
    }
    try {
      const report = await getMonthReport(
        token,
        activeBudgetId,
        selectedMonth,
      );
      setMonthReport(report);
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось загрузить отчет за месяц", error));
    }
  };

  const loadRulesData = async (authToken: string, budgetId: string) => {
    const loadedRules = await listRules(authToken, budgetId);
    setRules(loadedRules);
  };

  useEffect(() => {
    if (!isOpsDateEdited) {
      setOpsDate(selectedDate);
    }
  }, [isOpsDateEdited, selectedDate]);

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
        const [
          loadedAccounts,
          loadedCategories,
          loadedTransactions,
          loadedActiveDebts,
          loadedGoals,
          loadedRules,
        ] = await Promise.all([
          listAccounts(resolvedToken, nextBudgetId),
          listCategories(resolvedToken, nextBudgetId),
          listTransactions(resolvedToken, nextBudgetId, selectedDate),
          listActiveDebts(resolvedToken, nextBudgetId, selectedDate),
          listGoals(resolvedToken, nextBudgetId),
          listRules(resolvedToken, nextBudgetId),
        ]);
        await loadDailyStateData(resolvedToken, nextBudgetId, selectedDate);
        setAccounts(loadedAccounts);
        setCategories(loadedCategories);
        setTransactions(loadedTransactions);
        setActiveDebts(loadedActiveDebts);
        setGoals(loadedGoals);
        setRules(loadedRules);
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
    setActiveDebts([]);
    setGoals([]);
    setRules([]);
    setDailyState(null);
    setReconcileSummary(null);
    setReportCashflow([]);
    setReportBalance([]);
    setReportSummary(null);
    setMonthReport(null);
    setSelectedMonth(getDefaultMonth());
    setAccountActiveFrom(new Date().toISOString().slice(0, 10));
    setAccountInitialAmount("0");
    setDebtOtherAmount("");
    setDebtOtherDirection("borrowed");
    setDebtOtherAccountId("");
    setDebtOtherCreditor("");
    setGoalTitle("");
    setGoalTargetAmount("");
    setGoalDeadline("");
    setIncomeTag("one_time");
    setExpenseTag("one_time");
    setRulePattern("");
    setRuleAccountId("");
    setRuleCategoryId("");
    setRuleTag("one_time");
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

  const rememberLastAccount = (accountId: string) => {
    if (!accountId) {
      return;
    }
    localStorage.setItem(LAST_ACCOUNT_STORAGE_KEY, accountId);
  };

  useEffect(() => {
    if (!accounts.length) {
      setReconcileAccountId("");
      return;
    }
    const saved = localStorage.getItem(LAST_ACCOUNT_STORAGE_KEY);
    const savedValid =
      saved && accounts.some((account) => account.id === saved);
    setReconcileAccountId((prev) => {
      if (prev && accounts.some((account) => account.id === prev)) {
        return prev;
      }
      if (savedValid) {
        return saved as string;
      }
      return accounts[0].id;
    });
  }, [accounts]);

  useEffect(() => {
    if (!accounts.length) {
      setDebtOtherAccountId("");
      return;
    }
    if (!debtOtherAccountId) {
      setDebtOtherAccountId(accounts[0].id);
      return;
    }
    const exists = accounts.some((account) => account.id === debtOtherAccountId);
    if (!exists) {
      setDebtOtherAccountId(accounts[0].id);
    }
  }, [accounts, debtOtherAccountId]);

  useEffect(() => {
    if (!activeBudgetId || !accounts.length) {
      setGoalAccountId("");
      return;
    }
    const storageKey = `mf_goals_account_id_${activeBudgetId}`;
    const saved = localStorage.getItem(storageKey);
    const hasSaved =
      saved && accounts.some((account) => account.id === saved);
    setGoalAccountId((prev) => {
      if (prev && accounts.some((account) => account.id === prev)) {
        return prev;
      }
      return hasSaved ? (saved as string) : accounts[0].id;
    });
  }, [accounts, activeBudgetId]);

  useEffect(() => {
    if (!activeBudgetId || !goalAccountId) {
      return;
    }
    const storageKey = `mf_goals_account_id_${activeBudgetId}`;
    localStorage.setItem(storageKey, goalAccountId);
  }, [activeBudgetId, goalAccountId]);

  const refreshData = useCallback(async () => {
    if (!token || !activeBudgetId) {
      return;
    }
    const [loadedAccounts, loadedCategories, loadedTransactions, loadedActiveDebts, loadedGoals] =
      await Promise.all([
        listAccounts(token, activeBudgetId),
        listCategories(token, activeBudgetId),
        listTransactions(token, activeBudgetId, selectedDate),
        listActiveDebts(token, activeBudgetId, selectedDate),
        listGoals(token, activeBudgetId),
      ]);
    await loadDailyStateData(token, activeBudgetId, selectedDate);
    setAccounts(loadedAccounts);
    setCategories(loadedCategories);
    setTransactions(loadedTransactions);
    setActiveDebts(loadedActiveDebts);
    setGoals(loadedGoals);
  }, [token, activeBudgetId, selectedDate]);

  const getTagLabel = (tag: "one_time" | "subscription" | null | undefined) =>
    tag === "subscription" ? "Подписка" : tag === "one_time" ? "Разовый" : "";

  const getAccountLabel = (accountId: string | null | undefined) =>
    accountId ? accountMap.get(accountId)?.name ?? "Счет" : "—";

  const getCategoryLabel = (categoryId: string | null | undefined) =>
    categoryId
      ? categories.find((category) => category.id === categoryId)?.name ??
        "Категория"
      : "—";

  const dailyTotal = useMemo(() => {
    return transactions.reduce((total, tx) => {
      if (tx.kind !== "normal") {
        return total;
      }
      if (tx.type === "income") {
        return total + tx.amount;
      }
      if (tx.type === "expense") {
        return total - tx.amount;
      }
      return total;
    }, 0);
  }, [transactions]);

  const assetsTotal = dailyState?.totals.assets_total ?? 0;
  const debtsTotal = dailyState?.totals.debts_total ?? 0;
  const balanceTotal = dailyState?.totals.balance_total ?? 0;

  const normalizeGoalRemaining = (goal: Goal) =>
    Math.max(0, goal.target_amount - goal.current_amount);

  const normalizeReportGoalRemaining = (
    goal: ReportsSummary["goals_active"][number],
  ) => Math.max(0, goal.target - goal.current);

  const getGoalStrategy = (goal: Goal) => {
    if (!goal.deadline || goal.status !== "active") {
      return null;
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const deadlineDate = new Date(goal.deadline);
    const diffMs = deadlineDate.getTime() - today.getTime();
    const daysLeft = Math.max(1, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
    const remaining = normalizeGoalRemaining(goal);
    const perDayRaw = remaining / daysLeft;
    const perDay =
      remaining > 0 ? Math.max(1, Math.round(perDayRaw)) : Math.round(perDayRaw);
    const perWeek = Math.round((remaining * 7) / daysLeft);
    return { daysLeft, remaining, perDay, perWeek };
  };

  const topDayTotal = reconcileSummary?.top_total ?? 0;
  const bottomDayTotal = reconcileSummary?.bottom_total ?? dailyTotal;
  const reconcileDiff = reconcileSummary?.diff ?? 0;
  const reconcileDiffAbs = Math.abs(reconcileDiff);

  const handleOpsDateChange = (value: string) => {
    setOpsDate(value);
    setIsOpsDateEdited(true);
  };
  const reconcileDelta = bottomDayTotal - topDayTotal;
  const reconcileDeltaAbs = Math.abs(reconcileDelta);
  const reconcileEligibleAccountIds = useMemo(() => {
    if (reconcileDelta >= 0) {
      return new Set(accounts.map((account) => account.id));
    }
    const eligible = new Set<string>();
    dailyState?.accounts.forEach((account) => {
      if (account.amount >= reconcileDeltaAbs) {
        eligible.add(account.account_id);
      }
    });
    return eligible;
  }, [accounts, dailyState, reconcileDelta, reconcileDeltaAbs]);
  const reconcileHasEligibleAccounts =
    reconcileDelta >= 0
      ? accounts.length > 0
      : reconcileEligibleAccountIds.size > 0;
  const reconcileCanAdjust = Boolean(
    reconcileAccountId &&
      (reconcileDelta >= 0 ||
        reconcileEligibleAccountIds.has(reconcileAccountId)),
  );
  const reconcileHint =
    reconcileDelta < 0 &&
    reconcileAccountId &&
    !reconcileEligibleAccountIds.has(reconcileAccountId)
      ? "На этом счёте недостаточно средств для корректировки"
      : reconcileDelta < 0 && !reconcileHasEligibleAccounts
        ? "На выбранную дату нет счёта с достаточным остатком"
        : null;
  const reconcileErrorDetail = reconcileErrorDetails
    ? extractErrorDetail(reconcileErrorDetails.responseText)
    : null;
  const renderMonthReconcileStatus = (diff: number) => {
    if (Math.abs(diff) <= 1) {
      return <Pill variant="ok" text="OK" />;
    }
    if (diff > 0) {
      return <Pill variant="warn" text={`+${diff} ₽`} />;
    }
    return <Pill variant="err" text={`${diff} ₽`} />;
  };

  const monthIncomeTotal = monthReport?.month_income ?? 0;
  const monthExpenseTotal = monthReport?.month_expense ?? 0;
  const monthNetTotal = monthReport?.month_net ?? 0;
  const monthAvgNet = monthReport?.avg_net_per_day ?? 0;
  const hasAccounts = accounts.length > 0;
  useEffect(() => {
    if (reconcileDiff === 0) {
      return;
    }
    if (reconcileDelta >= 0) {
      return;
    }
    if (reconcileEligibleAccountIds.size === 0) {
      if (reconcileAccountId) {
        setReconcileAccountId("");
      }
      return;
    }
    if (
      !reconcileAccountId ||
      !reconcileEligibleAccountIds.has(reconcileAccountId)
    ) {
      const firstEligible = accounts.find((account) =>
        reconcileEligibleAccountIds.has(account.id),
      );
      if (firstEligible && firstEligible.id !== reconcileAccountId) {
        setReconcileAccountId(firstEligible.id);
      }
    }
  }, [
    accounts,
    reconcileAccountId,
    reconcileDelta,
    reconcileDiff,
    reconcileEligibleAccountIds,
  ]);

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
      const [
        loadedAccounts,
        loadedCategories,
        loadedTransactions,
        loadedActiveDebts,
        loadedGoals,
        loadedRules,
      ] = await Promise.all([
        listAccounts(token, nextBudgetId),
        listCategories(token, nextBudgetId),
        listTransactions(token, nextBudgetId, selectedDate),
        listActiveDebts(token, nextBudgetId, selectedDate),
        listGoals(token, nextBudgetId),
        listRules(token, nextBudgetId),
      ]);
      await loadDailyStateData(token, nextBudgetId, selectedDate);
      setAccounts(loadedAccounts);
      setCategories(loadedCategories);
      setTransactions(loadedTransactions);
      setActiveDebts(loadedActiveDebts);
      setGoals(loadedGoals);
      setRules(loadedRules);
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
        const [loadedAccounts, loadedTransactions, loadedActiveDebts] = await Promise.all([
          listAccounts(token, activeBudgetId),
          listTransactions(token, activeBudgetId, selectedDate),
          listActiveDebts(token, activeBudgetId, selectedDate),
        ]);
        await loadDailyStateData(token, activeBudgetId, selectedDate);
        setAccounts(loadedAccounts);
        setTransactions(loadedTransactions);
        setActiveDebts(loadedActiveDebts);
      } catch (error) {
        setMessage(buildErrorMessage("Не удалось загрузить операции", error));
      }
    };

    void loadTransactionsForDate();
  }, [token, activeBudgetId, selectedDate]);

  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  useEffect(() => {
    setIsReportBalanceByAccountsOpen(false);
  }, [selectedDate]);

  const handleReportExpensesLimitChange = (
    event: ChangeEvent<HTMLSelectElement>,
  ) => {
    setReportExpensesLimit(Number(event.target.value));
    setExpandedReportCategories({});
  };

  const toggleReportCategory = (categoryId: string) => {
    setExpandedReportCategories((previous) => ({
      ...previous,
      [categoryId]: !previous[categoryId],
    }));
  };

  const handleToggleReportBalanceByAccounts = async () => {
    if (isReportBalanceByAccountsOpen) {
      setIsReportBalanceByAccountsOpen(false);
      return;
    }
    if (!token || !activeBudgetId) {
      return;
    }
    if (reportBalanceByAccounts?.date === selectedDate) {
      setIsReportBalanceByAccountsOpen(true);
      return;
    }
    setMessage("");
    try {
      const report = await getReportBalanceByAccounts(
        token,
        activeBudgetId,
        selectedDate,
      );
      setReportBalanceByAccounts(report);
      setIsReportBalanceByAccountsOpen(true);
    } catch (error) {
      setMessage(
        buildErrorMessage("Не удалось загрузить остатки по счетам", error),
      );
    }
  };

  useEffect(() => {
    void loadMonthReport();
  }, [token, activeBudgetId, selectedMonth]);

  useEffect(() => {
    if (!token || !activeBudgetId) {
      return;
    }
    const trimmedNote = incomeNote.trim();
    if (!trimmedNote) {
      return;
    }
    let isCancelled = false;
    const timeoutId = window.setTimeout(async () => {
      try {
        const response = await applyRules(token, {
          budget_id: activeBudgetId,
          text: trimmedNote,
        });
        if (!isCancelled) {
          if (response.account_id) {
            setIncomeAccountId(response.account_id);
          }
          if (response.tag) {
            setIncomeTag(response.tag);
          }
        }
      } catch (error) {
        return;
      }
    }, 400);
    return () => {
      isCancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [token, activeBudgetId, incomeNote]);

  useEffect(() => {
    if (!token || !activeBudgetId) {
      return;
    }
    const trimmedNote = expenseNote.trim();
    if (!trimmedNote) {
      return;
    }
    let isCancelled = false;
    const timeoutId = window.setTimeout(async () => {
      try {
        const response = await applyRules(token, {
          budget_id: activeBudgetId,
          text: trimmedNote,
        });
        if (!isCancelled) {
          if (response.account_id) {
            setExpenseAccountId(response.account_id);
          }
          if (response.category_id) {
            setExpenseCategoryId(response.category_id);
          }
          if (response.tag) {
            setExpenseTag(response.tag);
          }
        }
      } catch (error) {
        return;
      }
    }, 400);
    return () => {
      isCancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [token, activeBudgetId, expenseNote]);

  const handleCreateAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !activeBudgetId) {
      return;
    }
    const initialAmount = Number.parseInt(accountInitialAmount, 10);
    if (!accountActiveFrom) {
      setMessage("Укажите дату активации");
      return;
    }
    if (!Number.isFinite(initialAmount) || initialAmount < 0) {
      setMessage("Начальный остаток не может быть отрицательным");
      return;
    }
    setMessage("");
    setAccountErrorDetails(null);
    try {
      await createAccount(token, {
        budget_id: activeBudgetId,
        name: accountName,
        kind: accountKind,
        active_from: accountActiveFrom,
        initial_amount: initialAmount,
      });
      setAccountName("");
      setAccountInitialAmount("0");
      const updatedAccounts = await listAccounts(token, activeBudgetId);
      setAccounts(updatedAccounts);
      await loadDailyStateData(token, activeBudgetId, selectedDate);
    } catch (error) {
      const apiError = error as Error & { status?: number; text?: string };
      setAccountErrorDetails({
        httpStatus: apiError.status,
        responseText: apiError.text,
      });
      setMessage(buildErrorMessage("Не удалось добавить счет", error));
    }
  };

  const handleCreateAccountFromDay = () => {
    setEditingAccount(null);
    setAccountName("");
    setAccountKind("cash");
    setAccountActiveFrom(selectedDate);
    setAccountInitialAmount("0");
    setDayModal("account-create");
  };

  const handleEditAccountFromDay = (account: Account) => {
    setEditingAccount(account);
    setAccountName(account.name);
    setAccountKind(account.kind);
    setDayModal("account-edit");
  };

  const handleDeleteAccountFromDay = async (accountId: string) => {
    if (!token) {
      return;
    }
    setMessage("");
    try {
      await deleteAccount(token, accountId);
      await refreshData();
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось удалить счет", error));
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

  const handleEditAccountSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !editingAccount) {
      return;
    }
    setMessage("");
    try {
      await updateAccount(token, editingAccount.id, {
        name: accountName,
        kind: accountKind,
      });
      setDayModal(null);
      setEditingAccount(null);
      setAccountName("");
      await refreshData();
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось обновить счет", error));
    }
  };

  const handleCreateCategoryFromDay = () => {
    setEditingCategory(null);
    setDayModal("category-create");
  };

  const handleCreateGoalFromDay = () => {
    setGoalTitle("");
    setGoalTargetAmount("");
    setGoalDeadline(selectedDate);
    setDayModal("goal-create");
  };

  const handleCreateDebtFromDay = () => {
    setEditingDebtTransaction(null);
    setDebtOtherAmount("");
    setDebtOtherCreditor("");
    setDebtOtherDirection("borrowed");
    setOpsDate(selectedDate);
    setDayModal("debt-create");
  };

  const handleEditCategoryFromDay = (category: Category) => {
    setEditingCategory(category);
    setCategoryName(category.name);
    setCategoryParent(category.parent_id ?? "");
    setDayModal("category-edit");
  };

  const handleDeleteCategoryFromDay = async (categoryId: string) => {
    if (!token) {
      return;
    }
    setMessage("");
    try {
      await deleteCategory(token, categoryId);
      await refreshData();
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось удалить категорию", error));
    }
  };

  const handleEditCategorySave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !editingCategory) {
      return;
    }
    setMessage("");
    try {
      await updateCategory(token, editingCategory.id, {
        name: categoryName,
        parent_id: categoryParent || null,
      });
      setDayModal(null);
      setEditingCategory(null);
      setCategoryName("");
      setCategoryParent("");
      await refreshData();
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось обновить категорию", error));
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    if (!token || !activeBudgetId) {
      return;
    }
    setMessage("");
    try {
      await deleteRule(token, { id: ruleId, budget_id: activeBudgetId });
      await loadRulesData(token, activeBudgetId);
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось удалить правило", error));
    }
  };

  const handleCreateRule = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !activeBudgetId) {
      return;
    }
    if (!rulePattern.trim()) {
      setMessage("Укажите шаблон правила");
      return;
    }
    setMessage("");
    try {
      await createRule(token, {
        budget_id: activeBudgetId,
        pattern: rulePattern,
        account_id: ruleAccountId ? ruleAccountId : null,
        category_id: ruleCategoryId ? ruleCategoryId : null,
        tag: ruleTag,
      });
      setRulePattern("");
      setRuleAccountId("");
      setRuleCategoryId("");
      await loadRulesData(token, activeBudgetId);
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось добавить правило", error));
    }
  };

  const clearEditingTransaction = useCallback(() => {
    setEditingTransaction(null);
  }, []);

  const clearEditingDebtTransaction = useCallback(() => {
    setEditingDebtTransaction(null);
  }, []);

  const handleEditTransaction = useCallback(
    (tx: Transaction) => {
      setOpsMode("edit");
      setOpsDate(tx.date);
      setSelectedDate(tx.date);
      setEditingTransaction({ id: tx.id, kind: tx.kind, type: tx.type });
      if (tx.kind === "debt") {
        const debtMetadata = parseDebtMetadata(tx.note);
        setDebtOtherAmount(String(tx.amount));
        setDebtOtherDirection(
          debtMetadata?.direction ??
            (tx.type === "income" ? "borrowed" : "repaid"),
        );
                setDebtOtherAccountId(tx.account_id ?? "");
        setDebtOtherCreditor(getDebtCreditor(debtMetadata, tx.note));
        return;
      }
      if (tx.type === "income") {
        setIncomeAccountId(tx.account_id ?? "");
        setIncomeAmount(String(tx.amount));
        setIncomeCategoryId(tx.category_id ?? "");
        setIncomeTag(tx.tag);
        setIncomeNote(tx.note ?? "");
        return;
      }
      if (tx.type === "expense") {
        setExpenseAccountId(tx.account_id ?? "");
        setExpenseAmount(String(tx.amount));
        setExpenseCategoryId(tx.category_id ?? "");
        setExpenseTag(tx.tag);
        setExpenseNote(tx.note ?? "");
        return;
      }
      setTransferFromAccountId(tx.account_id ?? "");
      setTransferToAccountId(tx.to_account_id ?? "");
      setTransferAmount(String(tx.amount));
      setTransferNote(tx.note ?? "");
    },
    [
      setDebtOtherAccountId,
      setDebtOtherAmount,
      setDebtOtherDirection,
      setDebtOtherCreditor,
      setEditingTransaction,
      setExpenseAccountId,
      setExpenseAmount,
      setExpenseCategoryId,
      setExpenseNote,
      setExpenseTag,
      setIncomeAccountId,
      setIncomeAmount,
      setIncomeCategoryId,
      setIncomeNote,
      setIncomeTag,
      setOpsDate,
      setSelectedDate,
      setTransferAmount,
      setTransferFromAccountId,
      setTransferNote,
      setTransferToAccountId,
    ],
  );

  const handleEditDebtFromDay = useCallback(
    (tx: Transaction) => {
      if (tx.kind !== "debt") {
        return;
      }
      const debtMetadata = parseDebtMetadata(tx.note);
      setEditingDebtTransaction(tx);
      setDebtOtherAmount(String(tx.amount));
      setDebtOtherDirection(
        debtMetadata?.direction ?? (tx.type === "income" ? "borrowed" : "repaid"),
      );
      setDebtOtherAccountId(tx.account_id ?? "");
      setDebtOtherCreditor(getDebtCreditor(debtMetadata, tx.note));
      setOpsDate(tx.date);
      setDayModal("debt-edit");
    },
    [],
  );

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
    if (!incomeCategoryId) {
      setMessage("Выберите категорию дохода");
      return;
    }
    setMessage("");
    setIncomeErrorDetails(null);
    const transactionDate = opsDate || selectedDate;
    try {
      if (
        editingTransaction &&
        editingTransaction.type === "income" &&
        editingTransaction.kind !== "debt"
      ) {
        await deleteTransaction(token, editingTransaction.id);
      } else if (editingTransaction) {
        clearEditingTransaction();
      }
      await createTransaction(token, {
        budget_id: activeBudgetId,
        type: "income",
        amount,
        date: transactionDate,
        account_id: incomeAccountId,
        category_id: incomeCategoryId,
        tag: incomeTag,
        note: incomeNote ? incomeNote : null,
      });
      rememberLastAccount(incomeAccountId);
      setIncomeAmount("");
      setIncomeCategoryId("");
      setIncomeNote("");
      clearEditingTransaction();
      const [updatedTransactions, updatedActiveDebts] = await Promise.all([
        listTransactions(
          token,
          activeBudgetId,
          selectedDate,
        ),
        listActiveDebts(token, activeBudgetId, selectedDate),
      ]);
      setTransactions(updatedTransactions);
      setActiveDebts(updatedActiveDebts);
      await loadDailyStateData(token, activeBudgetId, selectedDate);
      await loadReports();
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
    const transactionDate = opsDate || selectedDate;
    try {
      if (
        editingTransaction &&
        editingTransaction.type === "expense" &&
        editingTransaction.kind !== "debt"
      ) {
        await deleteTransaction(token, editingTransaction.id);
      } else if (editingTransaction) {
        clearEditingTransaction();
      }
      await createTransaction(token, {
        budget_id: activeBudgetId,
        type: "expense",
        amount,
        date: transactionDate,
        account_id: expenseAccountId,
        category_id: categoryId,
        tag: expenseTag,
        note: expenseNote ? expenseNote : null,
      });
      rememberLastAccount(expenseAccountId);
      setExpenseAmount("");
      setExpenseNote("");
      clearEditingTransaction();
      const [updatedTransactions, updatedActiveDebts] = await Promise.all([
        listTransactions(
          token,
          activeBudgetId,
          selectedDate,
        ),
        listActiveDebts(token, activeBudgetId, selectedDate),
      ]);
      setTransactions(updatedTransactions);
      setActiveDebts(updatedActiveDebts);
      await loadDailyStateData(token, activeBudgetId, selectedDate);
      await loadReports();
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
    const transactionDate = opsDate || selectedDate;
    try {
      if (
        editingTransaction &&
        editingTransaction.type === "transfer" &&
        editingTransaction.kind !== "debt"
      ) {
        await deleteTransaction(token, editingTransaction.id);
      } else if (editingTransaction) {
        clearEditingTransaction();
      }
      await createTransaction(token, {
        budget_id: activeBudgetId,
        type: "transfer",
        amount,
        date: transactionDate,
        account_id: transferFromAccountId,
        to_account_id: transferToAccountId,
        tag: "one_time",
        note: transferNote ? transferNote : null,
      });
      rememberLastAccount(transferFromAccountId);
      setTransferAmount("");
      setTransferNote("");
      clearEditingTransaction();
      const [updatedTransactions, updatedActiveDebts] = await Promise.all([
        listTransactions(
          token,
          activeBudgetId,
          selectedDate,
        ),
        listActiveDebts(token, activeBudgetId, selectedDate),
      ]);
      setTransactions(updatedTransactions);
      setActiveDebts(updatedActiveDebts);
      await loadDailyStateData(token, activeBudgetId, selectedDate);
      await loadReports();
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
      if (editingTransaction?.id === txId) {
        clearEditingTransaction();
      }
      const [updatedTransactions, updatedActiveDebts] = await Promise.all([
        listTransactions(
          token,
          activeBudgetId,
          selectedDate,
        ),
        listActiveDebts(token, activeBudgetId, selectedDate),
      ]);
      setTransactions(updatedTransactions);
      setActiveDebts(updatedActiveDebts);
      await loadDailyStateData(token, activeBudgetId, selectedDate);
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось удалить операцию", error));
    }
  };

  const handleReconcileAdjust = async () => {
    if (!token || !activeBudgetId) {
      return;
    }
    if (!reconcileAccountId) {
      setMessage("Выберите счет для корректировки");
      return;
    }
    const delta = bottomDayTotal - topDayTotal;
    if (delta === 0) {
      return;
    }
    if (delta < 0 && !reconcileEligibleAccountIds.has(reconcileAccountId)) {
      setMessage("На этом счёте недостаточно средств для корректировки");
      return;
    }
    setMessage("");
    setReconcileErrorDetails(null);
    try {
      await adjustAccountBalance(token, reconcileAccountId, {
        budget_id: activeBudgetId,
        date: selectedDate,
        delta,
        reason: "reconcile_adjust",
      });
      rememberLastAccount(reconcileAccountId);
      await loadDailyStateData(token, activeBudgetId, selectedDate);
    } catch (error) {
      const apiError = error as Error & { status?: number; text?: string };
      setReconcileErrorDetails({
        httpStatus: apiError.status,
        responseText: apiError.text,
      });
      setMessage(buildErrorMessage("Не удалось исправить сверку", error));
    }
  };

  const handleCreateDebtOther = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !activeBudgetId) {
      return;
    }
    if (!debtOtherAccountId) {
      setMessage("Выберите счет для операции");
      return;
    }
    const amount = Number.parseInt(debtOtherAmount, 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      setMessage("Сумма должна быть больше нуля");
      return;
    }
    setMessage("");
    setDebtOtherErrorDetails(null);
    const transactionDate = opsDate || selectedDate;
    const trimmedDebtNote = debtOtherCreditor.trim();
    try {
      if (editingDebtTransaction) {
        await deleteTransaction(token, editingDebtTransaction.id);
      } else if (
        editingTransaction &&
        editingTransaction.kind === "debt" &&
        (editingTransaction.type === "income" ||
          editingTransaction.type === "expense")
      ) {
        await deleteTransaction(token, editingTransaction.id);
      } else if (editingTransaction) {
        clearEditingTransaction();
      }
      await createDebtOther(token, {
        budget_id: activeBudgetId,
        amount,
        direction: debtOtherDirection,
        debt_type: "people",
        account_id: debtOtherAccountId,
        note: trimmedDebtNote ? trimmedDebtNote : null,
        date: transactionDate,
      });
      setDebtOtherAmount("");
      setDebtOtherCreditor("");
      clearEditingTransaction();
      clearEditingDebtTransaction();
      if (dayModal === "debt-create" || dayModal === "debt-edit") {
        setDayModal(null);
      }
      const [updatedAccounts] = await Promise.all([
        listAccounts(token, activeBudgetId),
        loadDailyStateData(token, activeBudgetId, selectedDate),
      ]);
      setAccounts(updatedAccounts);
      const [updatedTransactions, updatedActiveDebts] = await Promise.all([
        listTransactions(
          token,
          activeBudgetId,
          selectedDate,
        ),
        listActiveDebts(token, activeBudgetId, selectedDate),
      ]);
      setTransactions(updatedTransactions);
      setActiveDebts(updatedActiveDebts);
      if (reportFrom && reportTo && reportFrom <= reportTo) {
        const [balance, summary] = await Promise.all([
          getReportBalance(token, activeBudgetId, reportFrom, reportTo),
          getReportSummary(token, activeBudgetId),
        ]);
        setReportBalance(balance);
        setReportSummary(summary);
      }
    } catch (error) {
      const apiError = error as Error & { status?: number; text?: string };
      setDebtOtherErrorDetails({
        httpStatus: apiError.status,
        responseText: apiError.text,
      });
      setMessage(buildErrorMessage("Не удалось добавить долг", error));
    }
  };

  const handleCreateGoal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !activeBudgetId) {
      return;
    }
    const amount = Number.parseInt(goalTargetAmount, 10);
    if (!goalTitle.trim()) {
      setMessage("Укажите цель");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setMessage("Сумма цели должна быть больше нуля");
      return;
    }
    if (!goalDeadline) {
      setMessage("Укажите дату цели");
      return;
    }
    setMessage("");
    try {
      await createGoal(token, {
        budget_id: activeBudgetId,
        title: goalTitle.trim(),
        target_amount: amount,
        deadline: goalDeadline ? goalDeadline : null,
      });
      setGoalTitle("");
      setGoalTargetAmount("");
      setGoalDeadline("");
      const updatedGoals = await listGoals(token, activeBudgetId);
      setGoals(updatedGoals);
      if (dayModal === "goal-create") {
        setDayModal(null);
      }
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось создать цель", error));
    }
  };

  const handleGoalAdjust = async (goalId: string, delta: number) => {
    if (!token || !activeBudgetId) {
      return;
    }
    if (!goalAccountId) {
      setMessage("Выберите счет для цели");
      return;
    }
    setMessage("");
    try {
      const result = await adjustGoal(token, goalId, {
        budget_id: activeBudgetId,
        account_id: goalAccountId,
        delta,
        date: selectedDate,
      });
      if (result.status === "noop") {
        const updatedGoals = await listGoals(token, activeBudgetId);
        setGoals(updatedGoals);
        setMessage("Цель уже достигнута");
        return;
      }
      rememberLastAccount(goalAccountId);
      const [updatedGoals, updatedTransactions] = await Promise.all([
        listGoals(token, activeBudgetId),
        listTransactions(token, activeBudgetId, selectedDate),
      ]);
      setGoals(updatedGoals);
      setTransactions(updatedTransactions);
      await loadDailyStateData(token, activeBudgetId, selectedDate);
    } catch (error) {
      const apiError = error as Error & { text?: string };
      const detail = extractErrorDetail(apiError.text);
      setMessage(
        detail ?? buildErrorMessage("Не удалось обновить цель", error),
      );
    }
  };

  const handleGoalClose = async (goalId: string) => {
    if (!token || !activeBudgetId) {
      return;
    }
    setMessage("");
    try {
      await updateGoal(token, goalId, { status: "done" });
      const updatedGoals = await listGoals(token, activeBudgetId);
      setGoals(updatedGoals);
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось закрыть цель", error));
    }
  };

  const handleGoalArchive = async (goalId: string) => {
    if (!token || !activeBudgetId) {
      return;
    }
    setMessage("");
    try {
      await updateGoal(token, goalId, { status: "archived" });
      const updatedGoals = await listGoals(token, activeBudgetId);
      setGoals(updatedGoals);
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось архивировать цель", error));
    }
  };

  const handleDeleteGoal = async (goalId: string) => {
    if (!token || !activeBudgetId) {
      return;
    }
    setMessage("");
    try {
      await deleteGoal(token, goalId);
      const updatedGoals = await listGoals(token, activeBudgetId);
      setGoals(updatedGoals);
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось удалить цель", error));
    }
  };

  const handleResetAll = async () => {
    if (!token || !activeBudgetId) {
      return;
    }
    const confirmed = window.confirm(
      "Обнулить все данные? Операции, долги, цели, счета и категории будут удалены.",
    );
    if (!confirmed) {
      return;
    }
    setMessage("");
    try {
      await resetAll(token);
      setAccounts([]);
      setCategories([]);
      setTransactions([]);
      setGoals([]);
      setRules([]);
      setDayModal(null);
      await refreshData();
      await loadRulesData(token, activeBudgetId);
      await loadReports();
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось выполнить общий сброс", error));
    }
  };


  return (
    <main>
      <div className="mf-container">
        <div
          className={`mf-money-strip ${
            balanceTotal > 0
              ? "mf-money-strip--pos"
              : balanceTotal < 0
                ? "mf-money-strip--neg"
                : "mf-money-strip--warn"
          }`}
          aria-hidden="true"
        />

        {status === "loading" && <p className="mf-status-line">Загрузка...</p>}
        {status === "unauthorized" && (
          <div className="mf-stack mf-status-line">
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
          </div>
        )}
        {status === "error" && (
          <div className="mf-stack mf-status-line">
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
          </div>
        )}
        {status === "ready" && message && <p className="mf-status-line">{message}</p>}

        {status === "ready" && (
          <>
            {activeTab === "day" && (
              <DayTab
                selectedDate={selectedDate}
                onSelectedDateChange={setSelectedDate}
                balanceTotal={balanceTotal}
                assetsTotal={assetsTotal}
                debtsTotal={debtsTotal}
                bottomDayTotal={bottomDayTotal}
                topDayTotal={topDayTotal}
                hasAccounts={hasAccounts}
                reconcileDiffAbs={reconcileDiffAbs}
                reconcileDiff={reconcileDiff}
                reconcileDelta={reconcileDelta}
                reconcileAccountId={reconcileAccountId}
                reconcileCanAdjust={reconcileCanAdjust}
                reconcileEligibleAccountIds={reconcileEligibleAccountIds}
                reconcileHint={reconcileHint}
                reconcileErrorDetails={reconcileErrorDetails}
                reconcileErrorDetail={reconcileErrorDetail}
                onReconcileAccountChange={setReconcileAccountId}
                onReconcileAdjust={handleReconcileAdjust}
                accounts={accounts}
                transactions={transactions}
                activeDebts={activeDebts}
                goals={goals}
                categories={categories}
                dailyStateAccounts={dailyState?.accounts ?? []}
                accountMap={accountMap}
                onDeleteTransaction={handleDeleteTransaction}
                onEditTransaction={handleEditTransaction}
                onEditDebtTransaction={handleEditDebtFromDay}
                dayModal={dayModal}
                onCloseModal={() => { setDayModal(null); clearEditingDebtTransaction(); }}
                onCreateAccountClick={handleCreateAccountFromDay}
                onEditAccount={handleEditAccountFromDay}
                onDeleteAccount={handleDeleteAccountFromDay}
                onCreateCategoryClick={handleCreateCategoryFromDay}
                onCreateGoalClick={handleCreateGoalFromDay}
                onCreateDebtClick={handleCreateDebtFromDay}
                onEditCategory={handleEditCategoryFromDay}
                onDeleteCategory={handleDeleteCategoryFromDay}
                accountName={accountName}
                onAccountNameChange={setAccountName}
                accountKind={accountKind}
                onAccountKindChange={setAccountKind}
                accountActiveFrom={accountActiveFrom}
                onAccountActiveFromChange={setAccountActiveFrom}
                accountInitialAmount={accountInitialAmount}
                onAccountInitialAmountChange={setAccountInitialAmount}
                onCreateAccount={handleCreateAccount}
                onSaveAccount={handleEditAccountSave}
                categoryName={categoryName}
                onCategoryNameChange={setCategoryName}
                categoryParent={categoryParent}
                onCategoryParentChange={setCategoryParent}
                onCreateCategory={handleCreateCategory}
                onSaveCategory={handleEditCategorySave}
                goalTitle={goalTitle}
                onGoalTitleChange={setGoalTitle}
                goalTargetAmount={goalTargetAmount}
                onGoalTargetAmountChange={setGoalTargetAmount}
                goalDeadline={goalDeadline}
                onGoalDeadlineChange={setGoalDeadline}
                onCreateGoal={handleCreateGoal}
                debtOtherAmount={debtOtherAmount}
                onDebtOtherAmountChange={setDebtOtherAmount}
                debtOtherDirection={debtOtherDirection}
                onDebtOtherDirectionChange={setDebtOtherDirection}
                debtOtherAccountId={debtOtherAccountId}
                onDebtOtherAccountChange={setDebtOtherAccountId}
                debtOtherCreditor={debtOtherCreditor}
                onDebtOtherCreditorChange={setDebtOtherCreditor}
                onCreateDebtOther={handleCreateDebtOther}
              />
            )}
            {activeTab === "ops" && (
              <OpsTab
                hasAccounts={hasAccounts}
                accounts={accounts}
                categories={categories}
                incomeAccountId={incomeAccountId}
                onIncomeAccountChange={setIncomeAccountId}
                incomeAmount={incomeAmount}
                onIncomeAmountChange={setIncomeAmount}
                incomeTag={incomeTag}
                onIncomeTagChange={setIncomeTag}
                incomeCategoryId={incomeCategoryId}
                onIncomeCategoryChange={setIncomeCategoryId}
                incomeNote={incomeNote}
                onIncomeNoteChange={setIncomeNote}
                onCreateIncome={handleCreateIncome}
                incomeErrorDetails={incomeErrorDetails}
                expenseAccountId={expenseAccountId}
                onExpenseAccountChange={setExpenseAccountId}
                expenseAmount={expenseAmount}
                onExpenseAmountChange={setExpenseAmount}
                expenseCategoryId={expenseCategoryId}
                onExpenseCategoryChange={setExpenseCategoryId}
                expenseTag={expenseTag}
                onExpenseTagChange={setExpenseTag}
                expenseNote={expenseNote}
                onExpenseNoteChange={setExpenseNote}
                onCreateExpense={handleCreateExpense}
                expenseErrorDetails={expenseErrorDetails}
                transferFromAccountId={transferFromAccountId}
                onTransferFromAccountChange={setTransferFromAccountId}
                transferToAccountId={transferToAccountId}
                onTransferToAccountChange={setTransferToAccountId}
                transferAmount={transferAmount}
                onTransferAmountChange={setTransferAmount}
                transferNote={transferNote}
                onTransferNoteChange={setTransferNote}
                onCreateTransfer={handleCreateTransfer}
                transferErrorDetails={transferErrorDetails}
                debtOtherAmount={debtOtherAmount}
                onDebtOtherAmountChange={setDebtOtherAmount}
                debtOtherDirection={debtOtherDirection}
                onDebtOtherDirectionChange={setDebtOtherDirection}
                debtOtherAccountId={debtOtherAccountId}
                onDebtOtherAccountChange={setDebtOtherAccountId}
                debtOtherCreditor={debtOtherCreditor}
                onDebtOtherCreditorChange={setDebtOtherCreditor}
                onCreateDebtOther={handleCreateDebtOther}
                opsDate={opsDate}
                onOpsDateChange={handleOpsDateChange}
                transactions={transactions}
                activeDebts={activeDebts}
                selectedDate={selectedDate}
                onSelectedDateChange={setSelectedDate}
                accountMap={accountMap}
                goals={goals}
                bottomDayTotal={bottomDayTotal}
                onDeleteTransaction={handleDeleteTransaction}
                onEditTransaction={handleEditTransaction}
                editingTransaction={editingTransaction}
                onCancelEdit={clearEditingTransaction}
                mode={opsMode}
                onModeChange={setOpsMode}
              />
            )}
            {activeTab === "reports" && (
              <ReportsTab
                viewMode={viewMode}
                onViewModeChange={setViewMode}
                assetsTotal={assetsTotal}
                debtsTotal={debtsTotal}
                balanceTotal={balanceTotal}
                bottomDayTotal={bottomDayTotal}
                selectedDate={selectedDate}
                reportBalanceByAccounts={reportBalanceByAccounts}
                isReportBalanceByAccountsOpen={isReportBalanceByAccountsOpen}
                onToggleReportBalanceByAccounts={
                  handleToggleReportBalanceByAccounts
                }
                reportFrom={reportFrom}
                onReportFromChange={setReportFrom}
                reportTo={reportTo}
                onReportToChange={setReportTo}
                reportCashflow={reportCashflow}
                reportBalance={reportBalance}
                reportExpensesLimit={reportExpensesLimit}
                onReportExpensesLimitChange={handleReportExpensesLimitChange}
                reportExpensesByCategory={reportExpensesByCategory}
                expandedReportCategories={expandedReportCategories}
                onToggleReportCategory={toggleReportCategory}
                reportSummary={reportSummary}
                normalizeReportGoalRemaining={normalizeReportGoalRemaining}
                monthIncomeTotal={monthIncomeTotal}
                monthExpenseTotal={monthExpenseTotal}
                monthNetTotal={monthNetTotal}
                monthAvgNet={monthAvgNet}
                selectedMonth={selectedMonth}
                onSelectedMonthChange={setSelectedMonth}
                monthReport={monthReport}
                renderMonthReconcileStatus={renderMonthReconcileStatus}
              />
            )}
            {activeTab === "settings" && (
              <SettingsTab
                budgets={budgets}
                activeBudgetId={activeBudgetId}
                onBudgetChange={handleBudgetChange}
                accounts={accounts}
                categories={categories}
                renderCategoryTree={renderCategoryTree}
                rules={rules}
                getAccountLabel={getAccountLabel}
                getCategoryLabel={getCategoryLabel}
                getTagLabel={getTagLabel}
                onDeleteRule={handleDeleteRule}
                onCreateRule={handleCreateRule}
                rulePattern={rulePattern}
                onRulePatternChange={setRulePattern}
                ruleAccountId={ruleAccountId}
                onRuleAccountChange={setRuleAccountId}
                ruleCategoryId={ruleCategoryId}
                onRuleCategoryChange={setRuleCategoryId}
                ruleTag={ruleTag}
                onRuleTagChange={setRuleTag}
                goals={goals}
                normalizeGoalRemaining={normalizeGoalRemaining}
                getGoalStrategy={getGoalStrategy}
                onGoalAdjust={handleGoalAdjust}
                onGoalClose={handleGoalClose}
                onGoalArchive={handleGoalArchive}
                onDeleteGoal={handleDeleteGoal}
                onCreateGoal={handleCreateGoal}
                goalTitle={goalTitle}
                onGoalTitleChange={setGoalTitle}
                goalTargetAmount={goalTargetAmount}
                onGoalTargetAmountChange={setGoalTargetAmount}
                goalDeadline={goalDeadline}
                onGoalDeadlineChange={setGoalDeadline}
                onCreateAccount={handleCreateAccount}
                accountName={accountName}
                onAccountNameChange={setAccountName}
                accountActiveFrom={accountActiveFrom}
                onAccountActiveFromChange={setAccountActiveFrom}
                accountInitialAmount={accountInitialAmount}
                onAccountInitialAmountChange={setAccountInitialAmount}
                accountKind={accountKind}
                onAccountKindChange={setAccountKind}
                accountErrorDetails={accountErrorDetails}
                onCreateCategory={handleCreateCategory}
                categoryName={categoryName}
                onCategoryNameChange={setCategoryName}
                categoryParent={categoryParent}
                onCategoryParentChange={setCategoryParent}
                categoryErrorDetails={categoryErrorDetails}
                onResetAll={handleResetAll}
                onLogout={handleLogout}
              />
            )}
          </>
        )}
      </div>
      {status === "ready" && (
        <Tabs active={activeTab} onChange={setActiveTab} />
      )}
    </main>
  );
}

type TransactionsCardProps = {
  title: string;
  showSummary?: boolean;
  selectedDate: string;
  onSelectedDateChange: (value: string) => void;
  transactions: Transaction[];
  accountMap: Map<string, Account>;
  goals: Goal[];
  categories: Category[];
  bottomDayTotal: number;
  onDeleteTransaction: (txId: string) => void;
  onEditTransaction: (tx: Transaction) => void;
  onTransactionOpen?: (tx: Transaction) => void;
};


const TransactionsCard = ({
  title,
  showSummary = false,
  selectedDate,
  onSelectedDateChange,
  transactions,
  accountMap,
  goals,
  categories,
  bottomDayTotal,
  onDeleteTransaction,
  onEditTransaction,
  onTransactionOpen,
}: TransactionsCardProps) => (
  <Card title={title}>
    <div className="mf-row">
      <Input
        label="Дата"
        type="date"
        value={selectedDate}
        onChange={(event) => onSelectedDateChange(event.target.value)}
      />
    </div>
    <TransactionsGroupList
      transactions={transactions}
      accountMap={accountMap}
      goals={goals}
      categories={categories}
      onDeleteTransaction={onDeleteTransaction}
      onEditTransaction={onEditTransaction}
      onTransactionOpen={onTransactionOpen}
    />
    {showSummary && (
      <p className="mf-muted">Итог за день (нижний): {bottomDayTotal} ₽</p>
    )}
  </Card>
);

type OperationDateRowProps = {
  dateValue: string;
  onDateChange: (value: string) => void;
};

const OperationDateRow = ({
  dateValue,
  onDateChange,
}: OperationDateRowProps) => {
  const [isEditing, setIsEditing] = useState(false);
  return (
    <div className="mf-stack">
      <div className="mf-row mf-date-row">
        <span className="mf-date-row__value mf-date-prominent">
          📅 {formatShortRuDate(dateValue)}
        </span>
        <button
          type="button"
          className="mf-icon-btn mf-date-row__edit"
          onClick={() => setIsEditing((prev) => !prev)}
          aria-label="Изменить дату"
        >
          ✏️
        </button>
      </div>
      {isEditing && (
        <Input
          label="Выберите дату"
          type="date"
          value={dateValue}
          onChange={(event) => {
            onDateChange(event.target.value);
            setIsEditing(false);
          }}
        />
      )}
    </div>
  );
};

type DebtFormProps = {
  mode: "create" | "edit";
  hasAccounts: boolean;
  dateValue: string;
  onDateChange: (value: string) => void;
  debtOtherAccountId: string;
  onDebtOtherAccountChange: (value: string) => void;
  debtOtherAmount: string;
  onDebtOtherAmountChange: (value: string) => void;
  debtOtherDirection: "borrowed" | "repaid";
  onDebtOtherDirectionChange: (value: "borrowed" | "repaid") => void;
  debtOtherCreditor: string;
  onDebtOtherCreditorChange: (value: string) => void;
  accounts: Account[];
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
};

const DebtForm = ({
  mode,
  hasAccounts,
  dateValue,
  onDateChange,
  debtOtherAccountId,
  onDebtOtherAccountChange,
  debtOtherAmount,
  onDebtOtherAmountChange,
  debtOtherDirection,
  onDebtOtherDirectionChange,
  debtOtherCreditor,
  onDebtOtherCreditorChange,
  accounts,
  onSubmit,
  onClose,
}: DebtFormProps) => (
  <Card title={mode === "edit" ? "Редактирование долга" : "Создать · Долг"}>
    {!hasAccounts && <p>Создайте хотя бы один счёт для учета долгов.</p>}
    <form className="mf-stack" onSubmit={onSubmit}>
      <OperationDateRow dateValue={dateValue} onDateChange={onDateChange} />
      <label className="mf-input"><span className="mf-input__label">Счет</span><select className="mf-select" value={debtOtherAccountId} onChange={(event) => onDebtOtherAccountChange(event.target.value)} required disabled={!hasAccounts}><option value="">Выберите счет</option>{accounts.map((account) => (<option key={account.id} value={account.id}>{account.name}</option>))}</select></label>
      <Input label="Сумма" type="number" value={debtOtherAmount} onChange={(event) => onDebtOtherAmountChange(event.target.value)} required disabled={!hasAccounts} />
      <label className="mf-input"><span className="mf-input__label">Операция</span><select className="mf-select" value={debtOtherDirection} onChange={(event) => onDebtOtherDirectionChange(event.target.value as "borrowed" | "repaid")} disabled={!hasAccounts}><option value="borrowed">Взял в долг</option><option value="repaid">Вернул долг</option></select></label>
      <Input label="Кредитор" type="text" value={debtOtherCreditor} onChange={(event) => onDebtOtherCreditorChange(event.target.value)} placeholder="У кого заняли или кому вернули" disabled={!hasAccounts} />
      <div className="mf-row"><Button type="submit" disabled={!hasAccounts}>{mode === "edit" ? "Сохранить изменения" : "Сохранить"}</Button><Button type="button" variant="secondary" onClick={onClose}>Закрыть</Button></div>
    </form>
  </Card>
);

type TransactionsGroupListProps = {
  transactions: Transaction[];
  accountMap: Map<string, Account>;
  goals: Goal[];
  categories: Category[];
  onDeleteTransaction: (txId: string) => void;
  onEditTransaction: (tx: Transaction) => void;
  onTransactionOpen?: (tx: Transaction) => void;
};


const TransactionsGroupList = ({
  transactions,
  accountMap,
  goals,
  categories,
  onDeleteTransaction,
  onEditTransaction,
  onTransactionOpen,
}: TransactionsGroupListProps) => {
  const [expandedTransactionId, setExpandedTransactionId] = useState<
    string | null
  >(null);
  const groupedTransactions = useMemo(() => {
    const map = new Map<
      string,
      { date: string; total: number; items: Transaction[] }
    >();
    const order: string[] = [];
    transactions.forEach((tx) => {
      if (!map.has(tx.date)) {
        map.set(tx.date, { date: tx.date, total: 0, items: [] });
        order.push(tx.date);
      }
      const group = map.get(tx.date);
      if (!group) {
        return;
      }
      group.items.push(tx);
      if (tx.kind === "normal") {
        if (tx.type === "income") {
          group.total += tx.amount;
        } else if (tx.type === "expense") {
          group.total -= tx.amount;
        }
      }
    });
    return order.map((date) => map.get(date)).filter(Boolean) as Array<{
      date: string;
      total: number;
      items: Transaction[];
    }>;
  }, [transactions]);

  if (!transactions.length) {
    return <p className="mf-muted">Нет операций</p>;
  }

  return (
    <div className="mf-stack">
      {groupedTransactions.map((group) => (
        <div key={group.date} className="mf-transaction-group">
          <div className="mf-transaction-group__header">
            <span className="mf-date-prominent">{formatShortRuDate(group.date)}</span>
            <span className="mf-transaction-group__total">
              Итог дня: {formatRub(group.total)}
            </span>
          </div>
          <div className="mf-divider" />
          <div className="mf-stack">
            {group.items.map((tx, index) => {
              const isExpanded = expandedTransactionId === tx.id;
              const accountName =
                (tx.account_id && accountMap.get(tx.account_id)?.name) ||
                "Счет";
              const toAccountName =
                (tx.to_account_id && accountMap.get(tx.to_account_id)?.name) ||
                "Счет";
              const isDebt = tx.kind === "debt";
              const debtMetadata = isDebt ? parseDebtMetadata(tx.note) : null;
              const debtDirectionLabel =
                debtMetadata?.direction === "repaid" ? "Вернул" : "Взял в долг";
              const debtCreditorLabel = getDebtCreditor(debtMetadata, tx.note);
              const categoryName =
                (tx.category_id &&
                  categories.find((cat) => cat.id === tx.category_id)?.name) ||
                null;
              const goalTitle =
                (tx.goal_id &&
                  goals.find((goal) => goal.id === tx.goal_id)?.title) ||
                null;
              const isGoalTransfer = tx.kind === "goal_transfer";
              const amountSign =
                tx.type === "income" ? 1 : tx.type === "expense" ? -1 : 0;
              const amountValue =
                amountSign === 0 ? tx.amount : tx.amount * amountSign;
              const amountLabel = formatRub(amountValue);
              const amountClass =
                amountSign > 0
                  ? "mf-amount--pos"
                  : amountSign < 0
                    ? "mf-amount--neg"
                    : "mf-amount--neutral";
              const tagLabel =
                tx.tag === "subscription"
                  ? "Подписка"
                  : tx.tag === "one_time"
                    ? "Разовый"
                    : "";
              const primaryLabel = isDebt
                ? `Долг: ${debtCreditorLabel}`
                : tx.type === "expense" && !isGoalTransfer
                  ? categoryName ?? "Без категории"
                  : tx.type === "transfer"
                    ? "Перевод"
                    : tagLabel || "Без тега";
              const typeLabel = isGoalTransfer
                ? "Перевод цели"
                : isDebt
                  ? "Долг"
                  : tx.type === "income"
                    ? "Доход"
                    : tx.type === "expense"
                      ? "Расход"
                      : "Перевод";
              const noteLabel = isDebt ? debtCreditorLabel : tx.note;

              return (
                <div key={tx.id} className="mf-transaction-row">
                  <button
                    type="button"
                    className="mf-transaction-row__main"
                    onClick={() =>
                      onTransactionOpen
                        ? onTransactionOpen(tx)
                        : setExpandedTransactionId(isExpanded ? null : tx.id)
                    }
                    aria-expanded={isExpanded}
                  >
                    <span className={`mf-amount ${amountClass}`}>
                      {amountLabel}
                    </span>
                    <span className="mf-transaction-row__label">
                      {primaryLabel}
                    </span>
                  </button>
                  {isExpanded && (
                    <div className="mf-transaction-details">
                      <div className="mf-transaction-details__row">
                        <span className="mf-small">Сумма</span>
                        <span>{amountLabel}</span>
                      </div>
                      <div className="mf-transaction-details__row">
                        <span className="mf-small">Тип</span>
                        <span>{typeLabel}</span>
                      </div>
                      {isDebt && (
                        <>
                          <div className="mf-transaction-details__row">
                            <span className="mf-small">Направление</span>
                            <span>{debtDirectionLabel}</span>
                          </div>
                          <div className="mf-transaction-details__row">
                            <span className="mf-small">Кредитор</span>
                            <span>{debtCreditorLabel}</span>
                          </div>
                        </>
                      )}
                      <div className="mf-transaction-details__row">
                        <span className="mf-small">Счёт</span>
                        <span>
                          {tx.type === "transfer"
                            ? `${accountName} → ${toAccountName}`
                            : accountName}
                        </span>
                      </div>
                      {!isDebt && (
                        <div className="mf-transaction-details__row">
                          <span className="mf-small">
                            {tx.type === "expense" ? "Категория" : "Тег"}
                          </span>
                          <span>
                            {tx.type === "expense"
                              ? categoryName ?? "Без категории"
                              : tagLabel || "Без тега"}
                          </span>
                        </div>
                      )}
                      <div className="mf-transaction-details__row">
                        <span className="mf-small">Дата</span>
                        <span>{formatShortRuDate(tx.date)}</span>
                      </div>
                      <div className="mf-transaction-details__row">
                        <span className="mf-small">Комментарий</span>
                        <span>{noteLabel || "—"}</span>
                      </div>
                      {isGoalTransfer && (
                        <div className="mf-transaction-details__row">
                          <span className="mf-small">Цель</span>
                          <span>{goalTitle ?? "—"}</span>
                        </div>
                      )}
                      <div className="mf-transaction-details__actions">
                        <Button
                          variant="secondary"
                          className="mf-button--small"
                          onClick={() => onEditTransaction(tx)}
                        >
                          Редактировать
                        </Button>
                        <Button
                          variant="danger"
                          className="mf-button--small"
                          onClick={() => window.confirm("Удалить операцию?") && onDeleteTransaction(tx.id)}
                        >
                          Удалить
                        </Button>
                      </div>
                    </div>
                  )}
                  {index < group.items.length - 1 && (
                    <div className="mf-divider mf-space" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};

type DayTabProps = {
  selectedDate: string;
  onSelectedDateChange: (value: string) => void;
  balanceTotal: number;
  assetsTotal: number;
  debtsTotal: number;
  bottomDayTotal: number;
  topDayTotal: number;
  hasAccounts: boolean;
  reconcileDiffAbs: number;
  reconcileDiff: number;
  reconcileDelta: number;
  reconcileAccountId: string;
  reconcileCanAdjust: boolean;
  reconcileEligibleAccountIds: Set<string>;
  reconcileHint: string | null;
  reconcileErrorDetails: FormErrorDetails | null;
  reconcileErrorDetail: string | null;
  onReconcileAccountChange: (value: string) => void;
  onReconcileAdjust: () => void;
  accounts: Account[];
  transactions: Transaction[];
  activeDebts: ActiveDebt[];
  goals: Goal[];
  categories: Category[];
  dailyStateAccounts: DailyStateAccount[];
  accountMap: Map<string, Account>;
  onDeleteTransaction: (txId: string) => void;
  onEditTransaction: (tx: Transaction) => void;
  onEditDebtTransaction: (tx: Transaction) => void;
  dayModal: DayModal;
  onCloseModal: () => void;
  onCreateAccountClick: () => void;
  onEditAccount: (account: Account) => void;
  onDeleteAccount: (accountId: string) => void;
  onCreateCategoryClick: () => void;
  onCreateGoalClick: () => void;
  onCreateDebtClick: () => void;
  onEditCategory: (category: Category) => void;
  onDeleteCategory: (categoryId: string) => void;
  accountName: string;
  onAccountNameChange: (value: string) => void;
  accountKind: string;
  onAccountKindChange: (value: string) => void;
  accountActiveFrom: string;
  onAccountActiveFromChange: (value: string) => void;
  accountInitialAmount: string;
  onAccountInitialAmountChange: (value: string) => void;
  onCreateAccount: (event: FormEvent<HTMLFormElement>) => void;
  onSaveAccount: (event: FormEvent<HTMLFormElement>) => void;
  categoryName: string;
  onCategoryNameChange: (value: string) => void;
  categoryParent: string;
  onCategoryParentChange: (value: string) => void;
  onCreateCategory: (event: FormEvent<HTMLFormElement>) => void;
  onSaveCategory: (event: FormEvent<HTMLFormElement>) => void;
  goalTitle: string;
  onGoalTitleChange: (value: string) => void;
  goalTargetAmount: string;
  onGoalTargetAmountChange: (value: string) => void;
  goalDeadline: string;
  onGoalDeadlineChange: (value: string) => void;
  onCreateGoal: (event: FormEvent<HTMLFormElement>) => void;
  debtOtherAmount: string;
  onDebtOtherAmountChange: (value: string) => void;
  debtOtherDirection: "borrowed" | "repaid";
  onDebtOtherDirectionChange: (value: "borrowed" | "repaid") => void;
  debtOtherAccountId: string;
  onDebtOtherAccountChange: (value: string) => void;
  debtOtherCreditor: string;
  onDebtOtherCreditorChange: (value: string) => void;
  onCreateDebtOther: (event: FormEvent<HTMLFormElement>) => void;
};

const DayTab = ({
  selectedDate,
  onSelectedDateChange,
  balanceTotal,
  assetsTotal,
  debtsTotal,
  bottomDayTotal,
  topDayTotal,
  hasAccounts,
  reconcileDiffAbs,
  reconcileDiff,
  reconcileDelta,
  reconcileAccountId,
  reconcileCanAdjust,
  reconcileEligibleAccountIds,
  reconcileHint,
  reconcileErrorDetails,
  reconcileErrorDetail,
  onReconcileAccountChange,
  onReconcileAdjust,
  accounts,
  transactions,
  activeDebts,
  goals,
  categories,
  dailyStateAccounts,
  accountMap,
  onDeleteTransaction,
  onEditTransaction,
  onEditDebtTransaction,
  dayModal,
  onCloseModal,
  onCreateAccountClick,
  onEditAccount,
  onDeleteAccount,
  onCreateCategoryClick,
  onCreateGoalClick,
  onCreateDebtClick,
  onEditCategory,
  onDeleteCategory,
  accountName,
  onAccountNameChange,
  accountKind,
  onAccountKindChange,
  accountActiveFrom,
  onAccountActiveFromChange,
  accountInitialAmount,
  onAccountInitialAmountChange,
  onCreateAccount,
  onSaveAccount,
  categoryName,
  onCategoryNameChange,
  categoryParent,
  onCategoryParentChange,
  onCreateCategory,
  onSaveCategory,
  goalTitle,
  onGoalTitleChange,
  goalTargetAmount,
  onGoalTargetAmountChange,
  goalDeadline,
  onGoalDeadlineChange,
  onCreateGoal,
  debtOtherAmount,
  onDebtOtherAmountChange,
  debtOtherDirection,
  onDebtOtherDirectionChange,
  debtOtherAccountId,
  onDebtOtherAccountChange,
  debtOtherCreditor,
  onDebtOtherCreditorChange,
  onCreateDebtOther,
}: DayTabProps) => (
  <div className="mf-stack">
    <div className="mf-row mf-date-row mf-date-row--sticky">
      <strong className="mf-date-prominent">📅 {formatShortRuDate(selectedDate)}</strong>
      <button
        type="button"
        className="mf-icon-btn mf-date-row__edit"
        onClick={() => {
          const picker = document.getElementById("mf-day-date-picker") as HTMLInputElement | null;
          picker?.showPicker?.();
          picker?.focus();
        }}
        aria-label="Изменить дату"
      >
        ✏️
      </button>
      <input
        id="mf-day-date-picker"
        className="mf-date-row__picker"
        type="date"
        value={selectedDate}
        onChange={(event) => onSelectedDateChange(event.target.value)}
      />
    </div>

    <div className="mf-grid-2 mf-summary-grid">
      <Card>
        <div className="mf-row" style={{ justifyContent: "space-between" }}>
          <div>
            <div className="mf-small">Баланс</div>
            <div className={`mf-kpi-value ${balanceTotal > 0 ? "mf-kpi-value--pos" : balanceTotal < 0 ? "mf-kpi-value--neg" : "mf-kpi-value--neutral"}`}>
              {formatRub(balanceTotal)}
            </div>
          </div>
        </div>
      </Card>
      <Card>
        <div className="mf-row" style={{ justifyContent: "space-between" }}>
          <div>
            <div className="mf-small">Остаток</div>
            <div className="mf-kpi-subtle">
              {formatRub(assetsTotal)}
            </div>
          </div>
        </div>
      </Card>
      <Card>
        <div className="mf-row" style={{ justifyContent: "space-between" }}>
          <div>
            <div className="mf-small">Долги</div>
            <div className="mf-kpi-debt">
              {formatRub(debtsTotal)}
            </div>
          </div>
        </div>
      </Card>
      <Card>
        <div className="mf-row" style={{ justifyContent: "space-between" }}>
          <div>
            <div className="mf-small">Итог дня</div>
            <div className="mf-day-total-badge">
              <span className="mf-day-total-dot" />
              {bottomDayTotal >= 0
                ? `+${formatRub(bottomDayTotal)}`
                : formatRub(bottomDayTotal)}
            </div>
          </div>
          {hasAccounts && (
            <Pill
              variant={
                reconcileDiffAbs <= 1
                  ? "ok"
                  : reconcileDiffAbs <= 100
                    ? "warn"
                    : "err"
              }
              text={
                reconcileDiffAbs <= 1
                  ? "OK"
                  : `Δ ${formatRub(reconcileDiffAbs)}`
              }
            />
          )}
        </div>
      </Card>
    </div>

    <Card title="Операции за день">
      <TransactionsGroupList
        transactions={transactions}
        accountMap={accountMap}
        goals={goals}
        categories={categories}
        onDeleteTransaction={onDeleteTransaction}
        onEditTransaction={onEditTransaction}
      />
    </Card>

    <Card title="Счета">
      {accounts.length ? (
        <table className="mf-table">
          <thead>
            <tr>
              <th>Название</th>
              <th>Тип</th>
              <th>Текущий остаток</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => {
              const currentBalance =
                dailyStateAccounts.find(
                  (dayAccount) => dayAccount.account_id === account.id,
                )?.amount ?? 0;
              return (
                <tr key={account.id}>
                  <td>{account.name}</td>
                  <td>{account.kind}</td>
                  <td>{formatRub(currentBalance)}</td>
                  <td>
                    <button type="button" className="mf-icon-btn" onClick={() => onEditAccount(account)}>✏️</button>
                    <button type="button" className="mf-icon-btn mf-icon-btn--danger" onClick={() => window.confirm("Удалить счет?") && onDeleteAccount(account.id)}>🗑</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p>Счета не добавлены</p>
      )}
      <Button variant="secondary" onClick={onCreateAccountClick}>➕ Создать счет</Button>
      {(dayModal === "account-create" || dayModal === "account-edit") && (
        <Card title={dayModal === "account-create" ? "Создать · Счет" : "Изменить · Счет"}>
          <form className="mf-stack" onSubmit={dayModal === "account-create" ? onCreateAccount : onSaveAccount}>
            <Input label="Название" type="text" value={accountName} onChange={(event) => onAccountNameChange(event.target.value)} required />
            <label className="mf-input"><span className="mf-input__label">Тип</span><select className="mf-select" value={accountKind} onChange={(event) => onAccountKindChange(event.target.value)}><option value="cash">Наличные</option><option value="debit">Дебет</option><option value="savings">Накопительный</option><option value="credit">Кредитный</option></select></label>
            <Input label="Дата создания" type="date" value={accountActiveFrom} onChange={(event) => onAccountActiveFromChange(event.target.value)} required />
            <Input label="Начальный остаток" type="number" value={accountInitialAmount} onChange={(event) => onAccountInitialAmountChange(event.target.value)} required />
            <div className="mf-row"><Button type="submit">Сохранить</Button><Button type="button" variant="secondary" onClick={onCloseModal}>Закрыть</Button></div>
          </form>
        </Card>
      )}
    </Card>

    <Card title="Цели">
      {goals.length ? (
        <table className="mf-table">
          <thead>
            <tr><th>Цель</th><th>Прогресс</th><th>Действия</th></tr>
          </thead>
          <tbody>
            {goals.map((goal) => (
              <tr key={goal.id}>
                <td>{goal.title}</td>
                <td>
                  <div className="mf-goal-progress-wrap">
                    <div className="mf-goal-progress-track">
                      <div
                        className="mf-goal-progress-fill"
                        style={{ width: `${Math.min(100, Math.round((goal.current_amount / Math.max(goal.target_amount, 1)) * 100))}%` }}
                      />
                    </div>
                    <span className="mf-small">{Math.min(100, Math.round((goal.current_amount / Math.max(goal.target_amount, 1)) * 100))}% · {goal.current_amount} / {goal.target_amount} ₽</span>
                  </div>
                </td>
                <td>
                  <button type="button" className="mf-icon-btn" onClick={onCreateGoalClick} aria-label="Редактировать цель">✏️</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p>Нет целей</p>}
      <Button variant="secondary" onClick={onCreateGoalClick}>➕ Создать цель</Button>
      {dayModal === "goal-create" && (
        <Card title="Создать · Цель">
          <form className="mf-stack" onSubmit={onCreateGoal}>
            <Input label="Название цели" type="text" value={goalTitle} onChange={(event) => onGoalTitleChange(event.target.value)} required />
            <Input label="Сумма" type="number" value={goalTargetAmount} onChange={(event) => onGoalTargetAmountChange(event.target.value)} required />
            <Input label="Дата" type="date" value={goalDeadline} onChange={(event) => onGoalDeadlineChange(event.target.value)} required />
            <div className="mf-row"><Button type="submit">Сохранить</Button><Button type="button" variant="secondary" onClick={onCloseModal}>Закрыть</Button></div>
          </form>
        </Card>
      )}
    </Card>

    <Card title="Категории">
      {categories.length ? (
        <table className="mf-table">
          <thead>
            <tr><th>Категория</th><th>Доходы</th><th>Расходы</th><th>Действия</th></tr>
          </thead>
          <tbody>
            {categories.map((category) => {
              const totalIncome = transactions
                .filter((tx) => tx.category_id === category.id && tx.type === "income")
                .reduce((sum, tx) => sum + tx.amount, 0);
              const totalExpense = transactions
                .filter((tx) => tx.category_id === category.id && tx.type === "expense")
                .reduce((sum, tx) => sum + tx.amount, 0);
              return (
                <tr key={category.id}>
                  <td>{category.name}</td>
                  <td>{formatRub(totalIncome)}</td>
                  <td>{formatRub(totalExpense)}</td>
                  <td>
                    <button type="button" className="mf-icon-btn" onClick={() => onEditCategory(category)}>✏️</button>
                    <button type="button" className="mf-icon-btn mf-icon-btn--danger" onClick={() => window.confirm("Удалить категорию?") && onDeleteCategory(category.id)}>🗑</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : <p>Категории не добавлены</p>}
      <Button variant="secondary" onClick={onCreateCategoryClick}>➕ Создать категорию</Button>
      {(dayModal === "category-create" || dayModal === "category-edit") && (
        <Card title={dayModal === "category-create" ? "Создать · Категорию" : "Изменить · Категорию"}>
          <form className="mf-stack" onSubmit={dayModal === "category-create" ? onCreateCategory : onSaveCategory}>
            <Input label="Название" type="text" value={categoryName} onChange={(event) => onCategoryNameChange(event.target.value)} required />
            <Input label="Родитель ID (опц.)" type="text" value={categoryParent} onChange={(event) => onCategoryParentChange(event.target.value)} />
            <div className="mf-row"><Button type="submit">Сохранить</Button><Button type="button" variant="secondary" onClick={onCloseModal}>Закрыть</Button></div>
          </form>
        </Card>
      )}
    </Card>

    <Card title="Долги (детально)">
      {activeDebts.length ? (
        <table className="mf-table">
          <thead>
            <tr><th>Кредитор</th><th>Сумма</th><th>Дата долга</th></tr>
          </thead>
          <tbody>
            {activeDebts.map((debt) => (
              <tr key={`${debt.creditor_name}-${debt.debt_date}`}>
                <td>{debt.creditor_name}</td>
                <td>{formatRub(debt.amount)}</td>
                <td>{formatShortRuDate(debt.debt_date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p>Долгов нет</p>}
      <Button variant="secondary" onClick={onCreateDebtClick}>➕ Добавить долг</Button>
      {(dayModal === "debt-create" || dayModal === "debt-edit") && (
        <DebtForm
          mode={dayModal === "debt-edit" ? "edit" : "create"}
          hasAccounts={hasAccounts}
          dateValue={selectedDate}
          onDateChange={onSelectedDateChange}
          debtOtherAccountId={debtOtherAccountId}
          onDebtOtherAccountChange={onDebtOtherAccountChange}
          debtOtherAmount={debtOtherAmount}
          onDebtOtherAmountChange={onDebtOtherAmountChange}
          debtOtherDirection={debtOtherDirection}
          onDebtOtherDirectionChange={onDebtOtherDirectionChange}
          debtOtherCreditor={debtOtherCreditor}
          onDebtOtherCreditorChange={onDebtOtherCreditorChange}
          accounts={accounts}
          onSubmit={onCreateDebtOther}
          onClose={onCloseModal}
        />
      )}
    </Card>

  </div>
);

type OpsTabProps = {
  hasAccounts: boolean;
  accounts: Account[];
  categories: Category[];
  incomeAccountId: string;
  onIncomeAccountChange: (value: string) => void;
  incomeAmount: string;
  onIncomeAmountChange: (value: string) => void;
  incomeTag: "one_time" | "subscription";
  onIncomeTagChange: (value: "one_time" | "subscription") => void;
  incomeCategoryId: string;
  onIncomeCategoryChange: (value: string) => void;
  incomeNote: string;
  onIncomeNoteChange: (value: string) => void;
  onCreateIncome: (event: FormEvent<HTMLFormElement>) => void;
  incomeErrorDetails: FormErrorDetails | null;
  expenseAccountId: string;
  onExpenseAccountChange: (value: string) => void;
  expenseAmount: string;
  onExpenseAmountChange: (value: string) => void;
  expenseCategoryId: string;
  onExpenseCategoryChange: (value: string) => void;
  expenseTag: "one_time" | "subscription";
  onExpenseTagChange: (value: "one_time" | "subscription") => void;
  expenseNote: string;
  onExpenseNoteChange: (value: string) => void;
  onCreateExpense: (event: FormEvent<HTMLFormElement>) => void;
  expenseErrorDetails: FormErrorDetails | null;
  transferFromAccountId: string;
  onTransferFromAccountChange: (value: string) => void;
  transferToAccountId: string;
  onTransferToAccountChange: (value: string) => void;
  transferAmount: string;
  onTransferAmountChange: (value: string) => void;
  transferNote: string;
  onTransferNoteChange: (value: string) => void;
  onCreateTransfer: (event: FormEvent<HTMLFormElement>) => void;
  transferErrorDetails: FormErrorDetails | null;
  debtOtherAmount: string;
  onDebtOtherAmountChange: (value: string) => void;
  debtOtherDirection: "borrowed" | "repaid";
  onDebtOtherDirectionChange: (value: "borrowed" | "repaid") => void;
  debtOtherAccountId: string;
  onDebtOtherAccountChange: (value: string) => void;
  debtOtherCreditor: string;
  onDebtOtherCreditorChange: (value: string) => void;
  onCreateDebtOther: (event: FormEvent<HTMLFormElement>) => void;
  opsDate: string;
  onOpsDateChange: (value: string) => void;
  transactions: Transaction[];
  activeDebts: ActiveDebt[];
  selectedDate: string;
  onSelectedDateChange: (value: string) => void;
  accountMap: Map<string, Account>;
  goals: Goal[];
  bottomDayTotal: number;
  onDeleteTransaction: (txId: string) => void;
  onEditTransaction: (tx: Transaction) => void;
  editingTransaction: EditingTransaction | null;
  onCancelEdit: () => void;
  mode: "create" | "edit";
  onModeChange: (value: "create" | "edit") => void;
};

const OpsTab = ({
  hasAccounts,
  accounts,
  categories,
  incomeAccountId,
  onIncomeAccountChange,
  incomeAmount,
  onIncomeAmountChange,
  incomeTag,
  onIncomeTagChange,
  incomeCategoryId,
  onIncomeCategoryChange,
  incomeNote,
  onIncomeNoteChange,
  onCreateIncome,
  incomeErrorDetails,
  expenseAccountId,
  onExpenseAccountChange,
  expenseAmount,
  onExpenseAmountChange,
  expenseCategoryId,
  onExpenseCategoryChange,
  expenseTag,
  onExpenseTagChange,
  expenseNote,
  onExpenseNoteChange,
  onCreateExpense,
  expenseErrorDetails,
  transferFromAccountId,
  onTransferFromAccountChange,
  transferToAccountId,
  onTransferToAccountChange,
  transferAmount,
  onTransferAmountChange,
  transferNote,
  onTransferNoteChange,
  onCreateTransfer,
  transferErrorDetails,
  debtOtherAmount,
  onDebtOtherAmountChange,
  debtOtherDirection,
  onDebtOtherDirectionChange,
  
  debtOtherAccountId,
  onDebtOtherAccountChange,
  debtOtherCreditor,
  onDebtOtherCreditorChange,
  onCreateDebtOther,
  opsDate,
  onOpsDateChange,
  transactions,
  selectedDate,
  onSelectedDateChange,
  accountMap,
  goals,
  bottomDayTotal,
  onDeleteTransaction,
  onEditTransaction,
  editingTransaction,
  onCancelEdit,
  mode,
  onModeChange,
}: OpsTabProps) => (
  <div className="mf-stack">
    <div className="tabs mf-row mf-ops-switch">
      <button type="button" className="mf-button mf-button--primary mf-button--fab" onClick={() => onModeChange("create")}>Создать</button>
      <button type="button" className="mf-button mf-button--secondary" onClick={() => onModeChange("edit")}>История</button>
    </div>
    {mode === "edit" && editingTransaction && (
      <Card title="Редактирование операции">
        <div className="mf-row">
          <p className="mf-muted">operationId: {editingTransaction.id}</p>
          <Button variant="secondary" onClick={onCancelEdit}>
            Отменить
          </Button>
        </div>
      </Card>
    )}
    {mode === "edit" && editingTransaction?.kind === "debt" && (
      <DebtForm
        mode="edit"
        hasAccounts={hasAccounts}
        dateValue={opsDate}
        onDateChange={onOpsDateChange}
        debtOtherAccountId={debtOtherAccountId}
        onDebtOtherAccountChange={onDebtOtherAccountChange}
        debtOtherAmount={debtOtherAmount}
        onDebtOtherAmountChange={onDebtOtherAmountChange}
        debtOtherDirection={debtOtherDirection}
        onDebtOtherDirectionChange={onDebtOtherDirectionChange}
        debtOtherCreditor={debtOtherCreditor}
        onDebtOtherCreditorChange={onDebtOtherCreditorChange}
        accounts={accounts}
        onSubmit={onCreateDebtOther}
        onClose={onCancelEdit}
      />
    )}

    {mode === "edit" && editingTransaction?.kind !== "debt" && editingTransaction?.type === "income" && (
      <Card title="Редактирование операции">
        <p className="mf-muted">operationId: {editingTransaction.id}</p>
        <form className="mf-stack" onSubmit={onCreateIncome}>
          <OperationDateRow dateValue={opsDate} onDateChange={onOpsDateChange} />
          <label className="mf-input"><span className="mf-input__label">Счет</span><select className="mf-select" value={incomeAccountId} onChange={(event) => onIncomeAccountChange(event.target.value)} required disabled={!hasAccounts}><option value="">Выберите счет</option>{accounts.map((account) => (<option key={account.id} value={account.id}>{account.name}</option>))}</select></label>
          <Input label="Сумма" type="number" value={incomeAmount} onChange={(event) => onIncomeAmountChange(event.target.value)} required disabled={!hasAccounts} />
          <label className="mf-input"><span className="mf-input__label">Категория</span><select className="mf-select" value={incomeCategoryId} onChange={(event) => onIncomeCategoryChange(event.target.value)} required disabled={!hasAccounts}><option value="">Выберите категорию</option>{categories.map((category) => (<option key={category.id} value={category.id}>{category.name}</option>))}</select></label>
          <Input label="Комментарий" type="text" value={incomeNote} onChange={(event) => onIncomeNoteChange(event.target.value)} disabled={!hasAccounts} />
          <div className="mf-row"><Button type="submit" disabled={!hasAccounts}>Сохранить изменения</Button><Button type="button" variant="secondary" onClick={onCancelEdit}>Отменить</Button></div>
        </form>
      </Card>
    )}

    {mode === "edit" && editingTransaction?.kind !== "debt" && editingTransaction?.type === "expense" && (
      <Card title="Редактирование операции">
        <p className="mf-muted">operationId: {editingTransaction.id}</p>
        <form className="mf-stack" onSubmit={onCreateExpense}>
          <OperationDateRow dateValue={opsDate} onDateChange={onOpsDateChange} />
          <label className="mf-input"><span className="mf-input__label">Счет</span><select className="mf-select" value={expenseAccountId} onChange={(event) => onExpenseAccountChange(event.target.value)} required disabled={!hasAccounts}><option value="">Выберите счет</option>{accounts.map((account) => (<option key={account.id} value={account.id}>{account.name}</option>))}</select></label>
          <Input label="Сумма" type="number" value={expenseAmount} onChange={(event) => onExpenseAmountChange(event.target.value)} required disabled={!hasAccounts} />
          <label className="mf-input"><span className="mf-input__label">Категория</span><select className="mf-select" value={expenseCategoryId} onChange={(event) => onExpenseCategoryChange(event.target.value)} disabled={!hasAccounts}><option value="">Без категории</option>{categories.map((category) => (<option key={category.id} value={category.id}>{category.name}</option>))}</select></label>
          <Input label="Комментарий" type="text" value={expenseNote} onChange={(event) => onExpenseNoteChange(event.target.value)} disabled={!hasAccounts} />
          <div className="mf-row"><Button type="submit" disabled={!hasAccounts}>Сохранить изменения</Button><Button type="button" variant="secondary" onClick={onCancelEdit}>Отменить</Button></div>
        </form>
      </Card>
    )}

    {mode === "edit" && editingTransaction?.kind !== "debt" && editingTransaction?.type === "transfer" && (
      <Card title="Редактирование операции">
        <p className="mf-muted">operationId: {editingTransaction.id}</p>
        <form className="mf-stack" onSubmit={onCreateTransfer}>
          <OperationDateRow dateValue={opsDate} onDateChange={onOpsDateChange} />
          <label className="mf-input"><span className="mf-input__label">Счет списания</span><select className="mf-select" value={transferFromAccountId} onChange={(event) => onTransferFromAccountChange(event.target.value)} required disabled={!hasAccounts}><option value="">Выберите счет</option>{accounts.map((account) => (<option key={account.id} value={account.id}>{account.name}</option>))}</select></label>
          <label className="mf-input"><span className="mf-input__label">Счет зачисления</span><select className="mf-select" value={transferToAccountId} onChange={(event) => onTransferToAccountChange(event.target.value)} required disabled={!hasAccounts}><option value="">Выберите счет</option>{accounts.map((account) => (<option key={account.id} value={account.id}>{account.name}</option>))}</select></label>
          <Input label="Сумма" type="number" value={transferAmount} onChange={(event) => onTransferAmountChange(event.target.value)} required disabled={!hasAccounts} />
          <Input label="Комментарий" type="text" value={transferNote} onChange={(event) => onTransferNoteChange(event.target.value)} disabled={!hasAccounts} />
          <div className="mf-row"><Button type="submit" disabled={!hasAccounts}>Сохранить изменения</Button><Button type="button" variant="secondary" onClick={onCancelEdit}>Отменить</Button></div>
        </form>
      </Card>
    )}

    {mode === "create" && (
      <>
    <Card title="Создать · Доход">
      {!hasAccounts && (
        <p>Создайте хотя бы один счёт, чтобы добавлять операции.</p>
      )}
      <form className="mf-stack" onSubmit={onCreateIncome}>
        <OperationDateRow
          dateValue={opsDate}
          onDateChange={onOpsDateChange}
        />
        <label className="mf-input">
          <span className="mf-input__label">Счет</span>
          <select
            className="mf-select"
            value={incomeAccountId}
            onChange={(event) => onIncomeAccountChange(event.target.value)}
            required
            disabled={!hasAccounts}
          >
            <option value="">Выберите счет</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
        <Input
          label="Сумма"
          type="number"
          value={incomeAmount}
          onChange={(event) => onIncomeAmountChange(event.target.value)}
          required
          disabled={!hasAccounts}
        />
        <label className="mf-input">
          <span className="mf-input__label">Категория</span>
          <select
            className="mf-select"
            value={incomeCategoryId}
            onChange={(event) => onIncomeCategoryChange(event.target.value)}
            required
            disabled={!hasAccounts}
          >
            <option value="">Выберите категорию</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
        <label className="mf-input">
          <span className="mf-input__label">Тег</span>
          <select
            className="mf-select"
            value={incomeTag}
            onChange={(event) =>
              onIncomeTagChange(
                event.target.value as "one_time" | "subscription",
              )
            }
            disabled={!hasAccounts}
          >
            <option value="one_time">Разовый</option>
            <option value="subscription">Подписка</option>
          </select>
        </label>
        <Input
          label="Комментарий"
          type="text"
          value={incomeNote}
          onChange={(event) => onIncomeNoteChange(event.target.value)}
          disabled={!hasAccounts}
        />
        <Button type="submit" disabled={!hasAccounts}>
          Добавить
        </Button>
      </form>
      {incomeErrorDetails && (
        <div>
          <p>tx_http_status: {incomeErrorDetails.httpStatus ?? "unknown"}</p>
          <p>
            tx_response_text: {incomeErrorDetails.responseText ?? "unknown"}
          </p>
        </div>
      )}
    </Card>

    <Card title="Создать · Расход">
      {!hasAccounts && (
        <p>Создайте хотя бы один счёт, чтобы добавлять операции.</p>
      )}
      <form className="mf-stack" onSubmit={onCreateExpense}>
        <OperationDateRow
          dateValue={opsDate}
          onDateChange={onOpsDateChange}
        />
        <label className="mf-input">
          <span className="mf-input__label">Счет</span>
          <select
            className="mf-select"
            value={expenseAccountId}
            onChange={(event) => onExpenseAccountChange(event.target.value)}
            required
            disabled={!hasAccounts}
          >
            <option value="">Выберите счет</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
        <Input
          label="Сумма"
          type="number"
          value={expenseAmount}
          onChange={(event) => onExpenseAmountChange(event.target.value)}
          required
          disabled={!hasAccounts}
        />
        <label className="mf-input">
          <span className="mf-input__label">Категория</span>
          <select
            className="mf-select"
            value={expenseCategoryId}
            onChange={(event) => onExpenseCategoryChange(event.target.value)}
            disabled={!hasAccounts}
          >
            <option value="">Без категории</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
        <label className="mf-input">
          <span className="mf-input__label">Тег</span>
          <select
            className="mf-select"
            value={expenseTag}
            onChange={(event) =>
              onExpenseTagChange(
                event.target.value as "one_time" | "subscription",
              )
            }
            disabled={!hasAccounts}
          >
            <option value="one_time">Разовый</option>
            <option value="subscription">Подписка</option>
          </select>
        </label>
        <Input
          label="Комментарий"
          type="text"
          value={expenseNote}
          onChange={(event) => onExpenseNoteChange(event.target.value)}
          disabled={!hasAccounts}
        />
        <Button type="submit" disabled={!hasAccounts}>
          Добавить
        </Button>
      </form>
      {expenseErrorDetails && (
        <div>
          <p>tx_http_status: {expenseErrorDetails.httpStatus ?? "unknown"}</p>
          <p>
            tx_response_text: {expenseErrorDetails.responseText ?? "unknown"}
          </p>
        </div>
      )}
    </Card>

    <Card title="Создать · Перевод">
      {!hasAccounts && (
        <p>Создайте хотя бы один счёт, чтобы делать переводы.</p>
      )}
      <form className="mf-stack" onSubmit={onCreateTransfer}>
        <OperationDateRow
          dateValue={opsDate}
          onDateChange={onOpsDateChange}
        />
        <label className="mf-input">
          <span className="mf-input__label">Счет списания</span>
          <select
            className="mf-select"
            value={transferFromAccountId}
            onChange={(event) => onTransferFromAccountChange(event.target.value)}
            required
            disabled={!hasAccounts}
          >
            <option value="">Выберите счет</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
        <label className="mf-input">
          <span className="mf-input__label">Счет зачисления</span>
          <select
            className="mf-select"
            value={transferToAccountId}
            onChange={(event) => onTransferToAccountChange(event.target.value)}
            required
            disabled={!hasAccounts}
          >
            <option value="">Выберите счет</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
        <Input
          label="Сумма"
          type="number"
          value={transferAmount}
          onChange={(event) => onTransferAmountChange(event.target.value)}
          required
          disabled={!hasAccounts}
        />
        <Input
          label="Комментарий"
          type="text"
          value={transferNote}
          onChange={(event) => onTransferNoteChange(event.target.value)}
          disabled={!hasAccounts}
        />
        <Button type="submit" disabled={!hasAccounts}>
          Перевести
        </Button>
      </form>
      {transferErrorDetails && (
        <div>
          <p>tx_http_status: {transferErrorDetails.httpStatus ?? "unknown"}</p>
          <p>
            tx_response_text: {transferErrorDetails.responseText ?? "unknown"}
          </p>
        </div>
      )}
    </Card>

      </>
    )}

    {mode === "edit" && (
      <TransactionsCard
        title="История операций"
      selectedDate={selectedDate}
      onSelectedDateChange={onSelectedDateChange}
      transactions={transactions}
      accountMap={accountMap}
      goals={goals}
      categories={categories}
      bottomDayTotal={bottomDayTotal}
        onDeleteTransaction={onDeleteTransaction}
        onEditTransaction={onEditTransaction}
        onTransactionOpen={onEditTransaction}
      />
    )}
  </div>
);

type ReportsTabProps = {
  viewMode: "day" | "month";
  onViewModeChange: (value: "day" | "month") => void;
  assetsTotal: number;
  debtsTotal: number;
  balanceTotal: number;
  bottomDayTotal: number;
  selectedDate: string;
  reportBalanceByAccounts: BalanceByAccountsReport | null;
  isReportBalanceByAccountsOpen: boolean;
  onToggleReportBalanceByAccounts: () => void;
  reportFrom: string;
  onReportFromChange: (value: string) => void;
  reportTo: string;
  onReportToChange: (value: string) => void;
  reportCashflow: CashflowDay[];
  reportBalance: BalanceDay[];
  reportExpensesLimit: number;
  onReportExpensesLimitChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  reportExpensesByCategory: ExpensesByCategoryReport | null;
  expandedReportCategories: Record<string, boolean>;
  onToggleReportCategory: (categoryId: string) => void;
  reportSummary: ReportsSummary | null;
  normalizeReportGoalRemaining: (
    goal: ReportsSummary["goals_active"][number],
  ) => number;
  monthIncomeTotal: number;
  monthExpenseTotal: number;
  monthNetTotal: number;
  monthAvgNet: number;
  selectedMonth: string;
  onSelectedMonthChange: (value: string) => void;
  monthReport: MonthReport | null;
  renderMonthReconcileStatus: (diff: number) => JSX.Element;
};

const ReportsTab = ({
  viewMode,
  onViewModeChange,
  assetsTotal,
  debtsTotal,
  balanceTotal,
  bottomDayTotal,
  selectedDate,
  reportBalanceByAccounts,
  isReportBalanceByAccountsOpen,
  onToggleReportBalanceByAccounts,
  reportFrom,
  onReportFromChange,
  reportTo,
  onReportToChange,
  reportCashflow,
  reportBalance,
  reportExpensesLimit,
  onReportExpensesLimitChange,
  reportExpensesByCategory,
  expandedReportCategories,
  onToggleReportCategory,
  reportSummary,
  normalizeReportGoalRemaining,
  monthIncomeTotal,
  monthExpenseTotal,
  monthNetTotal,
  monthAvgNet,
  selectedMonth,
  onSelectedMonthChange,
  monthReport,
  renderMonthReconcileStatus,
}: ReportsTabProps) => {
  const sortedBalanceAccounts = useMemo(() => {
    if (!reportBalanceByAccounts?.accounts?.length) {
      return [];
    }
    const kindOrder = new Map([
      ["cash", 0],
      ["bank", 1],
    ]);
    return [...reportBalanceByAccounts.accounts].sort((a, b) => {
      const kindWeightA = kindOrder.get(a.kind) ?? 2;
      const kindWeightB = kindOrder.get(b.kind) ?? 2;
      if (kindWeightA !== kindWeightB) {
        return kindWeightA - kindWeightB;
      }
      return a.name.localeCompare(b.name, "ru");
    });
  }, [reportBalanceByAccounts]);

  return (
    <div className="mf-stack">
    <Card title="Режим просмотра">
      <div className="mf-row">
        <Button
          variant={viewMode === "day" ? "primary" : "secondary"}
          onClick={() => onViewModeChange("day")}
        >
          День
        </Button>
        <Button
          variant={viewMode === "month" ? "primary" : "secondary"}
          onClick={() => onViewModeChange("month")}
        >
          Месяц
        </Button>
      </div>
    </Card>

    {viewMode === "day" ? (
      <>
        <Card title="Быстрые карточки">
          <div className="mf-stack">
            <div className="mf-row">
              <p>Остаток: {assetsTotal} ₽</p>
              <Button
                variant="secondary"
                className="mf-button--small"
                onClick={onToggleReportBalanceByAccounts}
              >
                Показать по счетам {isReportBalanceByAccountsOpen ? "▲" : "▼"}
              </Button>
            </div>
            {isReportBalanceByAccountsOpen &&
            reportBalanceByAccounts &&
            reportBalanceByAccounts.date === selectedDate ? (
              reportBalanceByAccounts.accounts.length ? (
                <table className="mf-table">
                  <thead>
                    <tr>
                      <th>Счёт</th>
                      <th>Остаток</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedBalanceAccounts.map((account) => (
                      <tr key={account.account_id}>
                        <td>{account.name}</td>
                        <td>{formatRub(account.amount)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td>
                        <strong>Итого</strong>
                      </td>
                      <td>
                        <strong>
                          {formatRub(reportBalanceByAccounts.total)}
                        </strong>
                      </td>
                    </tr>
                  </tbody>
                </table>
              ) : (
                <p>Нет данных</p>
              )
            ) : null}
            <p>Долги: {debtsTotal} ₽</p>
            <p>Баланс: {balanceTotal} ₽</p>
            <p>Итог дня (нижний): {bottomDayTotal} ₽</p>
          </div>
        </Card>
        <Card title="Период отчёта">
          <div className="mf-row">
            <Input
              label="Период с"
              type="date"
              value={reportFrom}
              onChange={(event) => onReportFromChange(event.target.value)}
            />
            <Input
              label="по"
              type="date"
              value={reportTo}
              onChange={(event) => onReportToChange(event.target.value)}
            />
          </div>
        </Card>
        <Card title="Доходы/расходы по дням">
          {reportCashflow.length ? (
            <table className="mf-table">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Доход</th>
                  <th>Расход</th>
                  <th>Итог</th>
                </tr>
              </thead>
              <tbody>
                {reportCashflow.map((row) => (
                  <tr key={row.date}>
                    <td>{row.date}</td>
                    <td>{row.income_total} ₽</td>
                    <td>{row.expense_total} ₽</td>
                    <td>{row.net_total} ₽</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>Нет данных</p>
          )}
        </Card>
        <Card title="Динамика баланса">
          {reportBalance.length ? (
            <table className="mf-table">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Остаток</th>
                  <th>Долги</th>
                  <th>Баланс</th>
                  <th>Итог за день</th>
                </tr>
              </thead>
              <tbody>
                {reportBalance.map((row) => (
                  <tr key={row.date}>
                    <td>{row.date}</td>
                    <td>{row.assets_total} ₽</td>
                    <td>{row.debts_total} ₽</td>
                    <td>{row.balance} ₽</td>
                    <td>
                      {row.delta_balance >= 0 ? "+" : ""}
                      {row.delta_balance} ₽
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>Нет данных</p>
          )}
        </Card>
        <Card title="Долги сейчас">
          <p>
            Кредитки/рассрочки: {reportSummary?.debt_cards_total ?? 0} ₽
          </p>
          <p>Долги людям: {reportSummary?.debt_other_total ?? 0} ₽</p>
        </Card>
        <Card title="Цели (активные)">
          {reportSummary?.goals_active?.length ? (
            <table className="mf-table">
              <thead>
                <tr>
                  <th>Цель</th>
                  <th>Прогресс</th>
                  <th>Осталось</th>
                  <th>Дедлайн</th>
                </tr>
              </thead>
              <tbody>
                {reportSummary.goals_active.map((goal, index) => (
                  <tr key={`${goal.title}-${index}`}>
                    <td>{goal.title}</td>
                    <td>
                      {goal.current} / {goal.target} ₽
                    </td>
                    <td>{normalizeReportGoalRemaining(goal)} ₽</td>
                    <td>{goal.deadline ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>Нет активных целей</p>
          )}
        </Card>
      </>
    ) : (
      <>
        <Card title="Быстрые карточки">
          <div className="mf-stack">
            <p>Доходы: {monthIncomeTotal} ₽</p>
            <p>Расходы: {monthExpenseTotal} ₽</p>
            <p>Итог месяца: {monthNetTotal} ₽</p>
            <p>Средний итог/день: {monthAvgNet} ₽</p>
          </div>
        </Card>
        <Card title="Месяц">
          <Input
            label="Месяц"
            type="month"
            value={selectedMonth}
            onChange={(event) => onSelectedMonthChange(event.target.value)}
          />
        </Card>
        <Card title="Дни месяца">
          {monthReport?.days?.length ? (
            <table className="mf-table">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Верхний итог</th>
                  <th>Нижний итог</th>
                  <th>Сверка</th>
                </tr>
              </thead>
              <tbody>
                {monthReport.days.map((row: MonthReportDay) => (
                  <tr key={row.date}>
                    <td>{row.date}</td>
                    <td>{row.top_total} ₽</td>
                    <td>{row.bottom_total} ₽</td>
                    <td>{renderMonthReconcileStatus(row.diff)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>Нет данных</p>
          )}
        </Card>
      </>
    )}
  </div>
  );
};

type SettingsTabProps = {
  budgets: Budget[];
  activeBudgetId: string | null;
  onBudgetChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  accounts: Account[];
  categories: Category[];
  renderCategoryTree: (parentId: string | null) => JSX.Element | null;
  rules: Rule[];
  getAccountLabel: (accountId: string | null | undefined) => string;
  getCategoryLabel: (categoryId: string | null | undefined) => string;
  getTagLabel: (tag: "one_time" | "subscription" | null | undefined) => string;
  onDeleteRule: (ruleId: string) => void;
  onCreateRule: (event: FormEvent<HTMLFormElement>) => void;
  rulePattern: string;
  onRulePatternChange: (value: string) => void;
  ruleAccountId: string;
  onRuleAccountChange: (value: string) => void;
  ruleCategoryId: string;
  onRuleCategoryChange: (value: string) => void;
  ruleTag: "one_time" | "subscription";
  onRuleTagChange: (value: "one_time" | "subscription") => void;
  goals: Goal[];
  normalizeGoalRemaining: (goal: Goal) => number;
  getGoalStrategy: (goal: Goal) => {
    daysLeft: number;
    remaining: number;
    perDay: number;
    perWeek: number;
  } | null;
  onGoalAdjust: (goalId: string, delta: number) => void;
  onGoalClose: (goalId: string) => void;
  onGoalArchive: (goalId: string) => void;
  onDeleteGoal: (goalId: string) => void;
  onCreateGoal: (event: FormEvent<HTMLFormElement>) => void;
  goalTitle: string;
  onGoalTitleChange: (value: string) => void;
  goalTargetAmount: string;
  onGoalTargetAmountChange: (value: string) => void;
  goalDeadline: string;
  onGoalDeadlineChange: (value: string) => void;
  onCreateAccount: (event: FormEvent<HTMLFormElement>) => void;
  accountName: string;
  onAccountNameChange: (value: string) => void;
  accountActiveFrom: string;
  onAccountActiveFromChange: (value: string) => void;
  accountInitialAmount: string;
  onAccountInitialAmountChange: (value: string) => void;
  accountKind: string;
  onAccountKindChange: (value: string) => void;
  accountErrorDetails: FormErrorDetails | null;
  onCreateCategory: (event: FormEvent<HTMLFormElement>) => void;
  categoryName: string;
  onCategoryNameChange: (value: string) => void;
  categoryParent: string;
  onCategoryParentChange: (value: string) => void;
  categoryErrorDetails: FormErrorDetails | null;
  onResetAll: () => void;
  onLogout: () => void;
};

const SettingsTab = ({
  rules,
  getAccountLabel,
  getCategoryLabel,
  getTagLabel,
  onDeleteRule,
  onCreateRule,
  rulePattern,
  onRulePatternChange,
  ruleAccountId,
  onRuleAccountChange,
  ruleCategoryId,
  onRuleCategoryChange,
  ruleTag,
  onRuleTagChange,
  onResetAll,
  accounts,
  categories,
}: SettingsTabProps) => (
  <div className="mf-stack">
    <Card title="Правила автокатегоризации">
      {rules.length ? (
        <table className="mf-table">
          <thead>
            <tr>
              <th>Паттерн</th>
              <th>Счет</th>
              <th>Категория</th>
              <th>Тег</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.id}>
                <td>{rule.pattern}</td>
                <td>{getAccountLabel(rule.account_id)}</td>
                <td>{getCategoryLabel(rule.category_id)}</td>
                <td>{getTagLabel(rule.tag)}</td>
                <td>
                  <Button
                    variant="danger"
                    className="mf-button--small"
                    onClick={() => window.confirm("Удалить правило?") && onDeleteRule(rule.id)}
                  >
                    Удалить
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>Правил пока нет</p>
      )}
            <form className="mf-stack" onSubmit={onCreateRule}>
        <Input
          label="Шаблон"
          type="text"
          value={rulePattern}
          onChange={(event) => onRulePatternChange(event.target.value)}
          required
        />
        <label className="mf-input">
          <span className="mf-input__label">Счет</span>
          <select
            className="mf-select"
            value={ruleAccountId}
            onChange={(event) => onRuleAccountChange(event.target.value)}
          >
            <option value="">Не задан</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </label>
        <label className="mf-input">
          <span className="mf-input__label">Категория</span>
          <select
            className="mf-select"
            value={ruleCategoryId}
            onChange={(event) => onRuleCategoryChange(event.target.value)}
          >
            <option value="">Не задана</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
        <label className="mf-input">
          <span className="mf-input__label">Тег</span>
          <select
            className="mf-select"
            value={ruleTag}
            onChange={(event) =>
              onRuleTagChange(
                event.target.value as "one_time" | "subscription",
              )
            }
          >
            <option value="one_time">Разовый</option>
            <option value="subscription">Подписка</option>
          </select>
        </label>
        <Button type="submit">Добавить правило</Button>
      </form>
    </Card>
    <Card title="Сброс данных">
      <div className="mf-row" style={{ justifyContent: "flex-start" }}>
        <Button variant="danger" onClick={onResetAll}>Обнулить всё</Button>
      </div>
    </Card>
  </div>
);
