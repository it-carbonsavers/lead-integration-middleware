"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, ApiError, type Me } from "@/lib/api";
import { cacheMe, clearCachedMe } from "@/lib/session-cache";
import { Button, Field, Input } from "@/components/ui";
import { Logo } from "@/components/brand";

function LoginForm() {
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      clearCachedMe();
      await api.post("/auth/login", { email, password });
      // Remember who signed in, so the first page draws straight away (see lib/session-cache).
      await api
        .get<Me>("/auth/me")
        .then(cacheMe)
        .catch(() => {});
      const next = params.get("next");
      window.location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? "Too many attempts. Please wait a minute."
          : "Incorrect email or password, or the account is temporarily locked.",
      );
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Email">
        <Input
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Field label="Password">
        <Input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" loading={busy} className="w-full">
        Sign in
      </Button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen bg-slate-50">
      {/* Brand panel (large screens): Slate Gray with the Mantis + white logo and the six-dot motif. */}
      <section className="relative hidden w-[44%] overflow-hidden bg-cs-slate p-12 text-cs-cream lg:flex lg:flex-col lg:justify-between">
        <div
          aria-hidden
          className="absolute -bottom-40 -right-40 h-[28rem] w-[28rem] rounded-full bg-emerald-500/15"
        />
        <div
          aria-hidden
          className="absolute -right-10 top-24 h-48 w-48 rounded-full bg-emerald-500/10"
        />
        <Logo variant="mantis-white" width={210} priority />
        <div className="relative max-w-sm">
          <h2 className="text-3xl font-bold leading-tight text-white">
            Every lead, every consent, in one place.
          </h2>
          <p className="mt-3 text-base text-cs-cream">
            Leads from our partners arrive here, go straight to the CRM, and are matched with their
            consent recordings.
          </p>
        </div>
        <p className="relative text-xs text-cs-cream/80">Carbon Savers · Lead Integration</p>
      </section>

      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center">
            <Logo width={170} className="mb-2 lg:hidden" priority />
            <h1 className="text-2xl font-bold text-slate-900">Sign in</h1>
            <p className="mt-1 text-sm text-slate-500">
              Lead Integration · staff and partner portal
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <Suspense>
              <LoginForm />
            </Suspense>
          </div>
        </div>
      </div>
    </main>
  );
}
