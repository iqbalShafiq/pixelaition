import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button, Card, Field, TextInput } from "../components/ui.js";
import { authClient } from "../lib/auth.js";

export function AuthScreen({ mode }: { mode: "login" | "register" }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const result =
      mode === "login"
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name });
    if (result.error) {
      setError(result.error.message ?? "Could not sign in.");
      return;
    }
    await navigate({ to: "/projects" });
  }

  return (
    <main className="mx-auto grid min-h-screen max-w-md place-items-center px-4">
      <Card className="w-full">
        <p className="font-mono text-xs tracking-[0.2em] text-accent">PIXELAITION</p>
        <h1 className="mt-2 text-2xl">
          {mode === "login" ? "Sign in" : "Create an account"}
        </h1>
        <form className="mt-6 grid gap-3" onSubmit={(event) => void submit(event)}>
          {mode === "register" ? (
            <Field label="Name">
              <TextInput
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </Field>
          ) : null}
          <Field label="Email">
            <TextInput
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </Field>
          <Field label="Password">
            <TextInput
              type="password"
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </Field>
          {error ? <p className="text-sm text-erase">{error}</p> : null}
          <Button type="submit">{mode === "login" ? "Sign in" : "Create account"}</Button>
        </form>
        <p className="mt-4 text-sm text-muted">
          {mode === "login" ? (
            <Link to="/register">Need an account?</Link>
          ) : (
            <Link to="/login">Already registered?</Link>
          )}
        </p>
      </Card>
    </main>
  );
}
