type PillProps = {
  variant: "ok" | "warn" | "err";
  text: string;
};

export function Pill({ variant, text }: PillProps) {
  return <span className={`mf-pill mf-pill--${variant}`}>{text}</span>;
}
