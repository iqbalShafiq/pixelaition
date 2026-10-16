export type ToastInput = { id?: string; title: string; description?: string };

/**
 * The toast manager payload for one notice. A named id replaces its own toast
 * instead of stacking a second copy the user cannot tell apart from the first;
 * a failure text stays longer than a plain confirmation.
 */
export function toastPayload(input: ToastInput): {
  id?: string;
  title: string;
  description?: string;
  timeout: number;
} {
  return {
    ...(input.id !== undefined ? { id: input.id } : {}),
    title: input.title,
    description: input.description,
    timeout: input.description?.toLowerCase().includes("failed") ? 8000 : 4000,
  };
}
