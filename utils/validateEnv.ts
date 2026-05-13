import { logEvent, logError, logWarn } from "./logger";

type EnvGroup = {
  names: string[];
  label?: string;
};

export type ValidateEnvOptions = {
  serviceName: string;
  required?: string[];
  anyOf?: EnvGroup[];
  optional?: string[];
};

type EnvIssue = {
  name: string;
  reason: string;
  required: boolean;
};

function hasValue(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0;
}

function formatIssue(issue: EnvIssue): string {
  return issue.required
    ? `${issue.name}: ${issue.reason}`
    : `${issue.name} (optional): ${issue.reason}`;
}

export function validateEnvOrThrow(options: ValidateEnvOptions): void {
  const issues: EnvIssue[] = [];
  const validated: string[] = [];

  for (const name of options.required ?? []) {
    if (hasValue(name)) {
      validated.push(name);
      continue;
    }

    issues.push({ name, reason: "missing or empty", required: true });
  }

  for (const group of options.anyOf ?? []) {
    const present = group.names.filter((name) => hasValue(name));
    if (present.length > 0) {
      validated.push(...present);
      continue;
    }

    issues.push({
      name: group.label ?? group.names.join(" | "),
      reason: `one of [${group.names.join(", ")}] must be set`,
      required: true,
    });
  }

  const optionalMissing = (options.optional ?? []).filter((name) => !hasValue(name));

  if (issues.length > 0) {
    logError("ENV_VALIDATION_FAILED", {
      service: options.serviceName,
      issues,
    });

    throw new Error(
      [
        `Startup validation failed for ${options.serviceName}`,
        ...issues.map(formatIssue),
      ].join("\n"),
    );
  }

  if (optionalMissing.length > 0) {
    logWarn("ENV_VALIDATION_OPTIONAL_MISSING", {
      service: options.serviceName,
      optionalMissing,
    });
  }

  logEvent(
    "ENV_VALIDATION_OK",
    {
      service: options.serviceName,
      validated,
      optionalMissing,
    },
    "INFO",
  );
}
