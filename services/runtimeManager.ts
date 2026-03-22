import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

import { validatePipelineSchemaOrThrow } from "./schemaValidator";

type ServiceKind = "daemon" | "scheduled";

type ManagedService = {
  name: string;
  kind: ServiceKind;
  command: string;
  args: string[];
  restartOnCrash: boolean;
};

type RuntimeOptions = {
  ingestEveryMs?: number;
};

type SupervisorState = {
  shuttingDown: boolean;
  children: Map<string, ChildProcessWithoutNullStreams>;
  timers: Set<NodeJS.Timeout>;
  ingestRunning: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function npxCmd(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function timestamp(): string {
  return new Date().toISOString();
}

function log(name: string, message: string): void {
  console.log(`[${timestamp()}] [runtime] [${name}] ${message}`);
}

function wireOutput(name: string, child: ChildProcessWithoutNullStreams): void {
  const prefix = `[${name}] `;

  child.stdout.on("data", (buf: Buffer) => {
    const text = buf.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      process.stdout.write(prefix + line + "\n");
    }
  });

  child.stderr.on("data", (buf: Buffer) => {
    const text = buf.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      process.stderr.write(prefix + line + "\n");
    }
  });
}

function spawnService(proc: ManagedService): ChildProcessWithoutNullStreams {
  const child = spawn(proc.command, proc.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  wireOutput(proc.name, child);
  return child;
}

async function superviseDaemon(state: SupervisorState, service: ManagedService): Promise<void> {
  let attempt = 0;

  while (!state.shuttingDown) {
    attempt += 1;
    log(service.name, `starting (attempt=${attempt})`);

    const child = spawnService(service);
    state.children.set(service.name, child);

    const exitCode: number | null = await new Promise((resolve) => {
      child.on("exit", (code) => resolve(code));
    });

    state.children.delete(service.name);

    if (state.shuttingDown) {
      log(service.name, `stopped (exit=${exitCode ?? "null"})`);
      return;
    }

    log(service.name, `crashed (exit=${exitCode ?? "null"})`);

    if (!service.restartOnCrash) return;

    const backoffMs = Math.min(30_000, 1_000 * Math.pow(2, Math.min(5, attempt)));
    log(service.name, `restarting in ${backoffMs}ms`);
    await sleep(backoffMs);
  }
}

async function runIngestOnce(state: SupervisorState, service: ManagedService): Promise<void> {
  if (state.shuttingDown) return;
  if (state.ingestRunning) {
    log(service.name, "skipping (previous run still active)");
    return;
  }

  state.ingestRunning = true;
  try {
    log(service.name, "starting one-shot run");
    const child = spawnService(service);
    state.children.set(service.name, child);

    const exitCode: number | null = await new Promise((resolve) => {
      child.on("exit", (code) => resolve(code));
    });

    state.children.delete(service.name);

    if (exitCode === 0) {
      log(service.name, "completed successfully");
    } else {
      log(service.name, `failed (exit=${exitCode ?? "null"})`);
    }
  } finally {
    state.ingestRunning = false;
  }
}

function scheduleIngest(state: SupervisorState, service: ManagedService, everyMs: number): void {
  const timer = setInterval(() => {
    runIngestOnce(state, service).catch((err) => {
      log(service.name, `ingest run error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, everyMs);

  state.timers.add(timer);

  // Kick once immediately on startup.
  runIngestOnce(state, service).catch((err) => {
    log(service.name, `initial ingest error: ${err instanceof Error ? err.message : String(err)}`);
  });
}

function shutdown(state: SupervisorState): void {
  if (state.shuttingDown) return;
  state.shuttingDown = true;

  log("manager", "shutting down");

  for (const t of state.timers) {
    clearInterval(t);
    clearTimeout(t);
  }
  state.timers.clear();

  for (const [name, child] of state.children.entries()) {
    try {
      log(name, "sending termination signal");
      // On Windows, kill() ignores the signal string.
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

export async function startRuntime(options?: RuntimeOptions): Promise<void> {
  const ingestEveryMs = options?.ingestEveryMs ?? 5 * 60_000;

  const state: SupervisorState = {
    shuttingDown: false,
    children: new Map(),
    timers: new Set(),
    ingestRunning: false,
  };

  process.on("SIGINT", () => shutdown(state));
  process.on("SIGTERM", () => shutdown(state));

  const services: ManagedService[] = [
    {
      name: "pipelineListener",
      kind: "daemon",
      command: npxCmd(),
      args: ["tsx", "services/pipelineListener.ts"],
      restartOnCrash: true,
    },
    {
      name: "pipelineMonitor",
      kind: "daemon",
      command: npxCmd(),
      args: ["tsx", "services/pipelineMonitor.ts"],
      restartOnCrash: true,
    },
    {
      name: "pipelineInvariantMonitor",
      kind: "daemon",
      command: npxCmd(),
      args: ["tsx", "services/pipelineInvariantMonitor.ts"],
      restartOnCrash: true,
    },
    {
      name: "newsFetcher",
      kind: "scheduled",
      command: npxCmd(),
      args: ["tsx", "services/newsFetcherRunner.ts"],
      restartOnCrash: false,
    },
  ];

  log("schemaValidator", "validating required tables");
  await validatePipelineSchemaOrThrow();

  log("manager", "starting runtime services");

  // Start daemons.
  const daemonPromises = services
    .filter((s) => s.kind === "daemon")
    .map((s) => superviseDaemon(state, s));

  // Schedule ingestion.
  const ingestService = services.find((s) => s.name === "newsFetcher");
  if (ingestService) {
    scheduleIngest(state, ingestService, ingestEveryMs);
  }

  // Wait for daemons (this keeps the process alive).
  await Promise.all(daemonPromises);
}

function isMainModule(): boolean {
  try {
    const current = fileURLToPath(import.meta.url);
    const invoked = process.argv[1] ?? "";
    const invokedAbs = path.resolve(process.cwd(), invoked);
    return path.normalize(invokedAbs).toLowerCase() === path.normalize(current).toLowerCase();
  } catch {
    return false;
  }
}

// Runnable via: npx tsx services/runtimeManager.ts
if (isMainModule()) {
  startRuntime().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
