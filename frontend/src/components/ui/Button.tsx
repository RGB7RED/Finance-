import type { ReactNode } from "react";

type ButtonProps = {
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
  type?: "button" | "submit";
  title?: string;
  className?: string;
};

export function Button({
  variant = "primary",
  disabled,
  onClick,
  children,
  type = "button",
  title,
  className,
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`mf-button mf-button--${variant}${
        className ? ` ${className}` : ""
      }`}
      disabled={disabled}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}
