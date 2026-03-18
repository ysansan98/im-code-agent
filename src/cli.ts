#!/usr/bin/env node

import { startBridge } from "./index.ts";

void startBridge().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
