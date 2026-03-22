import { Client, type Notification } from "pg";
import { fileURLToPath } from "url";
import path from "path";

import { handlePipelineEventById } from "./pipelineOrchestrator";

type ListenerOptions = {
  connectionString: string;
  channel?: string;
  reconnectDelayMs?: number;
};

type PipelineEventCreatedNotification = {
  event_id?: string;
  event_type?: string;
  cluster_id?: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNotificationPayload(
  payload: string | null | undefined,
): PipelineEventCreatedNotification | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== "object") return null;

    const obj = parsed as Record<string, unknown>;
    const eventId = obj.event_id;
    const eventType = obj.event_type;
    const clusterId = obj.cluster_id;

    return {
      event_id: typeof eventId === "string" ? eventId : undefined,
      event_type: typeof eventType === "string" ? eventType : undefined,
      cluster_id:
        typeof clusterId === "string" ? clusterId : clusterId === null ? null : undefined,
    };
  } catch {
    return null;
  }
}

async function connectAndListen(options: ListenerOptions): Promise<never> {
  const channel = options.channel ?? "pipeline_event_created";

  // Dedicated connection for LISTEN/NOTIFY.
  const client = new Client({
    connectionString: options.connectionString,
    application_name: "trajectos_pipeline_listener",
    keepAlive: true,
  });

  client.on("error", (err) => {
    // The outer loop will reconnect.
    console.error("[pipelineListener] pg client error", err);
  });

  await client.connect();
  await client.query(`listen ${channel}`);

  console.log(`[pipelineListener] LISTEN ${channel} (connected)`);

  client.on("notification", async (msg: Notification) => {
    if (msg.channel !== channel) return;

    const parsed = parseNotificationPayload(msg.payload);
    if (!parsed?.event_id) return;

    try {
      await handlePipelineEventById(parsed.event_id);
    } catch (err) {
      console.error("[pipelineListener] failed handling event", parsed, err);
    }
  });

  // Keep the promise pending forever. If the connection drops, 'error' triggers and
  // pg will eventually cause queries to reject; we also keep a heartbeat loop.
  while (true) {
    try {
      await client.query("select 1");
    } catch {
      try {
        await client.end();
      } catch {
        // ignore
      }
      throw new Error("LISTEN connection lost");
    }

    await sleep(30_000);
  }
}

/**
 * Starts a real-time pipeline listener using PostgreSQL LISTEN/NOTIFY.
 *
 * Required env:
 * - DATABASE_URL (direct Postgres connection string)
 */
export async function runPipelineListener(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Missing DATABASE_URL env var for Postgres LISTEN/NOTIFY");
  }

  const reconnectDelayMs = 2_000;

  console.log("[pipelineListener] starting");

  while (true) {
    try {
      await connectAndListen({
        connectionString,
        reconnectDelayMs,
      });
    } catch (err) {
      console.error("[pipelineListener] reconnecting after error", err);
      await sleep(reconnectDelayMs);
    }
  }
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

// If executed directly via tsx/node.
if (isMainModule()) {
  runPipelineListener().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
