#!/usr/bin/env node

import { applyCliArgs } from "./config/cli-args.ts";
import { startBridge } from "./index.ts";

applyCliArgs(process.argv.slice(2));

void startBridge().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
