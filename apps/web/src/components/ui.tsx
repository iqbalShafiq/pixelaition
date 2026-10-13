import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Popover as BasePopover } from "@base-ui/react/popover";
import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import { Select } from "@base-ui/react/select";
import { Toast as BaseToast } from "@base-ui/react/toast";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { motion, type HTMLMotionProps } from "motion/react";
import { ChevronDown, Close, Eye, EyeOff } from "./pixel-icons.js";
import type { InputHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from "react";
import { useCallback, useState } from "react";

/** DESIGN.md: 140-200ms, ease-out, transform and opacity only. */
export const motionToken = { duration: 0.16, ease: "easeOut" as const };
const press = { whileTap: { scale: 0.98 }, transition: motionToken };

/* ------------------------------------------------------------------ buttons */

type Tone = "solid" | "ghost" | "danger" | "quiet";

const buttonTones: Record<Tone, string> = {
  // A pixel button is a flat block; a hard bar lifts it. Navy reads on panel
  // and raised surfaces; ghost takes the steel bar so it also reads on paper.
  solid: "bg-accent text-navy border-accent-deep shadow-pixel-sm",
  ghost: "bg-panel text-ink border-line-strong shadow-pixel-steel hover:bg-raised",
  danger: "bg-erase text-navy border-erase shadow-pixel-sm",
  quiet: "bg-transparent text-muted border-transparent hover:text-ink",
};

export function Button({
  children,
  tone = "solid",
  className = "",
  type = "button",
  ...props
}: Omit<HTMLMotionProps<"button">, "ref"> & { tone?: Tone }) {
  return (
    <motion.button
      {...press}
      type={type}
      {...props}
      className={`inline-flex items-center justify-center gap-2 border-2 px-3.5 py-2 text-sm font-medium whitespace-nowrap transition-[transform,box-shadow,background-color,border-color] duration-150 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:translate-y-0 disabled:border-line disabled:bg-panel disabled:text-muted disabled:shadow-none ${buttonTones[tone]} ${className}`}
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
  /** Active state shown as an accent edge rather than a solid fill. */
  subtle?: boolean;
  disabled?: boolean;
  /** sm 28px, md 36px, lg 40px — lg matches the composer bar's controls. */
  size?: "sm" | "md" | "lg";
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  const box = size === "sm" ? "h-7 w-7" : size === "lg" ? "h-10 w-10" : "h-9 w-9";
  const state = !active
    ? "border-line text-muted hover:border-line-strong hover:bg-raised hover:text-ink"
    : subtle
      ? "border-accent bg-accent/15 text-accent"
      : "border-accent bg-accent text-navy";
  return (
    <Tooltip label={hint ? `${label} · ${hint}` : label}>
      <motion.button
        {...press}
        type="button"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        className={`grid ${box} shrink-0 place-items-center border-2 shadow-pixel-sm transition-[transform,box-shadow,background-color,border-color] duration-150 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none disabled:opacity-40 ${state} ${className}`}
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
        <BaseTooltip.Positioner sideOffset={8} className="z-40">
          <BaseTooltip.Popup className="bg-raised pixel-window px-2 py-1 text-pixel-mono text-ink">
            {label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

/* ------------------------------------------------------------------- inputs */

/**
 * The label is associated by `htmlFor`, never by wrapping. A wrapped label also
 * absorbs any button inside it, which is how a password field silently becomes
 * "Password Show password" to a screen reader.
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
        <label
          htmlFor={htmlFor}
          className="text-pixel-mono tracking-[0.14em] text-muted uppercase"
        >
          {label}
        </label>
        {hint ? <span className="text-pixel-mono text-muted">{hint}</span> : null}
      </div>
      {children}
      {/* Colour is never the only signal: the message carries the meaning. The
          field chip keeps coral at 6.85:1 even when the field sits on `raised`,
          where coral directly on the surface would be 4.02:1. */}
      {error ? (
        <span
          role="alert"
          className="border-2 border-erase/60 bg-field px-2 py-1 text-[12px] text-erase"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}

const well =
  "w-full border-2 bevel-in bg-field px-3 py-2.5 text-ink transition-colors duration-150 outline-none placeholder:text-muted disabled:opacity-50";

export function TextInput({
  className = "",
  invalid = false,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      {...props}
      aria-invalid={invalid || undefined}
      className={`${well} ${invalid ? "border-erase" : "border-line hover:border-line-strong focus:border-accent"} ${className}`}
    />
  );
}

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
        className={`${well} pr-12 ${invalid ? "border-erase" : "border-line hover:border-line-strong focus:border-accent"} ${className}`}
      />
      <button
        type="button"
        aria-label={shown ? "Hide password" : "Show password"}
        aria-pressed={shown}
        onClick={() => setShown((value) => !value)}
        className="absolute inset-y-0 right-1.5 my-auto grid h-8 w-8 place-items-center border-2 border-transparent text-muted hover:border-line-strong hover:text-ink"
      >
        {shown ? <EyeOff /> : <Eye />}
      </button>
    </span>
  );
}

export function Textarea({
  bare = false,
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  ref?: Ref<HTMLTextAreaElement>;
  bare?: boolean;
}) {
  return (
    <textarea
      {...props}
      className={
        bare
          ? `w-full resize-none bg-transparent p-0 text-ink outline-none placeholder:text-muted disabled:opacity-50 ${className}`
          : `${well} resize-none border-line hover:border-line-strong focus:border-accent ${className}`
      }
    />
  );
}

/* ---------------------------------------------------------------- selection */

/**
 * A pixel checkbox: a flat square that fills with the accent and takes a chunky
 * check. The native input stays in the DOM for the keyboard and the a11y tree.
 */
export function Checkbox({
  label,
  hideLabel = false,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hideLabel?: boolean;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      className={`group inline-flex items-center gap-2 text-[12px] ${
        disabled ? "cursor-not-allowed opacity-45" : ""
      }`}
    >
      <input
        type="checkbox"
        className="sr-only"
        aria-label={hideLabel ? label : undefined}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span
        aria-hidden
        className={`grid h-[18px] w-[18px] shrink-0 place-items-center border-2 transition-colors duration-150 ${
          checked
            ? "border-accent bg-accent text-navy"
            : "border-line-strong bevel-in bg-field text-transparent group-hover:border-muted"
        }`}
      >
        {/* 13px layout box keeps the pre-change baseline (the svg bottom edge is
            the label baseline inside the layers panel's clipped 18px wrapper);
            preserveAspectRatio still draws the 12px glyph. */}
        <svg
          viewBox="0 0 6 6"
          width={12}
          height={12}
          shapeRendering="crispEdges"
          aria-hidden
        >
          <path
            d="M1 3h1v1H1zM2 4h1v1H2zM3 5h1v1H3zM4 4h1v1H4zM5 3h1v1H5zM5 2h1v1H5zM5 1h1v1H5z"
            fill="currentColor"
          />
        </svg>
      </span>
      {hideLabel ? (
        <span className="sr-only">{label}</span>
      ) : (
        <span className="group/label relative min-w-0">
          <span className={`block truncate ${checked ? "text-ink" : "text-muted"}`}>
            {label}
          </span>
          <span
            role="tooltip"
            className="pointer-events-none absolute top-full left-0 z-50 mt-1 hidden max-w-[34rem] border-2 border-line bg-raised px-2 py-1 text-pixel-mono whitespace-normal text-ink shadow-pixel group-hover/label:block"
          >
            {label}
          </span>
        </span>
      )}
    </label>
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
    <Checkbox label={label} checked={checked} disabled={disabled} onChange={onChange} />
  );
}

/* ---------------------------------------------------------------- progress */

/**
 * Progress and usage read as segmented cells, one cell per unit — never a
 * smooth bar. The row is capped at the 33-colour palette limit and can shrink
 * with its container so a big total cannot run off the rail; the surrounding
 * text names the count, so the row itself stays out of the a11y tree.
 */
export function ProgressCells({ value, total }: { value: number; total: number }) {
  const cells = Math.min(Math.max(total, 1), 33);
  const filled = Math.min(Math.max(value, 0), cells);
  return (
    <span aria-hidden className="flex min-w-0 flex-1 items-center gap-px">
      {Array.from({ length: cells }, (_, index) => (
        <span
          key={index}
          className={`w-1 h-3 ${index < filled ? "bg-accent" : "bg-raised"}`}
        />
      ))}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="border-2 border-line-strong px-1 text-pixel-mono text-muted">
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
      className={`pixel-corners border-2 border-line bg-panel p-5 ${
        interactive ? "transition-colors duration-150 hover:border-line-strong" : ""
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
    <section className={`flex min-h-0 min-w-0 flex-col gap-2 ${className}`}>
      <header className="flex items-center justify-between gap-2 border-b-2 border-line pb-1.5">
        {/* Micro-label decision: panel headers are Silkscreen 16, the same
            display face as dialog and sheet titles (see DESIGN.md). */}
        <h2 className="text-pixel-title text-muted">{title}</h2>
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
        className="flex w-2 touch-none select-none"
      >
        <BaseScrollArea.Thumb className="flex-1 bg-steel" />
      </BaseScrollArea.Scrollbar>
      <BaseScrollArea.Corner />
    </BaseScrollArea.Root>
  );
}

export function Separator({ vertical = false }: { vertical?: boolean }) {
  return (
    <span
      aria-hidden
      className={
        vertical ? "mx-1 h-5 w-0.5 shrink-0 bg-line" : "my-1 h-0.5 w-full bg-line"
      }
    />
  );
}

/* ------------------------------------------------------------------- select */

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
  /** Plain strings use the value as the label; objects keep the two apart. */
  options: Array<string | { value: string; label: string }>;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  className?: string;
}) {
  const items = options.map((option) =>
    typeof option === "string" ? { value: option, label: option } : option,
  );
  return (
    <Select.Root value={value} onValueChange={(next) => onChange(next ?? value)}>
      <Select.Trigger
        id={id}
        aria-label={label}
        title={items.find((item) => item.value === value)?.label ?? placeholder}
        className={`flex min-w-0 items-center justify-between gap-2 border-2 border-line bg-field px-2.5 py-2 text-[13px] text-ink shadow-[inset_2px_2px_0_0_rgba(244,244,244,0.08),inset_-2px_-2px_0_0_rgba(26,28,44,0.45),2px_2px_0_0_var(--color-navy)] transition-colors duration-150 hover:border-line-strong focus:border-accent active:translate-x-[2px] active:translate-y-[2px] active:shadow-none ${className}`}
      >
        <Select.Value placeholder={placeholder} className="min-w-0">
          {(selected: string | null) => (
            // Long model ids ellipsize instead of overflowing the control.
            <span className="block min-w-0 truncate">
              {items.find((item) => item.value === selected)?.label ?? placeholder}
            </span>
          )}
        </Select.Value>
        <ChevronDown className="shrink-0 text-muted" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={4} className="z-40">
          <Select.Popup className="max-h-64 min-w-[10rem] max-w-[min(22rem,90vw)] overflow-auto bg-raised pixel-window p-1 text-[13px]">
            {items.map((item) => (
              <Select.Item
                key={item.value}
                value={item.value}
                title={item.label}
                className="cursor-pointer truncate px-2 py-1.5 text-ink data-[highlighted]:bg-accent data-[highlighted]:text-navy"
              >
                <Select.ItemText>{item.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

/* -------------------------------------------------------------------- menus */

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
        className="grid h-7 w-7 shrink-0 place-items-center border-2 border-line text-muted hover:border-line-strong hover:bg-raised hover:text-ink"
      >
        ⋯
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner sideOffset={6} align={align} className="z-40">
          <BaseMenu.Popup className="min-w-[10rem] bg-raised pixel-window p-1 text-[13px]">
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
      className="flex cursor-pointer items-center gap-2 whitespace-nowrap px-2 py-1.5 text-ink data-[disabled]:cursor-not-allowed data-[highlighted]:bg-accent data-[highlighted]:text-navy data-[disabled]:opacity-40"
    >
      {children}
    </BaseMenu.Item>
  );
}

export const MenuSeparator = BaseMenu.Separator;

/* ----------------------------------------------------------------- popover */

export function Popover({
  trigger,
  label,
  children,
  align = "end",
}: {
  trigger: ReactNode;
  label: string;
  children: ReactNode;
  align?: "start" | "end";
}) {
  return (
    <BasePopover.Root>
      <BasePopover.Trigger
        aria-label={label}
        className="border-2 border-line text-muted hover:border-line-strong hover:bg-raised hover:text-ink data-[popup-open]:border-accent data-[popup-open]:text-accent"
      >
        {trigger}
      </BasePopover.Trigger>
      <BasePopover.Portal>
        <BasePopover.Positioner sideOffset={6} align={align} className="z-40">
          <BasePopover.Popup className="w-64 bg-raised pixel-window p-2 text-[13px]">
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}

/* ---------------------------------------------------------------- overlays */

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
        <BaseDialog.Backdrop className="fixed inset-0 z-30 bg-navy/85" />
        <BaseDialog.Popup
          style={{ width: `min(${width}, 94vw)` }}
          className="dialog-popup fixed top-1/2 left-1/2 z-40 -translate-x-1/2 -translate-y-1/2 bg-raised pixel-window p-4"
        >
          <header className="flex items-start justify-between gap-3 border-b-2 border-line pb-2">
            <div>
              <BaseDialog.Title className="text-pixel-title text-accent">
                {title}
              </BaseDialog.Title>
              {description ? (
                <BaseDialog.Description className="mt-1 text-[12px] text-muted">
                  {description}
                </BaseDialog.Description>
              ) : null}
            </div>
            <DialogClose>
              <Close />
              <span className="sr-only">Close</span>
            </DialogClose>
          </header>
          <div className="mt-4 grid gap-4">{children}</div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/**
 * A destructive-action confirmation. Base UI owns the focus trap, Escape and
 * ARIA wiring; the copy names the consequence before anything is removed.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Delete",
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => void;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-40 bg-navy/85" />
        <BaseDialog.Popup className="fixed top-1/2 left-1/2 z-50 w-[min(26rem,94vw)] -translate-x-1/2 -translate-y-1/2 bg-raised pixel-window p-4">
          <BaseDialog.Title className="text-pixel-title text-accent">
            {title}
          </BaseDialog.Title>
          <BaseDialog.Description className="mt-2 text-[13px] text-muted">
            {description}
          </BaseDialog.Description>
          <div className="mt-4 flex justify-end gap-2">
            <DialogClose>
              <Close />
              <span className="sr-only">Cancel</span>
            </DialogClose>
            <Button
              tone="danger"
              onClick={() => {
                onConfirm();
                onOpenChange(false);
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

export function DialogClose({ children }: { children: ReactNode }) {
  return (
    <BaseDialog.Close
      aria-label="Close"
      className="grid h-7 w-7 shrink-0 place-items-center border-2 border-line text-muted hover:border-line-strong hover:text-ink"
    >
      {children}
    </BaseDialog.Close>
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
        <BaseDialog.Backdrop className="fixed inset-0 z-30 bg-navy/80" />
        <BaseDialog.Popup
          data-side={side}
          className={`sheet-popup fixed inset-y-0 z-40 flex w-[min(20rem,86vw)] flex-col bg-raised ${
            side === "left" ? "left-0 border-r-2" : "right-0 border-l-2"
          } border-line-strong`}
        >
          <header className="flex items-center justify-between border-b-2 border-line px-3 py-2">
            <BaseDialog.Title className="text-pixel-title text-accent">
              {title}
            </BaseDialog.Title>
            <DialogClose>
              <Close />
              <span className="sr-only">Close {title}</span>
            </DialogClose>
          </header>
          <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/* ------------------------------------------------------------------- toasts */

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <BaseToast.Provider>
      {children}
      <BaseToast.Portal>
        {/* bottom-32 clears the composer band, whose Generate button the old
            bottom-4 viewport covered while a toast was visible. */}
        <BaseToast.Viewport className="fixed right-4 bottom-32 z-50 flex w-[min(24rem,90vw)] flex-col gap-2">
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
      className="toast-popup relative border-2 border-line-strong bg-raised p-3"
    >
      <BaseToast.Title className="pr-6 text-pixel-mono tracking-[0.14em] text-accent uppercase" />
      <BaseToast.Description className="mt-1 text-[12px] text-muted" />
      <BaseToast.Close
        aria-label="Dismiss"
        className="absolute top-2 right-2 grid h-6 w-6 place-items-center border-2 border-line text-muted hover:border-line-strong hover:text-ink"
      >
        <Close width={12} height={12} />
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

/* ------------------------------------------------------------------- brand */

/**
 * The wordmark's mark: a 16px logo glyph drawn on a 16 grid, not a UI icon,
 * so the 24/12 icon rule does not apply. `currentColor` keeps it on `accent`.
 */
export function PixelMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      shapeRendering="crispEdges"
      aria-hidden
      className="text-accent"
    >
      <rect x="1" y="1" width="6" height="6" fill="currentColor" />
      <rect x="9" y="1" width="6" height="6" fill="currentColor" opacity="0.5" />
      <rect x="1" y="9" width="6" height="6" fill="currentColor" opacity="0.5" />
      <rect x="9" y="9" width="6" height="6" fill="currentColor" />
    </svg>
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
    <div className="pixel-corners-sm dither-sm grid gap-2 border-2 border-dashed border-line p-4">
      {/* The dither is the atmosphere around the message; the copy keeps a
          solid surface so its contrast never rides the checker. */}
      <div className="grid gap-2 bg-panel p-3">
        <p className="text-pixel-mono tracking-[0.14em] text-muted uppercase">{title}</p>
        <p className="text-[13px] text-muted">{body}</p>
        {action}
      </div>
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
      className={`border-2 px-3 py-2 text-[12px] ${
        tone === "danger"
          ? "border-erase/60 bg-erase/10 text-erase"
          : "border-line bg-field text-muted"
      }`}
    >
      {children}
    </p>
  );
}
