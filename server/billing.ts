import process from "node:process";
import Stripe from "stripe";
import type { User, UserPlan } from "@shared/schema";
import { storage, type IStorage } from "./storage";

export type PaidUserPlan = Exclude<UserPlan, "free">;

interface PlanPrice {
  description: string;
  monthlyPriceUsd: number;
}

export interface BillingCheckoutSession {
  customerId: string;
  url: string;
}

export interface BillingPortalSession {
  url: string;
}

export interface BillingProvider {
  createCheckoutSession(input: {
    baseUrl: string;
    plan: PaidUserPlan;
    user: Pick<User, "email" | "id" | "stripeCustomerId">;
  }): Promise<BillingCheckoutSession>;
  createPortalSession(input: {
    baseUrl: string;
    user: Pick<User, "stripeCustomerId">;
  }): Promise<BillingPortalSession>;
  isConfigured(): boolean;
  constructWebhookEvent(payload: Buffer, signature: string): Stripe.Event;
}

const PLAN_PRICING: Record<PaidUserPlan, PlanPrice> = {
  pro: {
    description: "500 conversions per day, 100MB uploads, 7-day retention",
    monthlyPriceUsd: 19,
  },
  business: {
    description: "Unlimited conversions, 500MB uploads, 30-day retention",
    monthlyPriceUsd: 99,
  },
};

const PAID_USER_PLANS = Object.keys(PLAN_PRICING) as PaidUserPlan[];

let billingProviderOverride: BillingProvider | null = null;
let stripeClient: Stripe | null | undefined;

function getStripeSecretKey() {
  return process.env.STRIPE_SECRET_KEY?.trim() || "";
}

function getStripeWebhookSecret() {
  return process.env.STRIPE_WEBHOOK_SECRET?.trim() || "";
}

function getStripeClient() {
  if (stripeClient !== undefined) {
    return stripeClient;
  }

  const secretKey = getStripeSecretKey();
  stripeClient = secretKey
    ? new Stripe(secretKey)
    : null;

  return stripeClient;
}

function getStripeBillingProvider(): BillingProvider {
  return {
    async createCheckoutSession({ baseUrl, plan, user }) {
      const stripe = getStripeClient();
      if (!stripe) {
        throw new Error("Stripe billing is not configured.");
      }

      const customerId = user.stripeCustomerId ?? (
        await stripe.customers.create({
          email: user.email,
          metadata: {
            userId: String(user.id),
          },
        })
      ).id;

      const session = await stripe.checkout.sessions.create({
        allow_promotion_codes: true,
        cancel_url: `${baseUrl}/pricing?billing=canceled`,
        client_reference_id: String(user.id),
        customer: customerId,
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                description: PLAN_PRICING[plan].description,
                name: `ConvertFlow ${plan[0].toUpperCase()}${plan.slice(1)}`,
              },
              recurring: {
                interval: "month",
              },
              unit_amount: PLAN_PRICING[plan].monthlyPriceUsd * 100,
            },
            quantity: 1,
          },
        ],
        metadata: {
          plan,
          userId: String(user.id),
        },
        mode: "subscription",
        subscription_data: {
          metadata: {
            plan,
            userId: String(user.id),
          },
        },
        success_url: `${baseUrl}/pricing?billing=success&plan=${plan}`,
      });

      if (!session.url) {
        throw new Error("Stripe checkout session did not return a redirect URL.");
      }

      return {
        customerId,
        url: session.url,
      };
    },

    async createPortalSession({ baseUrl, user }) {
      const stripe = getStripeClient();
      if (!stripe) {
        throw new Error("Stripe billing is not configured.");
      }

      if (!user.stripeCustomerId) {
        throw new Error("No Stripe customer is attached to this account.");
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: `${baseUrl}/pricing`,
      });

      return {
        url: session.url,
      };
    },

    isConfigured() {
      return Boolean(getStripeClient());
    },

    constructWebhookEvent(payload, signature) {
      const stripe = getStripeClient();
      const webhookSecret = getStripeWebhookSecret();
      if (!stripe || !webhookSecret) {
        throw new Error("Stripe webhooks are not configured.");
      }

      return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    },
  };
}

function getBillingProvider() {
  return billingProviderOverride ?? getStripeBillingProvider();
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "");
}

export function setBillingProviderForTests(provider: BillingProvider | null) {
  billingProviderOverride = provider;
}

export function isPaidUserPlan(plan: string): plan is PaidUserPlan {
  return (PAID_USER_PLANS as readonly string[]).includes(plan);
}

export function isBillingConfigured() {
  return getBillingProvider().isConfigured();
}

export async function createBillingCheckoutSession(
  input: {
    baseUrl: string;
    plan: PaidUserPlan;
    user: Pick<User, "email" | "id" | "stripeCustomerId">;
  },
) {
  return getBillingProvider().createCheckoutSession({
    ...input,
    baseUrl: normalizeBaseUrl(input.baseUrl),
  });
}

export async function createBillingPortalSession(
  input: {
    baseUrl: string;
    user: Pick<User, "stripeCustomerId">;
  },
) {
  return getBillingProvider().createPortalSession({
    ...input,
    baseUrl: normalizeBaseUrl(input.baseUrl),
  });
}

export function constructStripeWebhookEvent(payload: Buffer, signature: string) {
  return getBillingProvider().constructWebhookEvent(payload, signature);
}

function getUserIdFromSubscription(subscription: Stripe.Subscription) {
  const userId = Number.parseInt(subscription.metadata.userId ?? "", 10);
  if (Number.isNaN(userId)) {
    return null;
  }

  return userId;
}

async function syncActiveSubscription(
  subscription: Stripe.Subscription,
  activeStorage: IStorage,
) {
  const userId = getUserIdFromSubscription(subscription);
  if (!userId) {
    return false;
  }

  const rawPlan = subscription.metadata.plan ?? "";
  if (!isPaidUserPlan(rawPlan)) {
    console.error(
      `Stripe webhook: subscription ${subscription.id} has unrecognized plan metadata "${rawPlan}" — skipping sync to avoid incorrect plan change`,
    );
    return false;
  }

  const user = await activeStorage.getUserById(userId);
  if (!user) {
    return false;
  }

  await activeStorage.updateUser(user.id, {
    plan: rawPlan,
    stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
    stripeSubscriptionId: subscription.id,
  });

  return true;
}

async function syncCanceledSubscription(
  subscription: Stripe.Subscription,
  activeStorage: IStorage,
) {
  const userId = getUserIdFromSubscription(subscription);
  if (!userId) {
    return false;
  }

  const user = await activeStorage.getUserById(userId);
  if (!user) {
    return false;
  }

  await activeStorage.updateUser(user.id, {
    plan: "free",
    stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
    stripeSubscriptionId: null,
  });

  return true;
}

export async function syncStripeBillingEvent(
  event: Stripe.Event,
  activeStorage: IStorage = storage,
) {
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
      return syncActiveSubscription(event.data.object as Stripe.Subscription, activeStorage);
    case "customer.subscription.deleted":
      return syncCanceledSubscription(event.data.object as Stripe.Subscription, activeStorage);
    default:
      return false;
  }
}
