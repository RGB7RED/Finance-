const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

export const getApiBaseUrl = (): string | undefined => API_BASE_URL;

type ApiError = Error & { status?: number; text?: string };

const buildError = (
  message: string,
  status?: number,
  text?: string,
): ApiError => {
  const error = new Error(message) as ApiError;
  if (status) {
    error.status = status;
  }
  if (text) {
    error.text = text;
  }
  return error;
};

const requestJson = async <T>(
  input: string,
  init?: RequestInit,
): Promise<T> => {
  if (!API_BASE_URL) {
    throw buildError("API недоступен");
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${input}`, {
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      ...init,
    });
  } catch (error) {
    throw buildError("API недоступен");
  }

  if (!response.ok) {
    throw buildError("Request failed", response.status);
  }

  return (await response.json()) as T;
};

type AuthError = Error & {
  code?: "HTTP_ERROR" | "NETWORK_ERROR";
  status?: number;
  text?: string;
};

const buildAuthError = (
  message: string,
  options?: { code?: AuthError["code"]; status?: number; text?: string },
): AuthError => {
  const error = new Error(message) as AuthError;
  if (options?.code) {
    error.code = options.code;
  }
  if (options?.status) {
    error.status = options.status;
  }
  if (options?.text) {
    error.text = options.text;
  }
  return error;
};

export const authTelegram = async (
  initData: string,
): Promise<{ access_token: string; token_type: string }> => {
  if (!API_BASE_URL) {
    throw buildAuthError("API недоступен");
  }

  try {
    const response = await fetch(`${API_BASE_URL}/auth/telegram`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ initData }),
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw buildAuthError("Auth failed", {
        code: "HTTP_ERROR",
        status: response.status,
        text: responseText,
      });
    }

    return (await response.json()) as {
      access_token: string;
      token_type: string;
    };
  } catch (error) {
    if (error instanceof Error && (error as AuthError).code === "HTTP_ERROR") {
      throw error;
    }
    throw buildAuthError("Network error", { code: "NETWORK_ERROR" });
  }
};

export type { AuthError };

export const getMe = async (
  token: string,
): Promise<{
  user_id: string;
  telegram_id: number;
  username?: string;
  first_name?: string;
}> =>
  requestJson("/me", {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

export const isUnauthorized = (error: unknown): boolean =>
  Boolean((error as ApiError | undefined)?.status === 401);

export type Budget = {
  id: string;
  user_id: string;
  type: "personal" | "business" | string;
  name: string;
  created_at: string;
};

export type Account = {
  id: string;
  budget_id: string;
  name: string;
  kind: string;
  currency: string | null;
  created_at: string;
};

export type Category = {
  id: string;
  budget_id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
};

export type Transaction = {
  id: string;
  budget_id: string;
  user_id: string;
  date: string;
  type: "income" | "expense" | "transfer";
  amount: number;
  account_id: string | null;
  to_account_id: string | null;
  category_id: string | null;
  tag: "one_time" | "subscription";
  note: string | null;
  created_at: string;
};

export type Rule = {
  id: string;
  budget_id: string;
  user_id: string;
  pattern: string;
  match_type: "contains";
  account_id: string | null;
  category_id: string | null;
  tag: "one_time" | "subscription" | null;
  hits: number;
  accepts: number;
  confidence: number;
  created_at: string;
};

export type Suggestion = {
  account_id: string | null;
  category_id: string | null;
  tag: "one_time" | "subscription" | null;
  confidence: number;
  pattern: string | null;
};

export type DailyState = {
  budget_id: string;
  user_id: string;
  date: string;
  as_of_date: string;
  is_carried: boolean;
  cash_total: number;
  bank_total: number;
  debt_cards_total: number;
  debt_other_total: number;
  assets_total: number;
  debts_total: number;
  balance: number;
};

export type Goal = {
  id: string;
  budget_id: string;
  user_id: string;
  title: string;
  target_amount: number;
  current_amount: number;
  deadline: string | null;
  status: "active" | "done" | "archived";
  created_at: string;
};

export type CashflowDay = {
  date: string;
  income_total: number;
  expense_total: number;
  net_total: number;
};

export type BalanceDay = {
  date: string;
  assets_total: number;
  debts_total: number;
  balance: number;
  delta_balance: number;
};

export type ReportsGoal = {
  title: string;
  target: number;
  current: number;
  deadline: string | null;
};

export type ReportsSummary = {
  debt_cards_total: number;
  debt_other_total: number;
  goals_active: ReportsGoal[];
};

export type MonthReportDay = {
  date: string;
  top_total: number;
  bottom_total: number;
  diff: number;
};

export type MonthReport = {
  month: string;
  days: MonthReportDay[];
  month_income: number;
  month_expense: number;
  month_net: number;
  avg_net_per_day: number;
};

export type ExpensesByCategoryChild = {
  category_id: string;
  category_name: string;
  amount: number;
  share: number;
};

export type ExpensesByCategoryItem = {
  category_id: string;
  category_name: string;
  amount: number;
  share: number;
  children: ExpensesByCategoryChild[];
};

export type ExpensesByCategoryReport = {
  total_expense: number;
  items: ExpensesByCategoryItem[];
};

export type ReconcileSummary = {
  date: string;
  bottom_total: number;
  top_total: number;
  diff: number;
  is_ok: boolean;
};

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
});

export const ensureDefaultBudgets = async (token: string): Promise<void> => {
  await requestJson("/budgets/ensure-defaults", {
    method: "POST",
    headers: authHeaders(token),
  });
};

export const resetBudget = async (
  token: string,
  budgetId: string,
): Promise<void> => {
  await requestJson(`/budgets/${budgetId}/reset`, {
    method: "POST",
    headers: authHeaders(token),
  });
};

export const listBudgets = async (token: string): Promise<Budget[]> =>
  requestJson("/budgets", {
    headers: authHeaders(token),
  });

export const listAccounts = async (
  token: string,
  budgetId: string,
): Promise<Account[]> => {
  const query = new URLSearchParams({ budget_id: budgetId });
  return requestJson(`/accounts?${query.toString()}`, {
    headers: authHeaders(token),
  });
};

export const createAccount = async (
  token: string,
  payload: { budget_id: string; name: string; kind: string },
): Promise<Account> => {
  if (!API_BASE_URL) {
    throw buildError("API недоступен");
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/accounts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw buildError("API недоступен");
  }

  if (!response.ok) {
    const responseText = await response.text();
    throw buildError("Request failed", response.status, responseText);
  }

  return (await response.json()) as Account;
};

export const listCategories = async (
  token: string,
  budgetId: string,
): Promise<Category[]> => {
  const query = new URLSearchParams({ budget_id: budgetId });
  return requestJson(`/categories?${query.toString()}`, {
    headers: authHeaders(token),
  });
};

export const createCategory = async (
  token: string,
  payload: { budget_id: string; name: string; parent_id?: string | null },
): Promise<Category> => {
  if (!API_BASE_URL) {
    throw buildError("API недоступен");
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/categories`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw buildError("API недоступен");
  }

  if (!response.ok) {
    const responseText = await response.text();
    throw buildError("Request failed", response.status, responseText);
  }

  return (await response.json()) as Category;
};

export const listTransactions = async (
  token: string,
  budgetId: string,
  date: string,
): Promise<Transaction[]> => {
  const query = new URLSearchParams({ budget_id: budgetId, date });
  return requestJson(`/transactions?${query.toString()}`, {
    headers: authHeaders(token),
  });
};

export const createTransaction = async (
  token: string,
  payload: {
    budget_id: string;
    type: "income" | "expense" | "transfer";
    amount: number;
    date: string;
    account_id?: string | null;
    to_account_id?: string | null;
    category_id?: string | null;
    tag: "one_time" | "subscription";
    note?: string | null;
  },
): Promise<Transaction> => {
  if (!API_BASE_URL) {
    throw buildError("API недоступен");
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw buildError("API недоступен");
  }

  if (!response.ok) {
    const responseText = await response.text();
    throw buildError("Request failed", response.status, responseText);
  }

  return (await response.json()) as Transaction;
};

export const deleteTransaction = async (
  token: string,
  id: string,
): Promise<{ status: string }> =>
  requestJson(`/transactions/${id}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });

export const listRules = async (
  token: string,
  budgetId: string,
): Promise<Rule[]> => {
  const query = new URLSearchParams({ budget_id: budgetId });
  return requestJson(`/rules?${query.toString()}`, {
    headers: authHeaders(token),
  });
};

export const createRule = async (
  token: string,
  payload: {
    budget_id: string;
    pattern: string;
    match_type?: "contains";
    account_id?: string | null;
    category_id?: string | null;
    tag?: "one_time" | "subscription" | null;
  },
): Promise<Rule> => {
  if (!API_BASE_URL) {
    throw buildError("API недоступен");
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/rules`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw buildError("API недоступен");
  }

  if (!response.ok) {
    const responseText = await response.text();
    throw buildError("Request failed", response.status, responseText);
  }

  return (await response.json()) as Rule;
};

export const deleteRule = async (
  token: string,
  id: string,
): Promise<{ status: string }> =>
  requestJson(`/rules/${id}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });

export const suggest = async (
  token: string,
  payload: { budget_id: string; note: string },
): Promise<Suggestion> => {
  if (!API_BASE_URL) {
    throw buildError("API недоступен");
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/suggest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw buildError("API недоступен");
  }

  if (!response.ok) {
    const responseText = await response.text();
    throw buildError("Request failed", response.status, responseText);
  }

  return (await response.json()) as Suggestion;
};

export const feedback = async (
  token: string,
  payload: {
    budget_id: string;
    note: string;
    accepted: boolean;
    account_id?: string | null;
    category_id?: string | null;
    tag?: "one_time" | "subscription" | null;
  },
): Promise<Rule> => {
  if (!API_BASE_URL) {
    throw buildError("API недоступен");
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/feedback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw buildError("API недоступен");
  }

  if (!response.ok) {
    const responseText = await response.text();
    throw buildError("Request failed", response.status, responseText);
  }

  return (await response.json()) as Rule;
};

export const getDailyState = async (
  token: string,
  budgetId: string,
  date: string,
): Promise<DailyState> => {
  const query = new URLSearchParams({ budget_id: budgetId, date });
  return requestJson(`/daily-state?${query.toString()}`, {
    headers: authHeaders(token),
  });
};

export const updateDailyState = async (
  token: string,
  payload: {
    budget_id: string;
    date: string;
    cash_total?: number;
    bank_total?: number;
    debt_cards_total?: number;
    debt_other_total?: number;
  },
): Promise<DailyState> => {
  if (!API_BASE_URL) {
    throw buildError("API недоступен");
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/daily-state`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw buildError("API недоступен");
  }

  if (!response.ok) {
    const responseText = await response.text();
    throw buildError("Request failed", response.status, responseText);
  }

  return (await response.json()) as DailyState;
};

export const getDailyDelta = async (
  token: string,
  budgetId: string,
  date: string,
): Promise<{ top_day_total: number }> => {
  const query = new URLSearchParams({ budget_id: budgetId, date });
  return requestJson(`/daily-state/delta?${query.toString()}`, {
    headers: authHeaders(token),
  });
};

export const getReconcile = async (
  token: string,
  budgetId: string,
  date: string,
): Promise<ReconcileSummary> => {
  const query = new URLSearchParams({ budget_id: budgetId, date });
  return requestJson(`/reconcile?${query.toString()}`, {
    headers: authHeaders(token),
  });
};

export const createDebtOther = async (
  token: string,
  payload: {
    budget_id: string;
    amount: number;
    direction: "borrowed" | "repaid";
    asset_side: "cash" | "bank";
    date?: string;
  },
): Promise<DailyState> => {
  if (!API_BASE_URL) {
    throw buildError("API недоступен");
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/debts/other`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw buildError("API недоступен");
  }

  if (!response.ok) {
    const responseText = await response.text();
    let detailText = responseText;
    try {
      const parsed = JSON.parse(responseText) as { detail?: string };
      if (parsed?.detail) {
        detailText = parsed.detail;
      }
    } catch (error) {
      detailText = responseText;
    }
    throw buildError("Request failed", response.status, detailText);
  }

  return (await response.json()) as DailyState;
};

export const listGoals = async (
  token: string,
  budgetId: string,
): Promise<Goal[]> => {
  const query = new URLSearchParams({ budget_id: budgetId });
  return requestJson(`/goals?${query.toString()}`, {
    headers: authHeaders(token),
  });
};

export const createGoal = async (
  token: string,
  payload: {
    budget_id: string;
    title: string;
    target_amount: number;
    deadline?: string | null;
  },
): Promise<Goal> => {
  if (!API_BASE_URL) {
    throw buildError("API недоступен");
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/goals`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw buildError("API недоступен");
  }

  if (!response.ok) {
    const responseText = await response.text();
    throw buildError("Request failed", response.status, responseText);
  }

  return (await response.json()) as Goal;
};

export const updateGoal = async (
  token: string,
  id: string,
  payload: {
    title?: string;
    target_amount?: number;
    current_amount?: number;
    deadline?: string | null;
    status?: "active" | "done" | "archived";
  },
): Promise<Goal> => {
  if (!API_BASE_URL) {
    throw buildError("API недоступен");
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/goals/${id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw buildError("API недоступен");
  }

  if (!response.ok) {
    const responseText = await response.text();
    throw buildError("Request failed", response.status, responseText);
  }

  return (await response.json()) as Goal;
};

export const deleteGoal = async (
  token: string,
  id: string,
): Promise<{ status: string }> =>
  requestJson(`/goals/${id}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });

export const getReportCashflow = async (
  token: string,
  budgetId: string,
  from: string,
  to: string,
): Promise<CashflowDay[]> => {
  const query = new URLSearchParams({ budget_id: budgetId, from, to });
  return requestJson(`/reports/cashflow?${query.toString()}`, {
    headers: authHeaders(token),
  });
};

export const getReportBalance = async (
  token: string,
  budgetId: string,
  from: string,
  to: string,
): Promise<BalanceDay[]> => {
  const query = new URLSearchParams({ budget_id: budgetId, from, to });
  return requestJson(`/reports/balance?${query.toString()}`, {
    headers: authHeaders(token),
  });
};

export const getReportSummary = async (
  token: string,
  budgetId: string,
): Promise<ReportsSummary> => {
  const query = new URLSearchParams({ budget_id: budgetId });
  return requestJson(`/reports/summary?${query.toString()}`, {
    headers: authHeaders(token),
  });
};

export const getMonthReport = async (
  token: string,
  budgetId: string,
  month: string,
): Promise<MonthReport> => {
  const query = new URLSearchParams({ budget_id: budgetId, month });
  return requestJson(`/reports/month?${query.toString()}`, {
    headers: authHeaders(token),
  });
};

export const getExpensesByCategoryReport = async (
  token: string,
  budgetId: string,
  from: string,
  to: string,
  limit: number,
): Promise<ExpensesByCategoryReport> => {
  const query = new URLSearchParams({
    budget_id: budgetId,
    from,
    to,
    limit: String(limit),
  });
  return requestJson(`/reports/expenses-by-category?${query.toString()}`, {
    headers: authHeaders(token),
  });
};
