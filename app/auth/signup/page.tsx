"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { createSupabaseClient } from "@/lib/supabase";

export default function SignupPage() {
  const router = useRouter();

  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const supabase = createSupabaseClient();
    if (!supabase) {
      setError(
        "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
      );
      return;
    }

    setIsSubmitting(true);
    try {
      const { error: signUpError } = await supabase.auth.signUp({
        email,
        password,
      });

      if (signUpError) {
        setError(signUpError.message);
        return;
      }

      router.replace("/");
    } finally {
      setIsSubmitting(false);
    }
  }

  const inputClassName =
    "mt-1 w-full rounded-md border border-foreground/20 bg-background px-3 py-2 text-foreground outline-none focus:border-foreground/40";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto w-full max-w-md px-6 py-12">
        <h1 className="text-2xl font-semibold">Sign up</h1>

        <form onSubmit={onSubmit} className="mt-8 space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClassName}
              required
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClassName}
              required
            />
          </div>

          {error ? (
            <div className="rounded-md border border-foreground/15 p-3">
              <p className="text-sm">{error}</p>
            </div>
          ) : null}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full rounded-md border border-foreground/20 bg-background px-4 py-2 text-sm font-medium text-foreground hover:border-foreground/40 disabled:opacity-60"
          >
            {isSubmitting ? "Signing up…" : "Signup"}
          </button>
        </form>

        <p className="mt-6 text-sm text-foreground/70">
          Already have an account?{" "}
          <a href="/auth/login" className="text-foreground underline">
            Log in
          </a>
        </p>
      </main>
    </div>
  );
}
