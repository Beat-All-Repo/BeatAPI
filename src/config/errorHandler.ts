import { HiAnimeError } from "../vendor/aniwatch/errors/HiAnimeError.js";
import type { ErrorHandler, NotFoundHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { log } from "./logger.js";

const errResp: { status: ContentfulStatusCode; message: string } = {
    status: 500,
    message: "Internal Server Error",
};

export const errorHandler: ErrorHandler = (err, c) => {
    log.error(err);

    if (err instanceof HiAnimeError) {
        errResp.status = err.status as ContentfulStatusCode;
        errResp.message = err.message;
    }

    return c.json(errResp, errResp.status);
};

export const notFoundHandler: NotFoundHandler = (c) => {
    errResp.status = 404;
    errResp.message = "Not Found";

    log.error(JSON.stringify(errResp));
    return c.json(errResp, errResp.status);
};
