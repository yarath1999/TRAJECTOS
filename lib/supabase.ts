import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase setup notes (Trajectos)
 *
 * 1) Create a Supabase project:
 *    Supabase Dashboard → New project
 *
 * 2) Add env vars locally:
 *    - Copy `.env.local.example` → `.env.local`
 *    - Fill in values from: Project Settings → API
 *
 * 3) Create the DB table:
 *    - Supabase Dashboard → SQL Editor
 *    - Run the migration SQL in `supabase/migrations/0001_financial_profiles.sql`
 */

type SupabaseEnv = {
  url: string;
  anonKey: string;
};

let hasWarnedMissingEnv = false;

function warnMissingEnv(): void {
  if (hasWarnedMissingEnv) return;
  hasWarnedMissingEnv = true;

  // Avoid crashing the UI; missing env is a common local setup issue.
  // Developers can use `.env.local.example` as the source of truth.
  console.warn(
    "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local.",
  );
}

function getSupabaseEnv(): SupabaseEnv | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    warnMissingEnv();
    return null;
  }

  return { url, anonKey };
}

/**
 * Creates a Supabase client using the project's public URL and anon key.
 *
 * Environment variables required:
 * - NEXT_PUBLIC_SUPABASE_URL
 * - NEXT_PUBLIC_SUPABASE_ANON_KEY
 */
export function createSupabaseClient(): SupabaseClient | null {
  const env = getSupabaseEnv();
  if (!env) return null;
  return createClient(env.url, env.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}

/**
 * Creates a Supabase client that will authenticate requests using the provided
 * access token (typically sent as `Authorization: Bearer <token>`).
 *
 * This is useful in server routes where you want to validate the user and then
 * rely on Row Level Security policies.
 */
export function createSupabaseClientWithAccessToken(
  accessToken: string,
): SupabaseClient | null {
  const env = getSupabaseEnv();
  if (!env) return null;

  return createClient(env.url, env.anonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}

export type FinancialProfileUpsert = {
  current_savings: number;
  monthly_savings: number;
  expected_return: number;
  target_amount: number;
  time_horizon: number;
};

export type FinancialProfileRow = FinancialProfileUpsert & {
  user_id: string;
  created_at?: string;
  updated_at?: string;
};

/**
 * Persists the current user's financial profile in Supabase.
 *
 * - Requires an authenticated Supabase user (client-side session).
 * - Uses `upsert` on `financial_profiles` with `user_id` as the unique key.
 *
 * @throws {Error} If the user is not authenticated or the upsert fails.
 */
export async function saveFinancialProfile(
  profile: FinancialProfileUpsert,
): Promise<void> {
  // This helper is intended for client-side usage (browser session).
  const supabase = createSupabaseClient();
  if (!supabase) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    throw new Error("User is not authenticated");
  }

  const userId = userData.user.id;

  const { error } = await supabase.from("financial_profiles").upsert(
    {
      user_id: userId,
      ...profile,
    },
    { onConflict: "user_id" },
  );

  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Loads the current user's financial profile from Supabase.
 *
 * Returns `null` when:
 * - the user is not authenticated, or
 * - no profile exists yet.
 *
 * @throws {Error} For unexpected Supabase errors.
 */
export async function getFinancialProfile(): Promise<FinancialProfileRow | null> {
  const supabase = createSupabaseClient();
  if (!supabase) return null;

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    return null;
  }

  const userId = userData.user.id;

  const { data, error } = await supabase
    .from("financial_profiles")
    .select(
      "user_id,current_savings,monthly_savings,expected_return,target_amount,time_horizon,created_at,updated_at",
    )
    .eq("user_id", userId)
    .maybeSingle();

  // `maybeSingle()` returns `data: null` with no error when no rows match.
  if (error) {
    throw new Error(error.message);
  }

  return (data as FinancialProfileRow | null) ?? null;
}
