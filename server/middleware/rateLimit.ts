import type { NextFunction, Request, Response } from "express";

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

/**
 * Creates a sliding-window rate limiter keyed by IP address.
 *
 * @param maxRequests  Maximum allowed requests within the window.
 * @param windowMs     Window duration in milliseconds.
 * @param message      Error message returned when the limit is exceeded.
 */
export function createRateLimiter(maxRequests: number, windowMs: number, message: string) {
  const store = new Map<string, RateLimitEntry>();

  // Purge stale entries periodically to prevent unbounded memory growth.
  const purgeInterval = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, entry] of store.entries()) {
      if (entry.windowStart < cutoff) {
        store.delete(key);
      }
    }
  }, windowMs);

  // Allow the process to exit without waiting for this interval.
  purgeInterval.unref();

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    const ip =
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
      req.socket.remoteAddress ??
      "unknown";

    const now = Date.now();
    const existing = store.get(ip);

    if (!existing || now - existing.windowStart >= windowMs) {
      store.set(ip, { count: 1, windowStart: now });
      return next();
    }

    existing.count += 1;

    if (existing.count > maxRequests) {
      res.setHeader("Retry-After", Math.ceil(windowMs / 1000).toString());
      return res.status(429).json({ error: message });
    }

    return next();
  };
}
