import type { UserPlan } from "@shared/schema";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MB = 1024 * 1024;

export interface PlanLimits {
  conversionsPerDay: number | null;
  maxFileSizeBytes: number;
  retentionMs: number;
}

export const PLAN_LIMITS: Record<UserPlan, PlanLimits> = {
  free: {
    conversionsPerDay: 10,
    maxFileSizeBytes: 10 * MB,
    retentionMs: HOUR_MS,
  },
  pro: {
    conversionsPerDay: 500,
    maxFileSizeBytes: 100 * MB,
    retentionMs: 7 * DAY_MS,
  },
  business: {
    conversionsPerDay: null,
    maxFileSizeBytes: 500 * MB,
    retentionMs: 30 * DAY_MS,
  },
};

const PLAN_ORDER: UserPlan[] = ["free", "pro", "business"];

export function getEffectivePlan(plan: UserPlan | null | undefined): UserPlan {
  return plan ?? "free";
}

export function getPlanDisplayName(plan: UserPlan | null | undefined) {
  const effectivePlan = getEffectivePlan(plan);
  return effectivePlan[0].toUpperCase() + effectivePlan.slice(1);
}

export function getPlanLimits(plan: UserPlan | null | undefined): PlanLimits {
  return PLAN_LIMITS[getEffectivePlan(plan)];
}

export function getPlanRank(plan: UserPlan | null | undefined) {
  return PLAN_ORDER.indexOf(getEffectivePlan(plan));
}

export function getPlanRetentionDeadline(
  plan: UserPlan | null | undefined,
  now = new Date(),
) {
  return new Date(now.getTime() + getPlanLimits(plan).retentionMs);
}

export function getStartOfCurrentUtcDay(now = new Date()) {
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  ));
}

export function formatBytes(bytes: number) {
  if (bytes < MB) {
    return `${Math.round(bytes / 1024)}KB`;
  }

  return `${Math.round(bytes / MB)}MB`;
}

export function getDailyUsageExceededMessage(plan: UserPlan | null | undefined) {
  const effectivePlan = getEffectivePlan(plan);
  const limit = getPlanLimits(effectivePlan).conversionsPerDay;

  if (!limit) {
    return "This plan does not have a daily conversion cap.";
  }

  return `${getPlanDisplayName(effectivePlan)} plan limit reached: ${limit} conversions per UTC day.`;
}

export function getFileSizeExceededMessage(plan: UserPlan | null | undefined) {
  const effectivePlan = getEffectivePlan(plan);
  const { maxFileSizeBytes } = getPlanLimits(effectivePlan);

  return `${getPlanDisplayName(effectivePlan)} plan uploads are limited to ${formatBytes(maxFileSizeBytes)}.`;
}
