type TabKey = "day" | "ops" | "reports" | "settings";

type TabsProps = {
  active: TabKey;
  onChange: (tab: TabKey) => void;
};

const items: { key: TabKey; label: string }[] = [
  { key: "day", label: "День" },
  { key: "ops", label: "Операции" },
  { key: "reports", label: "Отчёты" },
  { key: "settings", label: "Настройки" },
];

export function Tabs({ active, onChange }: TabsProps) {
  return (
    <nav className="mf-tabs">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={`mf-tabs__item${
            active === item.key ? " is-active" : ""
          }`}
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
