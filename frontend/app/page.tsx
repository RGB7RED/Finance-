"use client";

import {
  Fragment,
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
  authTelegram,
  applyRules,
  createAccount,
  createCategory,
  createDebtOther,
  createGoal,
  createRule,
  createTransaction,
  deleteRule,
  deleteGoal,
  deleteTransaction,
  ensureDefaultBudgets,
  getDailyState,
  getApiBaseUrl,
  getExpensesByCategoryReport,
  getMe,
  getMonthReport,
  getReconcile,
  getReportBalance,
  getReportCashflow,
  getReportSummary,
  isUnauthorized,
  listAccounts,
  listBudgets,
  listCategories,
  listGoals,
  listRules,
  listTransactions,
  resetBudget,
  updateGoal,
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

export default function HomePage() {
  const [status, setStatus] = useState<Status>("loading");
  const [viewMode, setViewMode] = useState<"day" | "month">("day");
  const [token, setTokenState] = useState<string | null>(null);
  const [message, setMessage] = useState<string>("");
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [activeBudgetId, setActiveBudgetId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [dailyState, setDailyState] = useState<DailyState | null>(null);
  const [reconcileSummary, setReconcileSummary] =
    useState<ReconcileSummary | null>(null);
  const [dailyStateForm, setDailyStateForm] = useState({
    debt_cards_total: "",
    debt_other_total: "",
  });
  const [debtsDirty, setDebtsDirty] = useState({
    creditCards: false,
    peopleDebts: false,
  });
  const [dailyStateAccounts, setDailyStateAccounts] = useState<
    (DailyStateAccount & { amountText: string; amount: number })[]
  >([]);
  const [accountName, setAccountName] = useState("");
  const [accountKind, setAccountKind] = useState("cash");
  const [categoryName, setCategoryName] = useState("");
  const [categoryParent, setCategoryParent] = useState("");
  const [selectedDate, setSelectedDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [reportFrom, setReportFrom] = useState(
    () => getDefaultReportRange().from,
  );
  const [reportTo, setReportTo] = useState(
    () => getDefaultReportRange().to,
  );
  const [reportCashflow, setReportCashflow] = useState<CashflowDay[]>([]);
  const [reportBalance, setReportBalance] = useState<BalanceDay[]>([]);
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
  const [quickAdjustErrorDetails, setQuickAdjustErrorDetails] =
    useState<FormErrorDetails | null>(null);
  const [quickAdjustError, setQuickAdjustError] = useState<string | null>(null);
  const [isQuickAdjusting, setIsQuickAdjusting] = useState(false);
  const [lastQuickAdjustClick, setLastQuickAdjustClick] = useState("");

  const setDailyStateFromData = (state: DailyState) => {
    setDailyState(state);
    setDailyStateForm({
      debt_cards_total: String(state.debts?.credit_cards ?? 0),
      debt_other_total: String(state.debts?.people_debts ?? 0),
    });
    setDebtsDirty({ creditCards: false, peopleDebts: false });
    setDailyStateAccounts(
      state.accounts.map((account) => ({
        ...account,
        amount: account.amount ?? 0,
        amountText: String(account.amount ?? 0),
      })),
    );
  };

  const parseAmountFromText = (value: string): number | null => {
    const normalized = value.replace(/[\s\u00a0]/g, "").replace(/[^\d-]+/g, "");
    const match = normalized.match(/-?\d+/);
    if (!match) {
      return null;
    }
    const parsed = Number.parseInt(match[0], 10);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const parseAmount = (value: string): number =>
    parseAmountFromText(value) ?? 0;

  const parseAmountOrNull = (value: string): number | null => {
    if (!value.trim()) {
      return null;
    }
    return parseAmountFromText(value);
  };

  const buildDebtsPayload = () => {
    if (!debtsDirty.creditCards && !debtsDirty.peopleDebts) {
      return undefined;
    }
    const creditCards = parseAmountOrNull(dailyStateForm.debt_cards_total);
    const peopleDebts = parseAmountOrNull(dailyStateForm.debt_other_total);
    if (creditCards === null && peopleDebts === null) {
      return undefined;
    }
    const debts: { credit_cards?: number; people_debts?: number } = {};
    if (debtsDirty.creditCards && creditCards !== null) {
      debts.credit_cards = creditCards;
    }
    if (debtsDirty.peopleDebts && peopleDebts !== null) {
      debts.people_debts = peopleDebts;
    }
    return Object.keys(debts).length ? debts : undefined;
  };

  const getAccountCurrentValue = (
    account: DailyStateAccount & { amountText: string; amount: number },
  ): number => {
    return account.amount ?? 0;
  };

  const buildQuickAdjustInsufficientMessage = (
    currentValue: number,
    delta: number,
    nextValue: number,
  ) =>
    `Недостаточно средств: текущий остаток ${currentValue} ₽, нужно изменить на ${delta} ₽, получится ${nextValue} ₽`;

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

  const loadReports = async () => {
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
  };

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
          loadedGoals,
          loadedRules,
        ] = await Promise.all([
          listAccounts(resolvedToken, nextBudgetId),
          listCategories(resolvedToken, nextBudgetId),
          listTransactions(resolvedToken, nextBudgetId, selectedDate),
          listGoals(resolvedToken, nextBudgetId),
          listRules(resolvedToken, nextBudgetId),
        ]);
        await loadDailyStateData(resolvedToken, nextBudgetId, selectedDate);
        setAccounts(loadedAccounts);
        setCategories(loadedCategories);
        setTransactions(loadedTransactions);
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
    setGoals([]);
    setRules([]);
    setDailyState(null);
    setReconcileSummary(null);
    setReportCashflow([]);
    setReportBalance([]);
    setReportSummary(null);
    setMonthReport(null);
    setSelectedMonth(getDefaultMonth());
    setDailyStateForm({
      debt_cards_total: "",
      debt_other_total: "",
    });
    setDailyStateAccounts([]);
    setDebtOtherAmount("");
    setDebtOtherDirection("borrowed");
    setDebtOtherAccountId("");
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
      if (tx.type === "income") {
        return total + tx.amount;
      }
      if (tx.type === "expense") {
        return total - tx.amount;
      }
      return total;
    }, 0);
  }, [transactions]);

  const cashTotal = useMemo(() => {
    return dailyStateAccounts.reduce((total, account) => {
      if (account.kind === "cash") {
        return total + parseAmount(account.amountText);
      }
      return total;
    }, 0);
  }, [dailyStateAccounts]);

  const noncashTotal = useMemo(() => {
    return dailyStateAccounts.reduce((total, account) => {
      if (account.kind === "bank") {
        return total + parseAmount(account.amountText);
      }
      return total;
    }, 0);
  }, [dailyStateAccounts]);

  const assetsTotal = useMemo(() => {
    return cashTotal + noncashTotal;
  }, [cashTotal, noncashTotal]);

  const debtsTotal = useMemo(() => {
    return (
      parseAmount(dailyStateForm.debt_cards_total) +
      parseAmount(dailyStateForm.debt_other_total)
    );
  }, [dailyStateForm.debt_cards_total, dailyStateForm.debt_other_total]);

  const balanceTotal = useMemo(() => {
    return assetsTotal - debtsTotal;
  }, [assetsTotal, debtsTotal]);

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
  const isReconciled = reconcileSummary?.is_ok ?? true;
  const deltaToApply = -reconcileDiff;
  const isReconciledOrClose = isReconciled || Math.abs(deltaToApply) <= 1;
  const shouldShowQuickAdjust = Math.abs(deltaToApply) > 1;
  const renderMonthReconcileStatus = (diff: number) => {
    if (Math.abs(diff) <= 1) {
      return "OK";
    }
    return diff > 0 ? `+${diff} ₽` : `${diff} ₽`;
  };

  const monthIncomeTotal = monthReport?.month_income ?? 0;
  const monthExpenseTotal = monthReport?.month_expense ?? 0;
  const monthNetTotal = monthReport?.month_net ?? 0;
  const monthAvgNet = monthReport?.avg_net_per_day ?? 0;
  const hasAccounts = accounts.length > 0;

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
        loadedGoals,
        loadedRules,
      ] = await Promise.all([
        listAccounts(token, nextBudgetId),
        listCategories(token, nextBudgetId),
        listTransactions(token, nextBudgetId, selectedDate),
        listGoals(token, nextBudgetId),
        listRules(token, nextBudgetId),
      ]);
      await loadDailyStateData(token, nextBudgetId, selectedDate);
      setAccounts(loadedAccounts);
      setCategories(loadedCategories);
      setTransactions(loadedTransactions);
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
        const loadedTransactions = await listTransactions(
          token,
          activeBudgetId,
          selectedDate,
        );
        await loadDailyStateData(token, activeBudgetId, selectedDate);
        setTransactions(loadedTransactions);
      } catch (error) {
        setMessage(buildErrorMessage("Не удалось загрузить операции", error));
      }
    };

    void loadTransactionsForDate();
  }, [token, activeBudgetId, selectedDate]);

  useEffect(() => {
    void loadReports();
  }, [token, activeBudgetId, reportFrom, reportTo, reportExpensesLimit]);

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
        tag: incomeTag,
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
      await loadDailyStateData(token, activeBudgetId, selectedDate);
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
      await loadDailyStateData(token, activeBudgetId, selectedDate);
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
      await loadDailyStateData(token, activeBudgetId, selectedDate);
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
      await loadDailyStateData(token, activeBudgetId, selectedDate);
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось удалить операцию", error));
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
    try {
      await createDebtOther(token, {
        budget_id: activeBudgetId,
        amount,
        direction: debtOtherDirection,
        account_id: debtOtherAccountId,
        date: selectedDate,
      });
      setDebtOtherAmount("");
      const [updatedAccounts] = await Promise.all([
        listAccounts(token, activeBudgetId),
        loadDailyStateData(token, activeBudgetId, selectedDate),
      ]);
      setAccounts(updatedAccounts);
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
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось создать цель", error));
    }
  };

  const handleGoalQuickAdd = async (goalId: string, delta: number) => {
    if (!token || !activeBudgetId) {
      return;
    }
    const goal = goals.find((item) => item.id === goalId);
    if (!goal) {
      return;
    }
    const nextAmount = goal.current_amount + delta;
    setMessage("");
    try {
      await updateGoal(token, goalId, { current_amount: nextAmount });
      const updatedGoals = await listGoals(token, activeBudgetId);
      setGoals(updatedGoals);
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось обновить цель", error));
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

  const handleDailyStateChange = (
    field: keyof typeof dailyStateForm,
    value: string,
  ) => {
    const parsedValue = parseAmountOrNull(value);
    if (parsedValue !== null && parsedValue < 0) {
      return;
    }
    setDailyStateForm((prev) => ({ ...prev, [field]: value }));
    setDebtsDirty((prev) => ({
      ...prev,
      ...(field === "debt_cards_total" ? { creditCards: true } : {}),
      ...(field === "debt_other_total" ? { peopleDebts: true } : {}),
    }));
  };

  const handleDailyStateAccountChange = (
    accountId: string,
    value: string,
  ) => {
    const parsedValue = parseAmountOrNull(value);
    if (parsedValue !== null && parsedValue < 0) {
      return;
    }
    setDailyStateAccounts((prev) =>
      prev.map((account) =>
        account.account_id === accountId
          ? {
              ...account,
              amountText: value,
            }
          : account,
      ),
    );
  };

  const handleSaveDailyState = async () => {
    if (!token || !activeBudgetId) {
      return;
    }
    setMessage("");
    try {
      const debts = buildDebtsPayload();
      const payload = {
        budget_id: activeBudgetId,
        date: selectedDate,
        accounts: dailyStateAccounts.map((account) => ({
          account_id: account.account_id,
          amount: parseAmount(account.amountText),
        })),
        debts,
      };
      const updated = await updateDailyState(token, payload);
      setDailyStateFromData(updated);
      await loadDailyStateData(token, activeBudgetId, selectedDate);
      await loadReports();
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось сохранить состояние дня", error));
    }
  };

  const handleQuickAdjust = async (accountId: string, delta: number) => {
    const clickStamp = new Date().toISOString();
    setLastQuickAdjustClick(clickStamp);
    console.log("[quick-adjust] click", {
      clickStamp,
      accountId,
      delta,
    });
    if (!activeBudgetId || !selectedDate || !accountId) {
      setQuickAdjustErrorDetails(null);
      setQuickAdjustError("missing budget/date/account");
      return;
    }
    if (!token) {
      console.log("[quick-adjust] guard: missing token/budget", {
        tokenMissing: !token,
        activeBudgetMissing: !activeBudgetId,
      });
      setQuickAdjustErrorDetails(null);
      setQuickAdjustError("missing auth token");
      return;
    }
    if (isQuickAdjusting) {
      console.log("[quick-adjust] guard: isQuickAdjusting", {
        isQuickAdjusting,
      });
      return;
    }
    const currentAccount = dailyStateAccounts.find(
      (account) => account.account_id === accountId,
    );
    if (!currentAccount) {
      setQuickAdjustErrorDetails(null);
      setQuickAdjustError("missing budget/date/account");
      return;
    }
    const currentValue = currentAccount.amount ?? 0;
    const nextValue = currentValue + delta;
    if (nextValue < 0) {
      const message = buildQuickAdjustInsufficientMessage(
        currentValue,
        delta,
        nextValue,
      );
      console.log("[quick-adjust] guard: nextValue < 0", {
        currentValue,
        nextValue,
        delta,
      });
      setQuickAdjustErrorDetails(null);
      setQuickAdjustError(message);
      return;
    }
    const updatedAccounts = dailyStateAccounts.map((account) =>
      account.account_id === accountId
        ? { ...account, amountText: String(nextValue), amount: nextValue }
        : account,
    );
    setDailyStateAccounts(updatedAccounts);
    setMessage("");
    setQuickAdjustErrorDetails(null);
    setQuickAdjustError(null);
    setIsQuickAdjusting(true);
    try {
      const debts = buildDebtsPayload();
      console.log("[quick-adjust] sending update", {
        budgetId: activeBudgetId,
        date: selectedDate,
        accountId,
        nextValue,
      });
      await updateDailyState(token, {
        budget_id: activeBudgetId,
        date: selectedDate,
        accounts: updatedAccounts.map((account) => ({
          account_id: account.account_id,
          amount: parseAmount(account.amountText),
        })),
        debts,
      });
      console.log("[quick-adjust] updateDailyState ok");
      await loadDailyStateData(token, activeBudgetId, selectedDate);
      await loadReports();
    } catch (error) {
      const apiError = error as Error & { status?: number; text?: string };
      setQuickAdjustErrorDetails({
        httpStatus: apiError.status,
        responseText: apiError.text,
      });
      setQuickAdjustError(apiError.message || String(error));
      setMessage(buildErrorMessage("Не удалось обновить состояние дня", error));
    } finally {
      console.log("[quick-adjust] finally: reset isQuickAdjusting");
      setIsQuickAdjusting(false);
    }
  };

  const handleResetBudget = async () => {
    if (!token || !activeBudgetId) {
      return;
    }
    const confirmed = window.confirm(
      "Обнулить все данные текущего бюджета?",
    );
    if (!confirmed) {
      return;
    }
    setMessage("");
    try {
      await resetBudget(token, activeBudgetId);
      const [
        loadedAccounts,
        loadedCategories,
        loadedTransactions,
        loadedGoals,
        loadedRules,
      ] = await Promise.all([
        listAccounts(token, activeBudgetId),
        listCategories(token, activeBudgetId),
        listTransactions(token, activeBudgetId, selectedDate),
        listGoals(token, activeBudgetId),
        listRules(token, activeBudgetId),
      ]);
      await loadDailyStateData(token, activeBudgetId, selectedDate);
      setAccounts(loadedAccounts);
      setCategories(loadedCategories);
      setTransactions(loadedTransactions);
      setGoals(loadedGoals);
      setRules(loadedRules);
      await loadReports();
    } catch (error) {
      setMessage(buildErrorMessage("Не удалось обнулить бюджет", error));
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
            <h2>Режим просмотра</h2>
            <div>
              <label>
                <input
                  type="radio"
                  name="view-mode"
                  value="day"
                  checked={viewMode === "day"}
                  onChange={() => setViewMode("day")}
                />
                День
              </label>
              <label>
                <input
                  type="radio"
                  name="view-mode"
                  value="month"
                  checked={viewMode === "month"}
                  onChange={() => setViewMode("month")}
                />
                Месяц
              </label>
            </div>
          </section>

          <section>
            <h2>Отчёты</h2>
            {viewMode === "day" ? (
              <>
                <div>
                  <h3>Быстрые карточки</h3>
                  <ul>
                    <li>Остаток: {assetsTotal} ₽</li>
                    <li>Долги: {debtsTotal} ₽</li>
                    <li>Баланс: {balanceTotal} ₽</li>
                    <li>Итог дня (нижний): {bottomDayTotal} ₽</li>
                    <li>Итог дня (верхний): {topDayTotal} ₽</li>
                  </ul>
                </div>
                <div>
                  <label>
                    Период с:
                    <input
                      type="date"
                      value={reportFrom}
                      onChange={(event) => setReportFrom(event.target.value)}
                    />
                  </label>
                  <label>
                    по:
                    <input
                      type="date"
                      value={reportTo}
                      onChange={(event) => setReportTo(event.target.value)}
                    />
                  </label>
                </div>
                <div>
                  <h3>Доходы/расходы по дням</h3>
                  {reportCashflow.length ? (
                    <table>
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
                </div>
                <div>
                  <h3>Динамика баланса</h3>
                  {reportBalance.length ? (
                    <table>
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
                </div>
                <div>
                  <h3>Расходы по категориям</h3>
                  <label>
                    Top N:
                    <select
                      value={reportExpensesLimit}
                      onChange={handleReportExpensesLimitChange}
                    >
                      <option value={5}>5</option>
                      <option value={10}>10</option>
                      <option value={20}>20</option>
                    </select>
                  </label>
                  {reportExpensesByCategory?.items?.length ? (
                    <table>
                      <thead>
                        <tr>
                          <th>Категория</th>
                          <th>Сумма</th>
                          <th>Доля %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reportExpensesByCategory.items.map((item) => {
                          const isExpanded =
                            expandedReportCategories[item.category_id];
                          return (
                            <Fragment key={item.category_id}>
                              <tr>
                                <td>
                                  {item.children.length ? (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        toggleReportCategory(item.category_id)
                                      }
                                    >
                                      {isExpanded ? "Свернуть" : "Развернуть"}
                                    </button>
                                  ) : null}{" "}
                                  {item.category_name}
                                </td>
                                <td>{item.amount} ₽</td>
                                <td>
                                  {(item.share * 100).toFixed(1)}
                                  %
                                </td>
                              </tr>
                              {isExpanded
                                ? item.children.map((child) => (
                                    <tr key={child.category_id}>
                                      <td>— {child.category_name}</td>
                                      <td>{child.amount} ₽</td>
                                      <td>
                                        {(child.share * 100).toFixed(1)}%
                                      </td>
                                    </tr>
                                  ))
                                : null}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <p>Нет данных</p>
                  )}
                </div>
                <div>
                  <h3>Долги сейчас</h3>
                  <p>
                    Кредитки/рассрочки:{" "}
                    {reportSummary?.debt_cards_total ?? 0} ₽
                  </p>
                  <p>Долги людям: {reportSummary?.debt_other_total ?? 0} ₽</p>
                </div>
                <div>
                  <h3>Цели (активные)</h3>
                  {reportSummary?.goals_active?.length ? (
                    <table>
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
                </div>
              </>
            ) : (
              <>
                <div>
                  <h3>Быстрые карточки</h3>
                  <ul>
                    <li>Доходы: {monthIncomeTotal} ₽</li>
                    <li>Расходы: {monthExpenseTotal} ₽</li>
                    <li>Итог месяца: {monthNetTotal} ₽</li>
                    <li>Средний итог/день: {monthAvgNet} ₽</li>
                  </ul>
                </div>
                <div>
                  <label>
                    Месяц:
                    <input
                      type="month"
                      value={selectedMonth}
                      onChange={(event) => setSelectedMonth(event.target.value)}
                    />
                  </label>
                </div>
                <div>
                  <h3>Дни месяца</h3>
                  {monthReport?.days?.length ? (
                    <table>
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
                </div>
              </>
            )}
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
            <h2>Мои правила</h2>
            {rules.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Шаблон</th>
                    <th>Счет</th>
                    <th>Категория</th>
                    <th>Тег</th>
                    <th></th>
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
                        <button
                          type="button"
                          onClick={() => handleDeleteRule(rule.id)}
                        >
                          Удалить
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p>Нет правил</p>
            )}
            <form onSubmit={handleCreateRule}>
              <label>
                Шаблон:
                <input
                  type="text"
                  value={rulePattern}
                  onChange={(event) => setRulePattern(event.target.value)}
                  required
                />
              </label>
              <label>
                Счет:
                <select
                  value={ruleAccountId}
                  onChange={(event) => setRuleAccountId(event.target.value)}
                >
                  <option value="">Не выбран</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Категория:
                <select
                  value={ruleCategoryId}
                  onChange={(event) => setRuleCategoryId(event.target.value)}
                >
                  <option value="">Не выбрана</option>
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
                  value={ruleTag}
                  onChange={(event) =>
                    setRuleTag(
                      event.target.value as "one_time" | "subscription",
                    )
                  }
                >
                  <option value="one_time">Разовый</option>
                  <option value="subscription">Подписка</option>
                </select>
              </label>
              <button type="submit">Добавить правило</button>
            </form>
          </section>

          {viewMode === "day" && (
            <>
              {!hasAccounts ? (
                <section>
                  <h2>Состояние дня (верхняя таблица)</h2>
                  <p>Создайте хотя бы один счёт, чтобы вести операции.</p>
                </section>
              ) : (
                <>
                  <section>
                    <h2>Состояние дня (верхняя таблица)</h2>
                    <div>
                      {dailyStateAccounts.map((account) => (
                        <label key={account.account_id}>
                          {account.name} ({account.kind}):
                          <input
                            type="number"
                            min="0"
                            value={account.amountText}
                            onChange={(event) =>
                              handleDailyStateAccountChange(
                                account.account_id,
                                event.target.value,
                              )
                            }
                          />
                        </label>
                      ))}
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
                    <p>Наличка (авто): {cashTotal} ₽</p>
                    <p>Безнал (авто): {noncashTotal} ₽</p>
                    <p>Остаток (авто): {assetsTotal} ₽</p>
                    <p>Долги: {debtsTotal} ₽</p>
                    <p>Баланс (авто): {balanceTotal} ₽</p>
                    <p>Итог за день (верхний): {topDayTotal} ₽</p>
                    <button type="button" onClick={handleSaveDailyState}>
                      Сохранить состояние дня
                    </button>
                  </section>

                  <section>
                    <h2>Долги людям</h2>
                    {!hasAccounts && (
                      <p>Сначала добавьте хотя бы один счёт.</p>
                    )}
                    <form onSubmit={handleCreateDebtOther}>
                      <label>
                        Направление:
                        <select
                          value={debtOtherDirection}
                          onChange={(event) =>
                            setDebtOtherDirection(
                              event.target.value as "borrowed" | "repaid",
                            )
                          }
                        >
                          <option value="borrowed">Взял в долг</option>
                          <option value="repaid">Отдал долг</option>
                        </select>
                      </label>
                      <label>
                        Куда пришли/откуда ушли:
                        <select
                          value={debtOtherAccountId}
                          onChange={(event) =>
                            setDebtOtherAccountId(event.target.value)
                          }
                          disabled={!hasAccounts}
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
                          value={debtOtherAmount}
                          onChange={(event) =>
                            setDebtOtherAmount(event.target.value)
                          }
                          required
                          disabled={!hasAccounts}
                        />
                      </label>
                      <label>
                        Дата:
                        <input type="date" value={selectedDate} readOnly />
                      </label>
                      <button type="submit" disabled={!hasAccounts}>
                        Сохранить
                      </button>
                    </form>
                    {debtOtherErrorDetails && (
                      <div>
                        <p>
                          debt_http_status:{" "}
                          {debtOtherErrorDetails.httpStatus ?? "unknown"}
                        </p>
                        <p>
                          debt_response_text:{" "}
                          {debtOtherErrorDetails.responseText ?? "unknown"}
                        </p>
                      </div>
                    )}
                  </section>
                </>
              )}
            </>
          )}

          <section>
            <h2>Цели</h2>
            {goals.length ? (
              <ul>
                {goals.map((goal) => {
                  const remaining = normalizeGoalRemaining(goal);
                  const strategy = getGoalStrategy(goal);
                  const isActive = goal.status === "active";
                  return (
                    <li key={goal.id}>
                      <div>
                        <strong>{goal.title}</strong>
                        <p>
                          Прогресс: {goal.current_amount} /{" "}
                          {goal.target_amount} ₽
                        </p>
                        <p>Осталось: {remaining} ₽</p>
                        {goal.deadline && <p>Дедлайн: {goal.deadline}</p>}
                        <p>Статус: {goal.status}</p>
                        {strategy && (
                          <div>
                            <p>Нужно откладывать {strategy.perDay} ₽/день</p>
                            <p>
                              Нужно откладывать {strategy.perWeek} ₽/неделю
                            </p>
                          </div>
                        )}
                      </div>
                      <div>
                        <button
                          type="button"
                          onClick={() => handleGoalQuickAdd(goal.id, 100)}
                          disabled={!isActive}
                        >
                          +100
                        </button>
                        <button
                          type="button"
                          onClick={() => handleGoalQuickAdd(goal.id, 500)}
                          disabled={!isActive}
                        >
                          +500
                        </button>
                        <button
                          type="button"
                          onClick={() => handleGoalQuickAdd(goal.id, 1000)}
                          disabled={!isActive}
                        >
                          +1000
                        </button>
                        <button
                          type="button"
                          onClick={() => handleGoalClose(goal.id)}
                          disabled={!isActive}
                        >
                          Закрыть
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteGoal(goal.id)}
                        >
                          Удалить
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p>Нет целей</p>
            )}
            <form onSubmit={handleCreateGoal}>
              <label>
                Цель:
                <input
                  type="text"
                  value={goalTitle}
                  onChange={(event) => setGoalTitle(event.target.value)}
                  required
                />
              </label>
              <label>
                Сумма:
                <input
                  type="number"
                  min="1"
                  value={goalTargetAmount}
                  onChange={(event) => setGoalTargetAmount(event.target.value)}
                  required
                />
              </label>
              <label>
                Дедлайн:
                <input
                  type="date"
                  value={goalDeadline}
                  onChange={(event) => setGoalDeadline(event.target.value)}
                />
              </label>
              <button type="submit">Создать цель</button>
            </form>
          </section>

          {viewMode === "day" && (
            <>
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
                                {categoryName
                                  ? `(${categoryName})`
                                  : "(Без категории)"}
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
                <p>Итог за день (нижний): {bottomDayTotal} ₽</p>
              </section>

              {hasAccounts && (
                <section>
                  <h2>Сверка</h2>
                  <p style={{ fontSize: "12px", opacity: 0.7 }}>
                    lastQuickAdjustClick: {lastQuickAdjustClick || "—"}
                  </p>
                  <p>
                    Верхний итог: {topDayTotal} ₽, Нижний итог: {bottomDayTotal}{" "}
                    ₽, Разница: {reconcileDiff} ₽
                  </p>
                  {isReconciledOrClose ? (
                    <p>Сверка: OK</p>
                  ) : (
                    <>
                      <p>Сверка: расхождение {reconcileDiffAbs} ₽</p>
                      <p>
                        {reconcileDiff > 1
                          ? "Остатки больше, чем операции. Нужна корректировка."
                          : "Остатки меньше, чем операции. Нужна корректировка."}
                      </p>
                      <div>
                        {shouldShowQuickAdjust &&
                          dailyStateAccounts.map((account) => (
                            <div key={account.account_id}>
                              {(() => {
                                const currentValue =
                                  getAccountCurrentValue(account);
                                const nextValue = currentValue + deltaToApply;
                                const isInsufficient = nextValue < 0;
                                const insufficientMessage =
                                  buildQuickAdjustInsufficientMessage(
                                    currentValue,
                                    deltaToApply,
                                    nextValue,
                                  );
                                return (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleQuickAdjust(
                                          account.account_id,
                                          deltaToApply,
                                        )
                                      }
                                      disabled={
                                        isQuickAdjusting || isInsufficient
                                      }
                                      title={
                                        isInsufficient
                                          ? insufficientMessage
                                          : undefined
                                      }
                                    >
                                      {isQuickAdjusting
                                        ? "Применяю…"
                                        : `Изменить ${account.name} на ${deltaToApply} ₽`}
                                    </button>
                                    {isInsufficient && (
                                      <p>{insufficientMessage}</p>
                                    )}
                                  </>
                                );
                              })()}
                            </div>
                          ))}
                      </div>
                      {quickAdjustErrorDetails && (
                        <div>
                          <p>
                            http_status:{" "}
                            {quickAdjustErrorDetails.httpStatus ?? "unknown"}
                          </p>
                          <p>
                            response_text:{" "}
                            {quickAdjustErrorDetails.responseText ?? "unknown"}
                          </p>
                        </div>
                      )}
                      {quickAdjustError && <p>{quickAdjustError}</p>}
                    </>
                  )}
                </section>
              )}
            </>
          )}

          <section>
            <h2>Добавить доход</h2>
            {!hasAccounts && (
              <p>Создайте хотя бы один счёт, чтобы добавлять операции.</p>
            )}
            <form onSubmit={handleCreateIncome}>
              <label>
                Счет:
                <select
                  value={incomeAccountId}
                  onChange={(event) => setIncomeAccountId(event.target.value)}
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
              <label>
                Сумма:
                <input
                  type="number"
                  min="1"
                  value={incomeAmount}
                  onChange={(event) => setIncomeAmount(event.target.value)}
                  required
                  disabled={!hasAccounts}
                />
              </label>
              <label>
                Тег:
                <select
                  value={incomeTag}
                  onChange={(event) =>
                    setIncomeTag(
                      event.target.value as "one_time" | "subscription",
                    )
                  }
                  disabled={!hasAccounts}
                >
                  <option value="one_time">Разовый</option>
                  <option value="subscription">Подписка</option>
                </select>
              </label>
              <label>
                Заметка:
                <input
                  type="text"
                  value={incomeNote}
                  onChange={(event) => setIncomeNote(event.target.value)}
                  disabled={!hasAccounts}
                />
              </label>
              <button type="submit" disabled={!hasAccounts}>
                Добавить
              </button>
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
            {!hasAccounts && (
              <p>Создайте хотя бы один счёт, чтобы добавлять операции.</p>
            )}
            <form onSubmit={handleCreateExpense}>
              <label>
                Счет:
                <select
                  value={expenseAccountId}
                  onChange={(event) => setExpenseAccountId(event.target.value)}
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
              <label>
                Сумма:
                <input
                  type="number"
                  min="1"
                  value={expenseAmount}
                  onChange={(event) => setExpenseAmount(event.target.value)}
                  required
                  disabled={!hasAccounts}
                />
              </label>
              <label>
                Категория:
                <select
                  value={expenseCategoryId}
                  onChange={(event) => setExpenseCategoryId(event.target.value)}
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
              <label>
                Тег:
                <select
                  value={expenseTag}
                  onChange={(event) =>
                    setExpenseTag(
                      event.target.value as "one_time" | "subscription",
                    )
                  }
                  disabled={!hasAccounts}
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
                  disabled={!hasAccounts}
                />
              </label>
              <button type="submit" disabled={!hasAccounts}>
                Добавить
              </button>
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
            {!hasAccounts && (
              <p>Создайте хотя бы один счёт, чтобы добавлять операции.</p>
            )}
            <form onSubmit={handleCreateTransfer}>
              <label>
                Откуда:
                <select
                  value={transferFromAccountId}
                  onChange={(event) =>
                    setTransferFromAccountId(event.target.value)
                  }
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
              <label>
                Куда:
                <select
                  value={transferToAccountId}
                  onChange={(event) =>
                    setTransferToAccountId(event.target.value)
                  }
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
              <label>
                Сумма:
                <input
                  type="number"
                  min="1"
                  value={transferAmount}
                  onChange={(event) => setTransferAmount(event.target.value)}
                  required
                  disabled={!hasAccounts}
                />
              </label>
              <label>
                Заметка:
                <input
                  type="text"
                  value={transferNote}
                  onChange={(event) => setTransferNote(event.target.value)}
                  disabled={!hasAccounts}
                />
              </label>
              <button type="submit" disabled={!hasAccounts}>
                Добавить
              </button>
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
            <button type="button" onClick={handleResetBudget}>
              Обнулить всё
            </button>
            <button type="button" onClick={handleLogout}>
              Logout
            </button>
          </section>
        </>
      )}
    </main>
  );
}
