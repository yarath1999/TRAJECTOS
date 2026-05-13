import { runAllocationEngine } from "../services/allocationEngine";

async function main() {
  try {
    await runAllocationEngine();
    console.log('SMOKE_DONE');
  } catch (err) {
    console.error('SMOKE_ERROR', err);
    process.exit(1);
  }
}

void main();
