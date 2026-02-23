import type { MouseEventHandler, ReactNode } from "react";

type CardProps = {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  onClick?: MouseEventHandler<HTMLElement>;
};

export function Card({ title, right, children, className, onClick }: CardProps) {
  return (
    <section className={["mf-card", className].filter(Boolean).join(" ")} onClick={onClick}>
      {(title || right) && (
        <div className="mf-card__header">
          {title && <h3 className="mf-card__title">{title}</h3>}
          {right && <div className="mf-card__right">{right}</div>}
        </div>
      )}
      <div className="mf-card__body">{children}</div>
    </section>
  );
}
