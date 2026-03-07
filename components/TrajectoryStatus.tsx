import React from "react";

export type TrajectoryStatusProps = {
  accelerationScore: number;
};

type StatusDef = {
  label: "Strongly Ahead" | "Ahead" | "On Track" | "Behind" | "Off Track";
  containerClassName: string;
  dotClassName: string;
};

function getStatus(accelerationScore: number): StatusDef {
  // Rules:
  // >= 1.2  -> Strongly Ahead
  // >= 1.05 -> Ahead
  // 0.95..1.05 -> On Track
  // 0.80..0.95 -> Behind
  // < 0.80 -> Off Track
  if (accelerationScore >= 1.2) {
    return {
      label: "Strongly Ahead",
      containerClassName: "border-green-200 bg-green-50 text-green-800",
      dotClassName: "bg-green-600",
    };
  }

  if (accelerationScore >= 1.05) {
    return {
      label: "Ahead",
      containerClassName: "border-green-200 bg-green-50 text-green-700",
      dotClassName: "bg-green-500",
    };
  }

  if (accelerationScore >= 0.95 && accelerationScore <= 1.05) {
    return {
      label: "On Track",
      containerClassName: "border-foreground/15 bg-background text-foreground",
      dotClassName: "bg-foreground/40",
    };
  }

  if (accelerationScore >= 0.8) {
    return {
      label: "Behind",
      containerClassName: "border-orange-200 bg-orange-50 text-orange-800",
      dotClassName: "bg-orange-500",
    };
  }

  return {
    label: "Off Track",
    containerClassName: "border-red-200 bg-red-50 text-red-800",
    dotClassName: "bg-red-600",
  };
}

export default function TrajectoryStatus({
  accelerationScore,
}: TrajectoryStatusProps) {
  const status = getStatus(accelerationScore);

  return (
    <div
      className={`rounded-lg border p-4 ${status.containerClassName}`}
      aria-label="Trajectory Status"
    >
      <p className="text-sm font-medium">
        Trajectory Status: <span className="inline-flex items-center gap-2">
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${status.dotClassName}`}
            aria-hidden="true"
          />
          {status.label}
        </span>
      </p>
    </div>
  );
}
