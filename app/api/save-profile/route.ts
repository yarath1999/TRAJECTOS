import { NextResponse, type NextRequest } from "next/server";

import { createSupabaseClientWithAccessToken } from "@/lib/supabase";
import { createCorrelationId, withPerformanceContext } from "@/utils/performanceTracker";
import { logEvent, logWarn } from "@/utils/logger";

type SaveProfileBody = {
  currentSavings?: unknown;
  monthlySavings?: unknown;
  expectedReturn?: unknown;
  targetAmount?: unknown;
  timeHorizon?: unknown;

  // Also accept snake_case keys to match the DB schema.
  current_savings?: unknown;
  monthly_savings?: unknown;
  expected_return?: unknown;
  target_amount?: unknown;
  time_horizon?: unknown;
};

function asFiniteNumber(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return value;
}

export async function POST(req: NextRequest) {
  const correlationId = (req.headers.get("x-correlation-id") ?? "").trim() || createCorrelationId("request");

  return withPerformanceContext({ correlation_id: correlationId }, async () => {
    const withCorrelation = (response: NextResponse): NextResponse => {
      response.headers.set("x-correlation-id", correlationId);
      return response;
    };

    logEvent("PROFILE_SAVE_REQUEST", { correlation_id: correlationId, method: "POST" }, "INFO");

    try {
      const authHeader = req.headers.get("authorization") ?? "";
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (!match) {
        logWarn("PROFILE_SAVE_AUTH_MISSING", { correlation_id: correlationId });
        return withCorrelation(
          NextResponse.json(
            { error: "Missing Authorization Bearer token" },
            { status: 401 },
          ),
        );
      }

      const accessToken = match[1];
      const supabase = createSupabaseClientWithAccessToken(accessToken);
      if (!supabase) {
        logWarn("PROFILE_SAVE_SUPABASE_UNAVAILABLE", { correlation_id: correlationId });
        return withCorrelation(
          NextResponse.json(
            { error: "Supabase is not configured on the server" },
            { status: 500 },
          ),
        );
      }

      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData.user) {
        logWarn("PROFILE_SAVE_UNAUTHORIZED", { correlation_id: correlationId });
        return withCorrelation(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
      }

      let body: SaveProfileBody;
      try {
        body = (await req.json()) as SaveProfileBody;
      } catch {
        logWarn("PROFILE_SAVE_INVALID_JSON", { correlation_id: correlationId });
        return withCorrelation(NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }));
      }

    const currentSavings = asFiniteNumber(
      "currentSavings",
      body.currentSavings ?? body.current_savings,
    );
    const monthlySavings = asFiniteNumber(
      "monthlySavings",
      body.monthlySavings ?? body.monthly_savings,
    );
    const expectedReturn = asFiniteNumber(
      "expectedReturn",
      body.expectedReturn ?? body.expected_return,
    );
    const targetAmount = asFiniteNumber(
      "targetAmount",
      body.targetAmount ?? body.target_amount,
    );
    const timeHorizon = asFiniteNumber(
      "timeHorizon",
      body.timeHorizon ?? body.time_horizon,
    );

      const userId = userData.user.id;

      const { data, error } = await supabase
        .from("financial_profiles")
        .upsert(
          {
            user_id: userId,
            current_savings: currentSavings,
            monthly_savings: monthlySavings,
            expected_return: expectedReturn,
            target_amount: targetAmount,
            time_horizon: timeHorizon,
          },
          { onConflict: "user_id" },
        )
        .select()
        .single();

      if (error) {
        logWarn("PROFILE_SAVE_FAILED", { correlation_id: correlationId, error: error.message });
        return withCorrelation(
          NextResponse.json(
            { error: error.message },
            { status: 500 },
          ),
        );
      }

      logEvent("PROFILE_SAVE_SUCCESS", { correlation_id: correlationId, user_id: userId }, "INFO");
      return withCorrelation(NextResponse.json({ ok: true, profile: data }, { status: 200 }));
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unexpected error";
      const status = e instanceof TypeError ? 400 : 500;
      logWarn("PROFILE_SAVE_ERROR", { correlation_id: correlationId, error: message, status });
      return withCorrelation(NextResponse.json({ error: message }, { status }));
    }
  });
}
