"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import InputForm, { type FinancialInputs } from "@/components/InputForm";
import DebugPanel from "@/components/DebugPanel";
import CauseCard from "@/components/CauseCard";
import InsightCard from "@/components/InsightCard";
import ImprovementSuggestions from "@/components/ImprovementSuggestions";
import LeverSuggestion from "@/components/LeverSuggestion";
import ProjectionGraph from "@/components/ProjectionGraph";
import ScenarioSimulator from "@/components/ScenarioSimulator";
import TrajectoryStatus from "@/components/TrajectoryStatus";
import ReturnInsight from "@/components/ReturnInsight";
import MarketScenarios from "@/components/MarketScenarios";
import { analyzeTrajectory, type TrajectoryAnalysis } from "@/services/trajectoryService";
import {
  createSupabaseClient,
  getFinancialProfile,
  saveFinancialProfile,
} from "@/lib/supabase";

type ResultState = TrajectoryAnalysis | null;

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(
    value,
  );
}

export default function Home() {
  const router = useRouter();

  const SHOW_DEBUG_PANEL = true;

  const [result, setResult] = useState<ResultState>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<FinancialInputs | null>(null);
  const [isAuthChecked, setIsAuthChecked] = useState<boolean>(false);
  const didAutoRunFromProfile = useRef<boolean>(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const supabase = createSupabaseClient();
      if (!supabase) {
        if (!cancelled) {
          setError(
            "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
          );
        }
        return;
      }

      const { data, error: sessionError } = await supabase.auth.getSession();
      if (cancelled) return;

      if (sessionError || !data.session) {
        router.replace("/auth/login");
        return;
      }

      setIsAuthChecked(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  async function handleLogout() {
    const supabase = createSupabaseClient();
    if (!supabase) {
      setError(
        "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
      );
      return;
    }

    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) {
      setError(signOutError.message);
      return;
    }

    router.replace("/auth/login");
  }

  const handleSubmit = useCallback((values: FinancialInputs) => {
    try {
      setError(null);

      // UI inputs are percent; analysis service expects decimal.
      const engineInputs = {
        currentSavings: values.currentSavings,
        monthlySavings: values.monthlySavings,
        expectedReturn: values.expectedReturn / 100,
        targetAmount: values.targetAmount,
        timeHorizon: values.timeHorizon,
      };

      const analysis = analyzeTrajectory(engineInputs);
      setResult(analysis);

      setInputs(values);

      // Persist inputs for the authenticated user.
      // Store expected_return as a decimal rate (engine format).
      void saveFinancialProfile({
        current_savings: values.currentSavings,
        monthly_savings: values.monthlySavings,
        expected_return: engineInputs.expectedReturn,
        target_amount: values.targetAmount,
        time_horizon: values.timeHorizon,
      }).catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to save profile");
      });
    } catch (e) {
      setResult(null);
      setInputs(null);
      setError(e instanceof Error ? e.message : "Calculation failed");
    }
  }, []);

  useEffect(() => {
    if (!isAuthChecked) return;
    if (didAutoRunFromProfile.current) return;

    let cancelled = false;

    void (async () => {
      try {
        const profile = await getFinancialProfile();
        if (!profile || cancelled) return;

        // expected_return is stored as a decimal, but the form takes % input.
        const loadedInputs: FinancialInputs = {
          currentSavings: Number(profile.current_savings),
          monthlySavings: Number(profile.monthly_savings),
          expectedReturn: Number(profile.expected_return) * 100,
          targetAmount: Number(profile.target_amount),
          timeHorizon: Number(profile.time_horizon),
        };

        // Ensure inputs state reflects the loaded profile immediately.
        setInputs(loadedInputs);

        // Immediately run the same calculation pipeline as manual submit.
        didAutoRunFromProfile.current = true;
        handleSubmit(loadedInputs);
      } catch {
        // Silently ignore load errors for now; the user can still use the form.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [handleSubmit, isAuthChecked]);

  if (!isAuthChecked) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <main className="mx-auto w-full max-w-2xl px-6 py-10">
          <h1 className="text-2xl font-semibold">Trajectos</h1>
          <p className="mt-2 text-sm text-foreground/70">Loading…</p>
          {error ? (
            <div className="mt-6 rounded-lg border border-foreground/15 p-4">
              <p className="text-sm">{error}</p>
            </div>
          ) : null}
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto w-full max-w-2xl px-6 py-10">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Trajectos</h1>
            <p className="text-xs text-foreground/50 mt-1">
              Version 0.1 — Experimental
            </p>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="rounded-md border border-foreground/20 bg-background px-3 py-2 text-sm font-medium text-foreground hover:border-foreground/40"
          >
            Logout
          </button>
        </div>
        <p className="mt-1 text-sm text-foreground/70">
          Enter inputs to project value and schedule.
        </p>

        <section className="mt-8">
          <h2 className="text-lg font-semibold">Financial Profile</h2>
          <div className="mt-3 rounded-lg border border-foreground/15 p-5">
            <InputForm
              onSubmit={handleSubmit}
              initialValues={inputs ?? undefined}
            />
          </div>
        </section>

        {error ? (
          <div className="mt-6 rounded-lg border border-foreground/15 p-4">
            <p className="text-sm">{error}</p>
          </div>
        ) : null}


        {result ? (
          <section className="mt-8">
            <h2 className="text-lg font-semibold">Trajectory Analysis</h2>
            <div className="mt-3 rounded-lg border border-foreground/15 p-4">
              <div className="text-sm">
                <p>
                  Projected future value: {formatNumber(result.projectedFutureValue)}
                </p>
                <p>Years to reach target: {formatNumber(result.nActual)}</p>
                <p>
                  {result.compression === 0
                    ? "You are on track for your target"
                    : (() => {
                        const months = Math.round(
                          Math.abs(result.compression * 12),
                        );
                        return result.compression < 0
                          ? `You are ${months} months behind your target`
                          : `You are ${months} months ahead of your target`;
                      })()}
                </p>
                <p className="mt-2">
                  Inflation shock adds {formatNumber(result.shock.monthsAdded)}
                  months to your timeline.
                </p>
              </div>
            </div>

            <ReturnInsight message={result.returnInsight.message} />
          </section>
        ) : null}

        {result && inputs ? (
          <section className="mt-8">
            <h2 className="text-lg font-semibold">Trajectory Diagnosis</h2>

            <div className="mt-3">
              <TrajectoryStatus accelerationScore={result.accelerationScore} />
            </div>

            <InsightCard title={result.insight.title} message={result.insight.message} />

            <CauseCard primary={result.cause.primary} secondary={result.cause.secondary} />

            <div className="rounded-lg border border-foreground/15 p-4 mt-6">
              <p className="text-sm font-medium">
                Acceleration Score: {formatNumber(result.accelerationScore)}
              </p>
              <p className="mt-1 text-sm text-foreground/70">
                {result.accelerationScore > 1
                  ? "You are accelerating ahead of your target"
                  : result.accelerationScore === 1
                    ? "You are exactly on track"
                    : "You are below the required pace"}
              </p>
            </div>
          </section>
        ) : null}

        {result ? (
          <section className="mt-8">
            <h2 className="text-lg font-semibold">Improvement Plan</h2>

            {result.compression < 0 ? (
              <ImprovementSuggestions suggestions={result.improvements} />
            ) : null}

            <div className="mt-4">
              <LeverSuggestion
                isBehind={result.compression < 0}
                increaseMonthlySavings={result.increaseMonthlySavings ?? undefined}
              />
            </div>
          </section>
        ) : null}

        {result && inputs ? (
          <ScenarioSimulator scenarios={result.scenarios} />
        ) : null}

        {result && inputs ? (
          <MarketScenarios
            marketScenarios={result.marketScenarios}
            timeHorizon={inputs.timeHorizon}
          />
        ) : null}

        {result && inputs ? (
          <section className="mt-8">
            <h2 className="text-lg font-semibold">Projection</h2>
            <div className="mt-3">
              <ProjectionGraph
                PV={inputs.currentSavings}
                PMT={inputs.monthlySavings}
                r={inputs.expectedReturn / 100}
                n={inputs.timeHorizon}
              />
            </div>

            <div className="mt-4 rounded-lg border border-foreground/15 p-4">
              <div className="text-xs font-semibold text-foreground/60">
                Assumptions
              </div>
              <p className="mt-2 text-xs text-foreground/60">
                This projection assumes an average annual return equal to the
                expected return entered above. Actual investment performance may
                vary depending on market conditions and investment choices.
              </p>
            </div>
          </section>
        ) : null}

        {SHOW_DEBUG_PANEL && result && inputs ? (
          <DebugPanel
            inputs={{
              currentSavings: inputs.currentSavings,
              monthlySavings: inputs.monthlySavings,
              expectedReturn: inputs.expectedReturn / 100,
              targetAmount: inputs.targetAmount,
              timeHorizon: inputs.timeHorizon,
            }}
            result={{
              projectedFutureValue: result.projectedFutureValue,
              nActual: result.nActual,
              compression: result.compression,
              accelerationScore: result.accelerationScore,
            }}
          />
        ) : null}
      </main>
    </div>
  );
}
