import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Select } from "@base-ui/react/select";
import { motion } from "motion/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

const press = { whileTap: { scale: 0.98 }, transition: { duration: 0.16 } };

export function Button({
  children,
  tone = "solid",
  className = "",
  type = "button",
  disabled,
  onClick,
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "solid" | "ghost" | "danger" }) {
  const tones = {
    solid: "bg-accent text-paper",
    ghost: "bg-transparent border border-line",
    danger: "bg-erase text-ink",
  };
  return (
    <motion.button
      {...press}
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md px-3 py-2 text-sm disabled:opacity-50 ${tones[tone]} ${className}`}
    >
      {children}
    </motion.button>
  );
}

export function IconButton({
  label,
  active = false,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <motion.button
      {...press}
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`grid h-8 w-8 place-items-center rounded-md border text-xs disabled:opacity-40 ${
        active
          ? "border-accent bg-accent text-paper"
          : "border-transparent text-muted hover:border-line hover:text-ink"
      }`}
    >
      {children}
    </motion.button>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3.5 w-3.5 accent-[#e8ff6a]"
      />
      {label}
    </label>
  );
}

export function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-h-0 flex-col gap-2">
      <header className="flex items-center justify-between gap-2">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
          {title}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 bg-paper/80 backdrop-blur-[2px]" />
        <BaseDialog.Popup className="dialog-popup fixed top-1/2 left-1/2 w-[min(30rem,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-panel p-4">
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

export function DialogCloseButton({ children }: { children: ReactNode }) {
  return (
    <BaseDialog.Close
      render={
        <Button tone="ghost" className="justify-self-start">
          {children}
        </Button>
      }
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`rounded-md border border-line bg-paper px-3 py-2 outline-none focus:border-accent ${props.className ?? ""}`}
    />
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-lg border border-line bg-panel p-4 ${className}`}
    >
      {children}
    </motion.section>
  );
}

export function ModelSelect({
  value,
  options,
  onChange,
  label,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <Select.Root value={value} onValueChange={(next) => onChange(next ?? value)}>
      <Select.Trigger
        className="rounded-md border border-line bg-paper px-2 py-1 text-xs"
        aria-label={label}
      >
        <Select.Value />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner>
          <Select.Popup className="z-20 max-h-64 overflow-auto rounded-md border border-line bg-panel p-1 text-sm shadow-none">
            {options.map((option) => (
              <Select.Item
                key={option}
                value={option}
                className="cursor-pointer rounded px-2 py-1 data-[highlighted]:bg-paper"
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
