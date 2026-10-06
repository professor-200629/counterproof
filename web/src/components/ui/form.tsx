"use client";

import {
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";

const control =
  "block w-full min-w-0 rounded-md border border-control bg-inset px-3 text-sm text-fg placeholder:text-subtle " +
  "transition-colors hover:border-control-strong focus-visible:border-accent " +
  "disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-bad-line";

// ---------------------------------------------------------------------------- Field
export interface FieldProps {
  label: ReactNode;
  /** id of the control the label points at. */
  htmlFor: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
  /** ids for aria-describedby are `${htmlFor}-hint` / `${htmlFor}-error`. */
}

/** Label + control + hint + error. The self-labelled controls below use it for you. */
export function Field({ label, htmlFor, hint, error, required, className, children }: FieldProps) {
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-fg">
        {label}
        {required ? (
          <span className="ml-0.5 text-bad" aria-hidden="true">
            *
          </span>
        ) : null}
        {required ? <span className="sr-only"> (required)</span> : null}
      </label>
      {children}
      {hint ? (
        <p id={`${htmlFor}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${htmlFor}-error`} className="text-xs font-medium text-bad" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, hint?: ReactNode, error?: ReactNode): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

interface LabelledProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Class for the outer Field wrapper. */
  fieldClassName?: string;
}

// ---------------------------------------------------------------------------- Input
export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> &
  LabelledProps & {
    /** Monospace input (addresses, digests). */
    mono?: boolean;
  };

export function Input({ label, hint, error, fieldClassName, mono, id, className, required, ...rest }: InputProps) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Field label={label} htmlFor={inputId} hint={hint} error={error} required={required} className={fieldClassName}>
      <input
        id={inputId}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(inputId, hint, error)}
        className={cn(control, "h-9", mono && "font-mono text-xs", className)}
        {...rest}
      />
    </Field>
  );
}

// ---------------------------------------------------------------------------- Textarea
export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & LabelledProps & { mono?: boolean };

export function Textarea({ label, hint, error, fieldClassName, mono, id, className, required, rows = 4, ...rest }: TextareaProps) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Field label={label} htmlFor={inputId} hint={hint} error={error} required={required} className={fieldClassName}>
      <textarea
        id={inputId}
        rows={rows}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(inputId, hint, error)}
        className={cn(control, "py-2", mono && "font-mono text-xs", className)}
        {...rest}
      />
    </Field>
  );
}

// ---------------------------------------------------------------------------- Select
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> &
  LabelledProps & {
    /** Options; alternatively pass <option> children. */
    options?: SelectOption[];
    /** Adds a first, empty option with this text. */
    placeholder?: string;
  };

export function Select({ label, hint, error, fieldClassName, options, placeholder, id, className, required, children, ...rest }: SelectProps) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <Field label={label} htmlFor={inputId} hint={hint} error={error} required={required} className={fieldClassName}>
      <select
        id={inputId}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(inputId, hint, error)}
        className={cn(control, "h-9 pr-8", className)}
        {...rest}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options?.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
    </Field>
  );
}

// ---------------------------------------------------------------------------- Checkbox
export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: ReactNode;
  description?: ReactNode;
};

export function Checkbox({ label, description, id, className, ...rest }: CheckboxProps) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <div className={cn("flex items-start gap-2.5", className)}>
      <input
        id={inputId}
        type="checkbox"
        aria-describedby={description ? `${inputId}-desc` : undefined}
        className="mt-0.5 size-4 shrink-0 rounded border-line-strong accent-[var(--accent)]"
        {...rest}
      />
      <div className="min-w-0">
        <label htmlFor={inputId} className="block text-sm font-medium text-fg">
          {label}
        </label>
        {description ? (
          <p id={`${inputId}-desc`} className="text-xs text-muted">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- NumberField
export interface NumberFieldProps extends LabelledProps {
  /** Current value; null when empty or invalid. */
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Integer only (default true). */
  integer?: boolean;
  /** Unit shown after the input ("SYN", "sequences", "s"). */
  unit?: string;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

/**
 * Numeric input that keeps the raw text while typing and reports a parsed number (or
 * null) to the parent. Shows its own range error when out of bounds.
 */
export function NumberField({
  label,
  hint,
  error,
  fieldClassName,
  value,
  onChange,
  min,
  max,
  step,
  integer = true,
  unit,
  id,
  required,
  disabled,
  placeholder,
  className,
}: NumberFieldProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const [text, setText] = useState(value === null ? "" : String(value));
  const [lastValue, setLastValue] = useState(value);
  // Follow external changes (e.g. a reset) without fighting the user's typing.
  if (value !== lastValue) {
    setLastValue(value);
    if (parse(text, integer) !== value) setText(value === null ? "" : String(value));
  }
  const parsed = parse(text, integer);
  const rangeError =
    text.trim() === ""
      ? null
      : parsed === null
        ? integer
          ? "Enter a whole number."
          : "Enter a number."
        : min !== undefined && parsed < min
          ? `Must be at least ${min}.`
          : max !== undefined && parsed > max
            ? `Must be at most ${max}.`
            : null;
  const shownError = error ?? rangeError;

  return (
    <Field label={label} htmlFor={inputId} hint={hint} error={shownError} required={required} className={fieldClassName}>
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          inputMode={integer ? "numeric" : "decimal"}
          value={text}
          min={min}
          max={max}
          step={step}
          required={required}
          disabled={disabled}
          placeholder={placeholder}
          aria-invalid={shownError ? true : undefined}
          aria-describedby={describedBy(inputId, hint, shownError)}
          onChange={(e) => {
            const t = e.target.value;
            setText(t);
            const p = parse(t, integer);
            const inRange = p !== null && (min === undefined || p >= min) && (max === undefined || p <= max);
            const next = inRange ? p : null;
            setLastValue(next);
            onChange(next);
          }}
          className={cn(control, "h-9 tabular", className)}
        />
        {unit ? <span className="shrink-0 text-sm text-muted">{unit}</span> : null}
      </div>
    </Field>
  );
}

function parse(text: string, integer: boolean): number | null {
  const t = text.trim().replace(/[,_\s]/g, "");
  if (t === "") return null;
  if (integer ? !/^-?\d+$/.test(t) : !/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
