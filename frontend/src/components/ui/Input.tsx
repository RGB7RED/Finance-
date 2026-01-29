import type { ChangeEvent } from "react";
import { useId } from "react";

type InputProps = {
  label?: string;
  value: string | number;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  type?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  min?: number | string;
  readOnly?: boolean;
};

export function Input({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  disabled,
  required,
  min,
  readOnly,
}: InputProps) {
  const inputId = useId();

  return (
    <label className="mf-input" htmlFor={inputId}>
      {label && <span className="mf-input__label">{label}</span>}
      <input
        id={inputId}
        className="mf-input__control"
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        min={min}
        readOnly={readOnly}
      />
    </label>
  );
}
