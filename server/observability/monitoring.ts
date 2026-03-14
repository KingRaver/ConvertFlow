import type { NextFunction, Request, Response } from "express";

function getForwardedIp(req: Request) {
  const forwarded = req.header("x-forwarded-for");
  if (!forwarded) {
    return null;
  }

  return forwarded
    .split(",")
    .map((value) => value.trim())
    .find(Boolean) ?? null;
}

function normalizeIp(ip: string | null | undefined) {
  if (!ip) {
    return "";
  }

  if (ip.startsWith("::ffff:")) {
    return ip.slice("::ffff:".length);
  }

  return ip;
}

function isPrivateIpv4(ip: string) {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts as [number, number, number, number];
  return (
    a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
  );
}

function isPrivateIp(ip: string) {
  const normalized = normalizeIp(ip);

  if (!normalized) {
    return false;
  }

  if (
    normalized === "::1"
    || normalized.startsWith("fd")
    || normalized.startsWith("fc")
    || normalized.startsWith("fe80:")
  ) {
    return true;
  }

  return isPrivateIpv4(normalized);
}

function hasValidMonitoringToken(req: Request) {
  const configuredToken = process.env.MONITORING_TOKEN?.trim();
  if (!configuredToken) {
    return false;
  }

  const authorization = req.header("authorization");
  if (authorization === `Bearer ${configuredToken}`) {
    return true;
  }

  return req.header("x-monitoring-token")?.trim() === configuredToken;
}

export function canAccessMonitoring(req: Request) {
  if (hasValidMonitoringToken(req)) {
    return true;
  }

  if (process.env.MONITORING_TOKEN?.trim()) {
    return false;
  }

  if (process.env.NODE_ENV !== "production") {
    return true;
  }

  return isPrivateIp(getForwardedIp(req) ?? req.ip ?? "");
}

export function requireMonitoringAccess(req: Request, res: Response, next: NextFunction) {
  if (canAccessMonitoring(req)) {
    return next();
  }

  return res.status(401).json({ error: "Monitoring access required." });
}
