import type { NextFunction, Request, Response } from "express";
import { USER_ROLES, type UserRole } from "@shared/schema";
import { storage } from "../storage";

export interface RequestUser {
  createdAt: Date | null;
  email: string;
  id: number;
  role: UserRole;
}

declare global {
  namespace Express {
    interface Request {
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
  const token = parseBearerToken(req);
  if (!token) {
    return null;
  }

  const session = await storage.getSessionByToken(token);
  if (!session) {
    return null;
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    await storage.deleteSessionByToken(token);
    return null;
  }

  const user = await storage.getUserById(session.userId);
  if (!user) {
    await storage.deleteSessionByToken(token);
    return null;
  }

  if (!(USER_ROLES as readonly string[]).includes(user.role)) {
    await storage.deleteSessionByToken(token);
    return null;
  }

  req.authToken = token;
  req.user = {
    createdAt: user.createdAt ?? null,
    email: user.email,
    id: user.id,
    role: user.role as UserRole,
  };

  return req.user;
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    await attachAuthenticatedUser(req);
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
