import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Popover as BasePopover } from "@base-ui/react/popover";
import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import { Select } from "@base-ui/react/select";
import { Toast as BaseToast } from "@base-ui/react/toast";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { Check, ChevronDown, Eye, EyeOff, X } from "lucide-react";
import { motion, type HTMLMotionProps } from "motion/react";
import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { useCallback, useState } from "react";

/** DESIGN.md: 140-200ms, ease-out, transform and opacity only. */
export const motionToken = { duration: 0.16, ease: "easeOut" as const };
const press = { whileTap: { scale: 0.98 }, transition: motionToken };

/* ------------------------------------------------------------------ buttons */

type Tone = "solid" | "ghost" | "danger" | "quiet";

const buttonTones: Record<Tone, string> = {
  // A pixel button is a flat block lifted by a solid bar, not a soft shadow.
  solid:
    "bg-accent text-navy border-accent-deep shadow-[0_3px_0_0_var(--color-accent-deep)] active:shadow-none active:translate-y-[3px]",
  ghost:
    "bg-panel text-ink border-line-strong shadow-[0_3px_0_0_rgba(148,176,194,0.28)] active:shadow-none active:translate-y-[3px] hover:bg-raised",
  danger:
    "bg-erase text-navy border-erase shadow-[0_3px_0_0_#b13e53] active:shadow-none active:translate-y-[3px]",
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
      className={`inline-flex items-center justify-center gap-2 border-2 px-3.5 py-2 text-sm font-medium whitespace-nowrap transition-colors duration-150 disabled:translate-y-0 disabled:border-line disabled:bg-panel disabled:text-muted disabled:shadow-none ${buttonTones[tone]} ${className}`}
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
  size?: "sm" | "md";
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  const box = size === "sm" ? "h-7 w-7" : "h-9 w-9";
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
        className={`grid ${box} shrink-0 place-items-center border-2 transition-colors duration-150 disabled:opacity-40 ${state} ${className}`}
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
        <BaseTooltip.Positioner sideOffset={8}>
          <BaseTooltip.Popup className="z-40 border-2 border-line-strong bg-raised px-2 py-1 font-mono text-[11px] text-ink">
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
          className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase"
        >
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

const well =
  "w-full border-2 bg-field px-3 py-2.5 text-ink transition-colors duration-150 outline-none placeholder:text-muted disabled:opacity-50";

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
        {shown ? <EyeOff size={16} strokeWidth={2} /> : <Eye size={16} strokeWidth={2} />}
      </button>
    </span>
  );
}

export function Textarea({
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`${well} resize-none border-line hover:border-line-strong focus:border-accent ${className}`}
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
            : "border-line-strong bg-field text-transparent group-hover:border-muted"
        }`}
      >
        <Check size={13} strokeWidth={4} strokeLinecap="square" />
      </span>
      {hideLabel ? (
        <span className="sr-only">{label}</span>
      ) : (
        <span className={checked ? "text-ink" : "text-muted"}>{label}</span>
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

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="border-2 border-line-strong px-1 font-mono text-[10px] text-muted">
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
    <section className={`flex min-h-0 flex-col gap-2 ${className}`}>
      <header className="flex items-center justify-between gap-2 border-b-2 border-line pb-1.5">
        <h2 className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">
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
        className={`flex items-center justify-between gap-2 border-2 border-line bg-field px-2.5 py-2 text-[13px] whitespace-nowrap text-ink transition-colors duration-150 hover:border-line-strong focus:border-accent ${className}`}
      >
        <Select.Value placeholder={placeholder} />
        <ChevronDown size={14} strokeWidth={2.5} className="shrink-0 text-muted" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={4} className="z-40">
          <Select.Popup className="max-h-64 min-w-[10rem] overflow-auto border-2 border-line-strong bg-raised p-1 text-[13px]">
            {options.map((option) => (
              <Select.Item
                key={option}
                value={option}
                className="cursor-pointer truncate px-2 py-1.5 text-ink data-[highlighted]:bg-accent data-[highlighted]:text-navy"
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
          <BaseMenu.Popup className="min-w-[10rem] border-2 border-line-strong bg-raised p-1 text-[13px]">
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
      className="cursor-pointer px-2 py-1.5 text-ink data-[disabled]:cursor-not-allowed data-[highlighted]:bg-accent data-[highlighted]:text-navy data-[disabled]:opacity-40"
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
          <BasePopover.Popup className="w-64 border-2 border-line-strong bg-raised p-2 text-[13px]">
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
          className="dialog-popup fixed top-1/2 left-1/2 z-40 -translate-x-1/2 -translate-y-1/2 border-2 border-line-strong bg-raised p-4"
        >
          <header className="flex items-start justify-between gap-3 border-b-2 border-line pb-2">
            <div>
              <BaseDialog.Title className="font-mono text-[12px] tracking-[0.16em] text-accent uppercase">
                {title}
              </BaseDialog.Title>
              {description ? (
                <BaseDialog.Description className="mt-1 text-[12px] text-muted">
                  {description}
                </BaseDialog.Description>
              ) : null}
            </div>
            <DialogClose>
              <X size={16} strokeWidth={2.5} />
              <span className="sr-only">Close</span>
            </DialogClose>
          </header>
          <div className="mt-4 grid gap-4">{children}</div>
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
            <BaseDialog.Title className="font-mono text-[11px] tracking-[0.16em] text-accent uppercase">
              {title}
            </BaseDialog.Title>
            <DialogClose>
              <X size={16} strokeWidth={2.5} />
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
        <BaseToast.Viewport className="fixed right-4 bottom-4 z-50 flex w-[min(24rem,90vw)] flex-col gap-2">
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
      <BaseToast.Title className="pr-6 font-mono text-[11px] tracking-[0.14em] text-accent uppercase" />
      <BaseToast.Description className="mt-1 text-[12px] text-muted" />
      <BaseToast.Close
        aria-label="Dismiss"
        className="absolute top-2 right-2 grid h-6 w-6 place-items-center border-2 border-line text-muted hover:border-line-strong hover:text-ink"
      >
        <X size={13} strokeWidth={2.5} />
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
    <div className="pixel-corners-sm grid gap-2 border-2 border-dashed border-line p-4">
      <p className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase">
        {title}
      </p>
      <p className="text-[13px] text-muted">{body}</p>
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
