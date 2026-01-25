const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

type ApiError = Error & { status?: number };

const buildError = (message: string, status?: number): ApiError => {
  const error = new Error(message) as ApiError;
  if (status) {
    error.status = status;
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

export const authTelegram = async (
  initData: string,
): Promise<{ access_token: string; token_type: string }> =>
  requestJson("/auth/telegram", {
    method: "POST",
    body: JSON.stringify({ initData }),
  });

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

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
});

export const ensureDefaultBudgets = async (token: string): Promise<void> => {
  await requestJson("/budgets/ensure-defaults", {
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
): Promise<Account> =>
  requestJson("/accounts", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });

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
): Promise<Category> =>
  requestJson("/categories", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
