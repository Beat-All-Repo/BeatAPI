import { HiAnimeError } from "../vendor/aniwatch/errors/HiAnimeError.js";
import type { ErrorHandler, NotFoundHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { env } from "./env.js";
import { log } from "./logger.js";

export const errorHandler: ErrorHandler = (err, c) => {
    log.error({ err, path: c.req.path, method: c.req.method }, "request error");

    let status: ContentfulStatusCode = 500;
    let message = "Internal Server Error";

    if (err instanceof HiAnimeError) {
        status = err.status as ContentfulStatusCode;
        message = err.message;
    }

    return c.json(
        {
            status,
            message,
            ...(env.isProduction
                ? {}
                : { details: err.message, stack: err.stack }),
        },
        status
    );
};

export const notFoundHandler: NotFoundHandler = (c) => {
    const status: ContentfulStatusCode = 404;
    const message = "Not Found";

    log.warn({ path: c.req.path, method: c.req.method }, "route not found");
    return c.json({ status, message }, status);
};
