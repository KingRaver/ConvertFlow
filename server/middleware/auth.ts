import type { NextFunction, Request, Response } from "express";
import { API_KEY_PREFIX, hashSecret } from "../auth";
import { USER_PLANS, USER_ROLES, type UserPlan, type UserRole } from "@shared/schema";
import { getStorage } from "../storage";

export interface RequestUser {
  createdAt: Date | null;
  email: string;
  id: number;
  plan: UserPlan;
  role: UserRole;
}

declare global {
  namespace Express {
    interface Request {
      apiKeyId?: number;
      authType?: "apiKey" | "session";
      authToken?: string;
      user?: RequestUser;
    }
  }
}

function parseBearerToken(req: Request) {
  const authorization = req.header("authorization");
  if (!authorization) {
    return null;
  }

  const [scheme, token] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token;
}

async function attachAuthenticatedUser(req: Request) {
  const result = await attachRequestUser(req, { allowApiKey: false });
  return result === "invalid" ? null : result;
}

export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await attachRequestUser(req, { allowApiKey: false });
    if (result === "invalid") {
      return res.status(401).json({ error: "Invalid authentication token." });
    }

    next();
  } catch (error) {
    next(error);
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await attachAuthenticatedUser(req);
    if (!user) {
      return res.status(401).json({ error: "Authentication required." });
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

async function attachSessionUser(req: Request, token: string) {
  const session = await getStorage().getSessionByToken(token);
  if (!session) {
    return null;
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    await getStorage().deleteSessionByToken(token);
    return null;
  }

  const user = await getStorage().getUserById(session.userId);
  if (!user) {
    await getStorage().deleteSessionByToken(token);
    return null;
  }

  if (!(USER_ROLES as readonly string[]).includes(user.role)) {
    await getStorage().deleteSessionByToken(token);
    return null;
  }

  if (!(USER_PLANS as readonly string[]).includes(user.plan)) {
    await getStorage().deleteSessionByToken(token);
    return null;
  }

  req.apiKeyId = undefined;
  req.authToken = token;
  req.authType = "session";
  req.user = {
    createdAt: user.createdAt ?? null,
    email: user.email,
    id: user.id,
    plan: user.plan as UserPlan,
    role: user.role as UserRole,
  };

  return req.user;
}

async function attachApiKeyUser(req: Request, token: string) {
  const apiKey = await getStorage().getActiveApiKeyByHash(hashSecret(token));
  if (!apiKey) {
    return null;
  }

  const user = await getStorage().getUserById(apiKey.userId);
  if (!user) {
    return null;
  }

  if (!(USER_ROLES as readonly string[]).includes(user.role)) {
    return null;
  }

  if (!(USER_PLANS as readonly string[]).includes(user.plan)) {
    return null;
  }

  await getStorage().touchApiKeyLastUsed(apiKey.id, new Date());

  req.apiKeyId = apiKey.id;
  req.authToken = undefined;
  req.authType = "apiKey";
  req.user = {
    createdAt: user.createdAt ?? null,
    email: user.email,
    id: user.id,
    plan: user.plan as UserPlan,
    role: user.role as UserRole,
  };

  return req.user;
}

async function attachRequestUser(
  req: Request,
  { allowApiKey }: { allowApiKey: boolean },
): Promise<RequestUser | "invalid" | null> {
  const token = parseBearerToken(req);
  req.apiKeyId = undefined;
  req.authToken = undefined;
  req.authType = undefined;
  req.user = undefined;

  if (!token) {
    return null;
  }

  if (allowApiKey && token.startsWith(API_KEY_PREFIX)) {
    const apiUser = await attachApiKeyUser(req, token);
    if (apiUser) {
      return apiUser;
    }

    // A cf_-prefixed token that fails API key lookup is definitively invalid.
    // Never fall through to session auth for API key-shaped tokens.
    return "invalid";
  }

  const sessionUser = await attachSessionUser(req, token);
  if (sessionUser) {
    return sessionUser;
  }

  if (!allowApiKey) {
    return "invalid";
  }

  const apiUser = await attachApiKeyUser(req, token);
  if (apiUser) {
    return apiUser;
  }

  return "invalid";
}

export async function optionalApiAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await attachRequestUser(req, { allowApiKey: true });
    if (result === "invalid") {
      return res.status(401).json({ error: "Invalid authentication token." });
    }

    next();
  } catch (error) {
    next(error);
  }
}
