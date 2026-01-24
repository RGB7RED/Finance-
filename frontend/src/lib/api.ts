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
