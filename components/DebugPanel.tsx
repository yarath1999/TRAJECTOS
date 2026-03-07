"use client";

import { useState } from "react";

type DebugInputs = {
  currentSavings: number;
  monthlySavings: number;
  expectedReturn: number;
  targetAmount: number;
  timeHorizon: number;
};

type DebugResult = {
  projectedFutureValue: number;
  nActual: number;
  compression: number;
  accelerationScore?: number;
};

function formatNumber(value: number, decimals = 2) {
  return Number(value.toFixed(decimals));
}

export default function DebugPanel({
  inputs,
  result,
}: {
  inputs: DebugInputs;
  result: DebugResult;
}) {
  const [open, setOpen] = useState(false);

  const projectedFutureValueDisplay = formatNumber(
    result.projectedFutureValue,
    0,
  );
  const nActualDisplay = formatNumber(result.nActual, 2);
  const compressionDisplay = formatNumber(result.compression, 2);
  const accelerationScoreDisplay =
    typeof result.accelerationScore === "number"
      ? formatNumber(result.accelerationScore, 3)
      : null;

  return (
    <div className="mt-6">
      <button
        className="text-xs underline mb-2"
        type="button"
        onClick={() => setOpen(!open)}
      >
        {open ? "Hide Debug Panel" : "Show Debug Panel"}
      </button>

      {open && (
        <div className="border border-foreground/20 rounded-lg p-4 text-xs font-mono bg-foreground/5">
          <div className="font-semibold">DEBUG PANEL</div>

          <div className="mt-3">
            <div className="font-semibold">Inputs</div>
            <div className="mt-1 space-y-0.5">
              <div>PV: {inputs.currentSavings}</div>
              <div>PMT: {inputs.monthlySavings}</div>
              <div>Return: {inputs.expectedReturn}</div>
              <div>Target: {inputs.targetAmount}</div>
              <div>Horizon: {inputs.timeHorizon}</div>
            </div>
          </div>

          <div className="mt-3">
            <div className="font-semibold">Engine Output</div>
            <div className="mt-1 space-y-0.5">
              <div>Projected FV: {projectedFutureValueDisplay}</div>
              <div>Years to target: {nActualDisplay}</div>
              <div>Compression: {compressionDisplay} years</div>
            </div>
          </div>

          {accelerationScoreDisplay !== null ? (
            <div className="mt-3">
              <div className="font-semibold">Acceleration Score</div>
              <div className="mt-1">{accelerationScoreDisplay}</div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
