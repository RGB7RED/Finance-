import type { ReactNode } from "react";

type CardProps = {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
};

export function Card({ title, right, children }: CardProps) {
  return (
    <section className="mf-card">
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
