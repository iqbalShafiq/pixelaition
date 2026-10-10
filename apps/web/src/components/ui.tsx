import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import { Select } from "@base-ui/react/select";
import { Toast as BaseToast } from "@base-ui/react/toast";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { motion } from "motion/react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import { useCallback, useState } from "react";

/** DESIGN.md: 140-200ms, ease-out, transform and opacity only. */
export const motionToken = { duration: 0.16, ease: "easeOut" as const };
const press = { whileTap: { scale: 0.98 }, transition: motionToken };

/* ---------------------------------------------------------------- buttons */

export function Button({
  children,
  tone = "solid",
  className = "",
  type = "button",
  disabled,
  onClick,
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "solid" | "ghost" | "danger" | "quiet";
}) {
  const tones = {
    solid: "bg-accent text-paper hover:brightness-105",
    ghost: "border border-line text-ink hover:bg-panel",
    danger: "bg-erase text-paper",
    quiet: "text-muted hover:text-ink",
  };
  return (
    <motion.button
      {...press}
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md px-3 py-2 text-sm whitespace-nowrap disabled:opacity-40 ${tones[tone]} ${className}`}
    >
      {children}
    </motion.button>
  );
}

/**
 * The plan asks for a tooltip on every glyph-only control, so the label is not
 * lost when the text is.
 */
export function IconButton({
  label,
  hint,
  active = false,
  subtle = false,
  disabled,
  size = "md",
  onClick,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  active?: boolean;
  /** Active state shown as accent text rather than an accent fill. */
  subtle?: boolean;
  disabled?: boolean;
  size?: "sm" | "md";
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  const box = size === "sm" ? "h-7 w-7" : "h-8 w-8";
  const state = !active
    ? "border-transparent text-muted hover:border-line hover:bg-panel hover:text-ink"
    : subtle
      ? "border-line bg-panel text-accent"
      : "border-accent bg-accent text-paper";
  return (
    <Tooltip label={hint ? `${label} · ${hint}` : label}>
      <motion.button
        {...press}
        type="button"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        className={`grid ${box} shrink-0 place-items-center rounded-md border text-xs disabled:opacity-35 ${state} ${className}`}
      >
        {children}
      </motion.button>
    </Tooltip>
  );
}

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children as React.ReactElement} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner sideOffset={6}>
          <BaseTooltip.Popup className="z-40 rounded-md border border-line bg-raised px-2 py-1 font-mono text-[11px] text-ink">
            {label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

/* ----------------------------------------------------------------- inputs */

/**
 * The label is associated by `htmlFor`, never by wrapping. A wrapped label also
 * absorbs any button inside it, which is how a password field silently becomes
 * "Password Show password" for a screen reader.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink">
          {label}
        </label>
        {hint ? <span className="font-mono text-[10px] text-muted">{hint}</span> : null}
      </div>
      {children}
      {/* Colour is never the only signal: the message carries the meaning. */}
      {error ? (
        <span role="alert" className="text-[12px] text-erase">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The input is an inset well: darker than the surface it sits on, with a border
 * strong enough to read as an edge. `--color-line` alone measures about 1.6:1
 * against the panel, which is nowhere near the 3:1 a UI boundary needs.
 */
export function TextInput({
  className = "",
  invalid = false,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...props}
      aria-invalid={invalid || undefined}
      className={`w-full rounded-md border bg-field px-3 py-2.5 text-ink transition-colors duration-150 outline-none ${
        invalid ? "border-erase" : "border-line-strong"
      } hover:border-muted/60 focus:border-accent focus:ring-1 focus:ring-accent/40 disabled:opacity-50 ${className}`}
    />
  );
}

/** Same well as TextInput, with the password visibility toggle the plan asks for. */
export function PasswordInput({
  className = "",
  invalid = false,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="relative block">
      <input
        {...props}
        type={shown ? "text" : "password"}
        aria-invalid={invalid || undefined}
        className={`w-full rounded-md border bg-field px-3 py-2.5 pr-11 text-ink transition-colors duration-150 outline-none ${
          invalid ? "border-erase" : "border-line-strong"
        } hover:border-muted/60 focus:border-accent focus:ring-1 focus:ring-accent/40 ${className}`}
      />
      <button
        type="button"
        aria-label={shown ? "Hide password" : "Show password"}
        aria-pressed={shown}
        onClick={() => setShown((value) => !value)}
        className="absolute inset-y-0 right-1 my-auto grid h-7 w-7 place-items-center rounded text-muted hover:text-ink"
      >
        <EyeIcon open={shown} />
      </button>
    </span>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden
    >
      <path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4z" />
      <circle cx="8" cy="8" r="1.8" />
      {open ? null : <path d="M2.5 13.5l11-11" />}
    </svg>
  );
}

export function Textarea({
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`w-full resize-none rounded-md border border-line bg-field px-3 py-2.5 text-ink placeholder:text-faint transition-colors duration-150 outline-none border-line-strong hover:border-muted/60 focus:border-accent ${className}`}
    />
  );
}

export function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-[11px] ${
        checked ? "bg-panel text-ink" : "text-muted"
      } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="sr-only"
      />
      <span
        aria-hidden
        className={`grid h-3 w-3 place-items-center rounded-[3px] border ${
          checked ? "border-accent text-accent" : "border-muted/50"
        }`}
      >
        {checked ? "✓" : ""}
      </span>
      {label}
    </label>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line px-1 font-mono text-[10px] text-muted">
      {children}
    </kbd>
  );
}

/* ------------------------------------------------------------------ shells */

export function Card({
  children,
  className = "",
  interactive = false,
}: {
  children: ReactNode;
  className?: string;
  interactive?: boolean;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={motionToken}
      className={`rounded-lg border border-line bg-panel p-4 ${
        interactive ? "transition-colors hover:border-muted/40" : ""
      } ${className}`}
    >
      {children}
    </motion.section>
  );
}

export function Panel({
  title,
  action,
  children,
  className = "",
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`flex min-h-0 flex-col gap-2 ${className}`}>
      <header className="flex items-center justify-between gap-2">
        <h2 className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">
          {title}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}

export function ScrollArea({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <BaseScrollArea.Root className={`min-h-0 overflow-hidden ${className}`}>
      <BaseScrollArea.Viewport className="h-full">
        <BaseScrollArea.Content>{children}</BaseScrollArea.Content>
      </BaseScrollArea.Viewport>
      <BaseScrollArea.Scrollbar
        orientation="vertical"
        className="flex w-1.5 touch-none select-none p-px"
      >
        <BaseScrollArea.Thumb className="flex-1 rounded-full bg-[#3a342c]" />
      </BaseScrollArea.Scrollbar>
      <BaseScrollArea.Corner />
    </BaseScrollArea.Root>
  );
}

export function Separator({ vertical = false }: { vertical?: boolean }) {
  return (
    <span
      aria-hidden
      className={vertical ? "mx-1 h-5 w-px shrink-0 bg-line" : "my-1 h-px w-full bg-line"}
    />
  );
}

/* ----------------------------------------------------------------- select */

export function SelectControl({
  id,
  value,
  options,
  onChange,
  label,
  placeholder = "Select",
  className = "",
}: {
  id?: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <Select.Root value={value} onValueChange={(next) => onChange(next ?? value)}>
      <Select.Trigger
        id={id}
        aria-label={label}
        className={`flex items-center justify-between gap-2 rounded-md border border-line-strong bg-field px-2.5 py-2 text-[13px] whitespace-nowrap text-ink transition-colors duration-150 hover:border-muted/60 focus:border-accent ${className}`}
      >
        <Select.Value placeholder={placeholder} />
        <span aria-hidden className="text-muted">
          ▾
        </span>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={4} className="z-40">
          <Select.Popup className="max-h-64 min-w-[10rem] overflow-auto rounded-md border border-line bg-panel p-1 text-xs shadow-none">
            {options.map((option) => (
              <Select.Item
                key={option}
                value={option}
                className="cursor-pointer truncate rounded px-2 py-1.5 text-ink data-[highlighted]:bg-paper"
              >
                <Select.ItemText>{option}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

/* ------------------------------------------------------------------ menus */

export function Menu({
  label,
  children,
  align = "end",
}: {
  label: string;
  children: ReactNode;
  align?: "start" | "end";
}) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger
        aria-label={label}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-transparent text-muted hover:border-line hover:bg-panel hover:text-ink"
      >
        ⋯
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner sideOffset={6} align={align} className="z-40">
          <BaseMenu.Popup className="min-w-[9rem] rounded-md border border-line bg-raised p-1 text-xs">
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

export function MenuItem({
  children,
  disabled,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <BaseMenu.Item
      disabled={disabled}
      onClick={onClick}
      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-ink data-[disabled]:cursor-not-allowed data-[highlighted]:bg-paper data-[disabled]:opacity-40"
    >
      {children}
    </BaseMenu.Item>
  );
}

export const MenuSeparator = BaseMenu.Separator;

/* ---------------------------------------------------------------- overlays */

/**
 * Side sheets and modals. The plan asks that a panel never hides the canvas
 * without a clear way back, so every overlay renders a labelled Close.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  width = "30rem",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  width?: string;
  children: ReactNode;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-30 bg-paper/80" />
        <BaseDialog.Popup
          style={{ width: `min(${width}, 94vw)` }}
          className="dialog-popup fixed top-1/2 left-1/2 z-40 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-raised p-4"
        >
          <BaseDialog.Title className="text-sm text-ink">{title}</BaseDialog.Title>
          {description ? (
            <BaseDialog.Description className="mt-1 text-xs text-muted">
              {description}
            </BaseDialog.Description>
          ) : null}
          <div className="mt-4 grid gap-3">{children}</div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

export function DialogClose({ children }: { children: ReactNode }) {
  return (
    <BaseDialog.Close
      render={<Button tone="ghost">{children}</Button>}
      aria-label={typeof children === "string" ? children : "Close"}
    />
  );
}

/** A column becomes one of these below 1100px. */
export function Sheet({
  open,
  onOpenChange,
  title,
  side = "left",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  side?: "left" | "right";
  children: ReactNode;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-30 bg-paper/70" />
        <BaseDialog.Popup
          data-side={side}
          className={`sheet-popup fixed inset-y-0 z-40 flex w-[min(20rem,86vw)] flex-col border-line bg-raised ${
            side === "left" ? "left-0 border-r" : "right-0 border-l"
          }`}
        >
          <header className="flex items-center justify-between border-b border-line px-3 py-2">
            <BaseDialog.Title className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">
              {title}
            </BaseDialog.Title>
            <DialogClose>
              <span aria-hidden>×</span>
              <span className="sr-only">Close {title}</span>
            </DialogClose>
          </header>
          <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/* ----------------------------------------------------------------- toasts */

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <BaseToast.Provider>
      {children}
      <BaseToast.Portal>
        <BaseToast.Viewport className="fixed right-4 bottom-4 z-50 flex w-[min(22rem,90vw)] flex-col gap-2">
          <ToastList />
        </BaseToast.Viewport>
      </BaseToast.Portal>
    </BaseToast.Provider>
  );
}

function ToastList() {
  const { toasts } = BaseToast.useToastManager();
  return toasts.map((toast) => (
    <BaseToast.Root
      key={toast.id}
      toast={toast}
      className="toast-popup rounded-md border border-line bg-raised p-3"
    >
      <BaseToast.Title className="text-sm text-ink" />
      <BaseToast.Description className="mt-0.5 font-mono text-[11px] text-muted" />
      <BaseToast.Close
        aria-label="Dismiss"
        className="absolute top-2 right-2 text-muted hover:text-ink"
      >
        ×
      </BaseToast.Close>
    </BaseToast.Root>
  ));
}

export function useToast() {
  const manager = BaseToast.useToastManager();
  return useCallback(
    (input: { title: string; description?: string }) =>
      manager.add({
        title: input.title,
        description: input.description,
        timeout: input.description?.toLowerCase().includes("failed") ? 8000 : 4000,
      }),
    [manager],
  );
}

/* --------------------------------------------------------- empty and error */

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="grid gap-2 rounded-lg border border-dashed border-line p-4">
      <p className="text-sm text-ink">{title}</p>
      <p className="text-xs text-muted">{body}</p>
      {action}
    </div>
  );
}

export function Callout({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "danger";
  children: ReactNode;
}) {
  return (
    <p
      className={`rounded-md border border-line px-2.5 py-2 text-xs ${
        tone === "danger" ? "text-erase" : "text-muted"
      }`}
    >
      {children}
    </p>
  );
}
