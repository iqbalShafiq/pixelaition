import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button, Field, PasswordInput, TextInput } from "../components/ui.js";
import { authClient } from "../lib/auth.js";

export function AuthScreen({ mode }: { mode: "login" | "register" }) {
  const navigate = useNavigate();
  const login = mode === "login";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = login
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name });
      if (result.error) {
        // Same wording for a wrong address and a wrong password, so the screen
        // cannot be used to find out which addresses have accounts.
        setError(
          login
            ? "That email and password do not match an account."
            : (result.error.message ?? "That account could not be created."),
        );
        return;
      }
      await navigate({ to: "/projects" });
    } catch {
      setError("The server did not answer. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="panel-grid grid min-h-dvh place-items-center bg-paper px-4 py-10">
      <div className="w-full max-w-[26rem]">
        <header className="mb-6 flex items-center gap-2.5">
          <svg
            width="18"
            height="18"
            viewBox="0 0 8 8"
            shapeRendering="crispEdges"
            aria-hidden
          >
            <rect x="0" y="0" width="4" height="4" fill="var(--color-accent)" />
            <rect x="4" y="0" width="4" height="4" fill="var(--color-ink)" />
            <rect x="0" y="4" width="4" height="4" fill="var(--color-ink)" />
            <rect x="4" y="4" width="4" height="4" fill="var(--color-accent)" />
          </svg>
          <span className="font-mono text-xs tracking-[0.22em] text-accent">
            PIXELAITION
          </span>
        </header>

        <section className="rounded-xl border border-line bg-panel p-6">
          <h1 className="text-[1.75rem] leading-tight font-medium tracking-[-0.01em] text-ink text-balance">
            {login ? "Sign in" : "Create your studio"}
          </h1>
          <p className="mt-1.5 text-[13px] text-muted">
            {login
              ? "Pick up the pixel family you left."
              : "One account holds every project, palette, and style guide."}
          </p>

          <form className="mt-6 grid gap-4" onSubmit={(event) => void submit(event)}>
            {login ? null : (
              <Field label="Name" htmlFor="auth-name">
                <TextInput
                  id="auth-name"
                  name="name"
                  autoComplete="name"
                  autoFocus
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
            )}

            <Field label="Email" htmlFor="auth-email">
              <TextInput
                id="auth-email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoFocus={login}
                required
                invalid={Boolean(error) && !login}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>

            <Field
              label="Password"
              htmlFor="auth-password"
              hint={login ? undefined : "at least 8 characters"}
            >
              <PasswordInput
                id="auth-password"
                name="password"
                autoComplete={login ? "current-password" : "new-password"}
                minLength={8}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>

            {error ? (
              <p
                role="alert"
                className="rounded-md border border-erase/40 bg-erase/10 px-3 py-2 text-[13px] text-erase"
              >
                {error}
              </p>
            ) : null}

            <Button
              type="submit"
              tone="solid"
              disabled={busy}
              className="min-h-11 w-full"
            >
              {busy ? "Working" : login ? "Sign in" : "Create account"}
            </Button>
          </form>

          <p className="mt-5 border-t border-line pt-4 text-[13px] text-muted">
            {login ? "No account yet? " : "Already registered? "}
            <Link
              to={login ? "/register" : "/login"}
              className="text-ink underline underline-offset-4 hover:text-accent"
            >
              {login ? "Create one" : "Sign in"}
            </Link>
          </p>
        </section>

        <p className="mt-4 text-center font-mono text-[11px] text-muted">
          MIT licensed ·{" "}
          <a
            href="https://github.com/iqbalShafiq/pixelaition"
            className="underline underline-offset-2 hover:text-muted"
            rel="noreferrer noopener"
            target="_blank"
          >
            source on GitHub
          </a>
        </p>
      </div>
    </main>
  );
}
