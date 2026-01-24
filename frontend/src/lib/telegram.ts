export const getTelegramInitData = (): string | null => {
  if (typeof window === "undefined") {
    return null;
  }

  const telegram = window as typeof window & {
    Telegram?: { WebApp?: { initData?: string } };
  };

  return telegram.Telegram?.WebApp?.initData ?? null;
};
