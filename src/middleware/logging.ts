import type { MiddlewareHandler } from "hono";
import { env } from "../config/env.js";
import { log } from "../config/logger.js";

const HEALTH_PATHS = new Set(["/health", "/v"]);
const SLOW_REQUEST_MS = 1500;

export const logging: MiddlewareHandler = async (c, next) => {
    const startedAt = Date.now();
    const { pathname } = new URL(c.req.url);

    await next();

    if (HEALTH_PATHS.has(pathname)) return;

    const durationMs = Date.now() - startedAt;
    const status = c.res.status;
    const method = c.req.method;

    const payload = {
        method,
        path: pathname,
        status,
        durationMs,
    };

    if (status >= 500) {
        log.error(payload, "request failed");
        return;
    }

    if (status >= 400 || durationMs >= SLOW_REQUEST_MS) {
        log.warn(payload, status >= 400 ? "request warning" : "slow request");
        return;
    }

    if (!env.isProduction) {
        log.info(payload, "request complete");
    }
};
