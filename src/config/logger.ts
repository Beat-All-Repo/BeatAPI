import { env } from "./env.js";
import { pino, type LoggerOptions } from "pino";

const configuredLogLevel = String(process.env.LOG_LEVEL || "").trim().toLowerCase();
const defaultLogLevel = env.isProduction ? "warn" : env.isDev ? "debug" : "info";
const effectiveLogLevel = configuredLogLevel || defaultLogLevel;

const loggerOptions: LoggerOptions = {
    redact: env.isProduction ? ["hostname", "pid"] : [],
    level: effectiveLogLevel,
    base: env.isProduction ? { service: "tatakai-api" } : undefined,
    transport: env.isDev
        ? {
              target: "pino-pretty",
              options: {
                  colorize: true,
                  translateTime: "SYS:standard",
                  singleLine: true,
                  ignore: "pid,hostname",
              },
          }
        : undefined,
    serializers: {
        err(value) {
            if (!value) return value;
            const err = value as Error & { status?: number };
            return {
                name: err.name,
                message: err.message,
                status: err.status,
                stack: env.isProduction ? undefined : err.stack,
            };
        },
    },
    formatters: {
        level(label) {
            return {
                level: label.toUpperCase(),
            };
        },
    },
};

export const log = pino(loggerOptions);

const rateLimitState = new Map<string, number>();

export const logRateLimited = (
    key: string,
    fn: () => void,
    intervalMs = 30000
) => {
    const now = Date.now();
    const last = rateLimitState.get(key) || 0;
    if (now - last < intervalMs) return;
    rateLimitState.set(key, now);
    fn();
};

export const isVerboseLoggingEnabled = !env.isProduction;
