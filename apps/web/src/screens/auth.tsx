import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AuthDemo } from "../components/auth-demo.js";
import { Button, Field, PasswordInput, TextInput } from "../components/ui.js";
import { authClient } from "../lib/auth.js";
import { FLIGHT_AUTH_TYPE, navigateTyped } from "../lib/transition.js";
import { useMediaQuery } from "../lib/use-media.js";

export function AuthScreen({ mode }: { mode: "login" | "register" }) {
  const navigate = useNavigate();
  const login = mode === "login";
  const wide = useMediaQuery("(min-width: 1024px)");
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
      // Signing in is a move, not a page swap: the brand flies into the bar
      // and the library rises under it.
      await navigateTyped(
        (options) => navigate({ to: "/projects", state: { door: "auth" }, ...options }),
        FLIGHT_AUTH_TYPE,
        () => navigate({ to: "/projects", state: { door: "auth" } }),
      );
    } catch {
      setError("The server did not answer. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col bg-paper lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(28rem,36rem)]">
      {wide ? <AuthDemo /> : <AuthDemo compact />}

      <section className="flex flex-1 flex-col bg-panel px-6 py-8 sm:px-10 lg:min-h-dvh lg:justify-center lg:border-l-2 lg:border-line lg:px-10">
        <div className="mx-auto w-full max-w-md">
          <p className="text-pixel-mono text-muted">Account</p>
          <h1 className="mt-2 text-pixel-display text-balance text-ink">
            {login ? "Sign in" : "Create your workspace"}
          </h1>
          <p className="mt-3 text-pixel-body text-muted">
            {login
              ? "Pick up the image family you left."
              : "One account holds every project, palette, and style guide."}
          </p>

          <form className="mt-8 grid gap-4" onSubmit={(event) => void submit(event)}>
            {login ? null : (
              <Field label="Name" htmlFor="auth-name">
                <TextInput
                  id="auth-name"
                  name="name"
                  autoComplete="name"
                  autoFocus
                  required
                  placeholder="Ada Lovelace"
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
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>

            <Field
              label="Password"
              htmlFor="auth-password"
              note={login ? undefined : "At least 8 characters."}
            >
              <PasswordInput
                id="auth-password"
                name="password"
                autoComplete={login ? "current-password" : "new-password"}
                minLength={8}
                required
                placeholder={login ? "your password" : "pick something long"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>

            {error ? (
              <p
                role="alert"
                className="border-2 border-erase bg-field px-3 py-2 text-pixel-label text-erase"
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

            <p className="text-pixel-label text-muted">
              {login ? "No account yet? " : "Already registered? "}
              <Link
                to={login ? "/register" : "/login"}
                className="text-ink underline underline-offset-4 hover:text-accent"
              >
                {login ? "Create one" : "Sign in"}
              </Link>
            </p>
          </form>

          <p className="mt-10 text-pixel-mono text-muted">
            MIT licensed ·{" "}
            <a
              href="https://github.com/iqbalShafiq/pixelaition"
              className="underline underline-offset-2 hover:text-ink"
              rel="noreferrer noopener"
              target="_blank"
            >
              source on GitHub
            </a>
          </p>
        </div>
      </section>
    </main>
  );
}
