import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
console.log('ENV URL:', process.env.NEXT_PUBLIC_SUPABASE_URL);
import { runSystemHealthCheck } from "../health/systemHealth";

async function main(): Promise<void> {
  const report = await runSystemHealthCheck();

  if (report.ok) {
    console.log("SYSTEM_HEALTH_OK");
    return;
  }

  console.error("SYSTEM_HEALTH_FAIL");
  for (const check of report.checks) {
    if (!check.ok) {
      console.error(`${check.name}: ${check.details}`);
      if (check.meta) {
        console.error(`${check.name}.meta: ${JSON.stringify(check.meta)}`);
      }
    }
  }

  for (const diagnostic of report.diagnostics) {
    if (!report.checks.some((check) => !check.ok && `${check.name}: ${check.details}` === diagnostic)) {
      console.error(diagnostic);
    }
  }

  process.exitCode = 1;
}

void main().catch((err) => {
  console.error("SYSTEM_HEALTH_FAIL");
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});