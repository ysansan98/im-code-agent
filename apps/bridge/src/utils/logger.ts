type LogLevel = "info" | "warn" | "error";

export type Logger = {
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
};

function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  const entry = {
    level,
    message,
    ...(context ? { context } : {}),
    timestamp: new Date().toISOString(),
  };

  console[level](JSON.stringify(entry));
}

export function createLogger(): Logger {
  return {
    info: (message, context) => log("info", message, context),
    warn: (message, context) => log("warn", message, context),
    error: (message, context) => log("error", message, context),
  };
}
