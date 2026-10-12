export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    credentials: "include",
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
      code?: string;
    } | null;
    // The code lets callers tell a named refusal (policy, unconfigured) from
    // a generic failure.
    const error = new Error(
      body?.message ?? `Request failed (${response.status})`,
    ) as Error & { code?: string };
    if (body?.code !== undefined) error.code = body.code;
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
