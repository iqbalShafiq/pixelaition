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
