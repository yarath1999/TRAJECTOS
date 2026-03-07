import { NextResponse, type NextRequest } from "next/server";

import { createSupabaseClientWithAccessToken } from "@/lib/supabase";

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
  try {
    const authHeader = req.headers.get("authorization") ?? "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return NextResponse.json(
        { error: "Missing Authorization Bearer token" },
        { status: 401 },
      );
    }

    const accessToken = match[1];
    const supabase = createSupabaseClientWithAccessToken(accessToken);
    if (!supabase) {
      return NextResponse.json(
        { error: "Supabase is not configured on the server" },
        { status: 500 },
      );
    }

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: SaveProfileBody;
    try {
      body = (await req.json()) as SaveProfileBody;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
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
      return NextResponse.json(
        { error: error.message },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, profile: data }, { status: 200 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unexpected error";
    const status = e instanceof TypeError ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
