"use client";

import { useEffect, useRef, useState } from "react";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { futureValue } from "@/lib/finance";

export type ProjectionGraphProps = {
  /** Present value (current savings). */
  PV: number;
  /** Monthly contribution. */
  PMT: number;
  /** Expected annual return (decimal, e.g. 0.10). */
  r: number;
  /** Time horizon in years; chart will plot yearly points from 0..n (integer years). */
  n: number;
};

type DataPoint = {
  year: number;
  baseline: number;
  shock?: number;
};

function assertFiniteNumber(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

function formatINRCurrency(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
}

export default function ProjectionGraph({
  PV,
  PMT,
  r,
  n,
}: ProjectionGraphProps) {
  const chartHostRef = useRef<HTMLDivElement | null>(null);
  const [chartSize, setChartSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  useEffect(() => {
    const element = chartHostRef.current;
    if (!element) return;

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      const nextWidth = Math.max(0, Math.floor(rect.width));
      const nextHeight = Math.max(0, Math.floor(rect.height));
      setChartSize((prev) => {
        if (prev.width === nextWidth && prev.height === nextHeight) {
          return prev;
        }
        return { width: nextWidth, height: nextHeight };
      });
    };

    updateSize();

    const observer = new ResizeObserver(() => {
      updateSize();
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, []);

  assertFiniteNumber("PV", PV);
  assertFiniteNumber("PMT", PMT);
  assertFiniteNumber("r", r);
  assertFiniteNumber("n", n);

  // Generate whole-year points from 0 to n.
  // If n is non-integer, this naturally includes 0..floor(n).
  const maxYear = Math.max(0, Math.floor(n));

  // Inflation shock scenario: return reduced by 1%.
  const rShock = r - 0.01;
  const hasShock = rShock >= 0;

  // Generate discrete yearly projection points.
  // Each point uses the same annual compounding model as the rest of the engine.
  const data: DataPoint[] = [];
  for (let year = 0; year <= maxYear; year++) {
    const baseline = futureValue(PV, PMT, r, year);

    if (hasShock) {
      data.push({
        year,
        baseline,
        shock: futureValue(PV, PMT, rShock, year),
      });
    } else {
      // Do not generate shock data when the shocked rate is negative.
      data.push({ year, baseline });
    }
  }

  const canRenderChart = chartSize.width > 0 && chartSize.height > 0;

  return (
    <div className="h-96 min-h-96 w-full min-w-0 rounded-lg border border-foreground/15 p-3">
      <div ref={chartHostRef} className="h-full w-full min-h-0 min-w-0">
        {canRenderChart ? (
          <LineChart
            width={chartSize.width}
            height={chartSize.height}
            data={data}
            margin={{ top: 8, right: 12, bottom: 8, left: 12 }}
          >
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="year"
            tickMargin={8}
            label={{ value: "Years", position: "insideBottom", offset: -5 }}
          />
          <YAxis
            domain={["auto", "auto"]}
            tickMargin={8}
            tickFormatter={(value) =>
              new Intl.NumberFormat("en-IN").format(Number(value))
            }
            label={{
              value: "Wealth (₹)",
              angle: -90,
              position: "insideLeft",
            }}
            width={84}
          />
          <Tooltip
            formatter={(value) => formatINRCurrency(Number(value))}
            labelFormatter={(label) => `Year ${label}`}
          />
          <Legend />
          <Line
            type="monotoneX"
            dataKey="baseline"
            name="Baseline projection"
            stroke="#2563eb"
            dot={false}
            strokeWidth={2}
          />
          {hasShock ? (
            <Line
              type="monotone"
              dataKey="shock"
              name="Shock projection"
              stroke="#dc2626"
              dot={false}
              strokeWidth={2}
            />
          ) : null}
          </LineChart>
        ) : null}
      </div>
    </div>
  );
}
