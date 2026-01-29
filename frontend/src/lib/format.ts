export const formatRub = (amount: number): string => {
  const sign = amount < 0 ? "-" : "";
  const absolute = Math.abs(Math.trunc(amount));
  const formatted = absolute
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}${formatted} ₽`;
};
