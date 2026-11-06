import type { ErrorRequestHandler } from "express";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) { next(error); return; }
  res.set("Cache-Control", "no-store");
  if (error instanceof ApiError) {
    res.status(error.status).json({ success: false, error: { code: error.code, message: error.message } });
    return;
  }
  // A malformed percent-encoding in the path (for example /documents/%E0%A4%A) is a client error, not a server fault.
  if (error instanceof URIError) {
    res.status(400).json({ success: false, error: { code: "INVALID_REQUEST", message: "The request path is not valid." } });
    return;
  }
  const type = error && typeof error === "object" && "type" in error ? error.type : undefined;
  if (type === "entity.too.large") {
    res.status(413).json({ success: false, error: { code: "BODY_TOO_LARGE", message: "Request body is too large." } });
  } else if (type === "entity.parse.failed" || type === "encoding.unsupported" || type === "charset.unsupported") {
    res.status(type === "entity.parse.failed" ? 400 : 415).json({ success: false, error: { code: "INVALID_BODY", message: "A valid UTF-8 JSON body is required." } });
  } else {
    // Never serialize/log raw driver errors, input, passwords or tokens.
    res.status(500).json({ success: false, error: { code: "INTERNAL_ERROR", message: "Request could not be completed." } });
  }
};
