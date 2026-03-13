import { useState } from "react";
import { Check, CreditCard, Lock, Rocket, Shield } from "lucide-react";
import { Link } from "wouter";
import type { UserPlan } from "@shared/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/AuthContext";
import { createBillingCheckout, createBillingPortal } from "@/lib/api";

type PaidPlan = Exclude<UserPlan, "free">;

interface PricingCard {
  cta: string;
  description: string;
  icon: typeof Lock;
  limits: string[];
  plan: UserPlan;
  price: string;
}

const PLAN_ORDER: UserPlan[] = ["free", "pro", "business"];

const CARDS: PricingCard[] = [
  {
    cta: "Start Free",
    description: "Best for occasional conversions and evaluation.",
    icon: Lock,
    limits: [
      "10 completed conversions per UTC day",
      "10MB upload limit",
      "1-hour file retention",
      "Guest uploads or account history",
    ],
    plan: "free",
    price: "$0",
  },
  {
    cta: "Upgrade to Pro",
    description: "Built for regular individual use with room to scale.",
    icon: Rocket,
    limits: [
      "500 completed conversions per UTC day",
      "100MB upload limit",
      "7-day file retention",
      "Stripe-managed subscription",
    ],
    plan: "pro",
    price: "$19/mo",
  },
  {
    cta: "Upgrade to Business",
    description: "High-volume access with the largest upload ceiling.",
    icon: Shield,
    limits: [
      "Unlimited completed conversions",
      "500MB upload limit",
      "30-day file retention",
      "Priority billing management through Stripe",
    ],
    plan: "business",
    price: "$99/mo",
  },
];

function getPlanRank(plan: UserPlan) {
  return PLAN_ORDER.indexOf(plan);
}

export default function Pricing() {
  const { isAuthenticated, user } = useAuth();
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const billingState = typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search).get("billing");
  const currentPlan = user?.plan ?? "free";

  async function handleCheckout(plan: PaidPlan) {
    setError(null);
    setActiveAction(`checkout-${plan}`);

    try {
      const session = await createBillingCheckout(plan);
      window.location.assign(session.url);
    } catch (checkoutError) {
      setError(checkoutError instanceof Error ? checkoutError.message : "Failed to start checkout.");
      setActiveAction(null);
    }
  }

  async function handlePortal() {
    setError(null);
    setActiveAction("portal");

    try {
      const session = await createBillingPortal();
      window.location.assign(session.url);
    } catch (portalError) {
      setError(portalError instanceof Error ? portalError.message : "Failed to open billing portal.");
      setActiveAction(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16" data-testid="page-pricing">
      <div className="mx-auto mb-12 max-w-3xl text-center">
        <Badge variant="secondary" className="mb-4">
          Billing and limits live
        </Badge>
        <h1 className="mb-3 text-2xl font-bold tracking-tight sm:text-3xl">Plans and billing</h1>
        <p className="text-sm text-muted-foreground sm:text-base">
          ConvertFlow now enforces plan-specific quotas, file size limits, retention windows, and Stripe-backed upgrades.
        </p>
      </div>

      {billingState === "success" && (
        <div className="mx-auto mb-6 max-w-3xl rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm">
          Billing checkout completed. Your plan will update after Stripe sends the subscription webhook.
        </div>
      )}

      {billingState === "canceled" && (
        <div className="mx-auto mb-6 max-w-3xl rounded-lg border border-border/60 bg-card px-4 py-3 text-sm text-muted-foreground">
          Checkout was canceled before any subscription change was applied.
        </div>
      )}

      {error && (
        <div className="mx-auto mb-6 max-w-3xl rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {isAuthenticated && (
        <div className="mx-auto mb-8 flex max-w-3xl items-center justify-between rounded-xl border border-border/60 bg-card px-4 py-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
              Current plan
            </p>
            <p className="mt-1 text-lg font-semibold capitalize">{currentPlan}</p>
            <p className="text-sm text-muted-foreground">{user?.email}</p>
          </div>
          {currentPlan === "free" ? (
            <Badge>Free tier</Badge>
          ) : (
            <Button
              variant="outline"
              onClick={() => void handlePortal()}
              disabled={activeAction === "portal"}
              data-testid="button-billing-manage"
            >
              <CreditCard className="mr-2 h-4 w-4" />
              {activeAction === "portal" ? "Opening..." : "Manage billing"}
            </Button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {CARDS.map((card) => {
          const isCurrentPlan = currentPlan === card.plan;
          const isUpgrade = getPlanRank(card.plan) > getPlanRank(currentPlan);
          const upgradePlan = card.plan === "free" ? null : card.plan;
          const actionKey = card.plan === "free" ? "free" : `checkout-${card.plan}`;

          return (
            <section
              key={card.plan}
              className={`rounded-2xl border p-6 ${
                isCurrentPlan
                  ? "border-primary bg-primary/[0.03] shadow-sm"
                  : "border-border/60 bg-card"
              }`}
              data-testid={`pricing-${card.plan}`}
            >
              <div className="mb-6 flex items-start justify-between gap-4">
                <div>
                  <div className="mb-2 flex items-center gap-2">
                    <card.icon className={`h-4 w-4 ${isCurrentPlan ? "text-primary" : "text-muted-foreground"}`} />
                    <span className="text-sm font-semibold capitalize">{card.plan}</span>
                    {isCurrentPlan && <Badge>Current</Badge>}
                  </div>
                  <p className="text-2xl font-bold tracking-tight">{card.price}</p>
                  <p className="mt-2 text-sm text-muted-foreground">{card.description}</p>
                </div>
              </div>

              <ul className="mb-6 space-y-3">
                {card.limits.map((limit) => (
                  <li key={limit} className="flex items-start gap-2 text-sm">
                    <Check className={`mt-0.5 h-4 w-4 shrink-0 ${isCurrentPlan ? "text-primary" : "text-muted-foreground"}`} />
                    <span>{limit}</span>
                  </li>
                ))}
              </ul>

              {!isAuthenticated ? (
                <Link href={card.plan === "free" ? "/register" : "/login"}>
                  <Button
                    variant={card.plan === "free" ? "default" : "outline"}
                    className="w-full"
                    data-testid={`button-plan-${card.plan}`}
                  >
                    {card.plan === "free" ? "Create free account" : "Sign in to upgrade"}
                  </Button>
                </Link>
              ) : isCurrentPlan ? (
                <Button
                  variant={card.plan === "free" ? "secondary" : "outline"}
                  className="w-full"
                  disabled={card.plan === "free" || activeAction === "portal"}
                  onClick={card.plan === "free" ? undefined : () => void handlePortal()}
                  data-testid={`button-plan-${card.plan}`}
                >
                  {card.plan === "free"
                    ? "Current plan"
                    : activeAction === "portal"
                      ? "Opening..."
                      : "Manage billing"}
                </Button>
              ) : isUpgrade && upgradePlan ? (
                <Button
                  className="w-full"
                  disabled={activeAction === actionKey}
                  onClick={() => void handleCheckout(upgradePlan)}
                  data-testid={`button-plan-${card.plan}`}
                >
                  {activeAction === actionKey ? "Redirecting..." : card.cta}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={activeAction === "portal"}
                  onClick={() => void handlePortal()}
                  data-testid={`button-plan-${card.plan}`}
                >
                  {activeAction === "portal" ? "Opening..." : "Manage in portal"}
                </Button>
              )}
            </section>
          );
        })}
      </div>

      <div className="mx-auto mt-10 max-w-3xl rounded-xl border border-border/60 bg-card px-4 py-4 text-sm text-muted-foreground">
        Daily usage resets at 00:00 UTC. Successful account-owned conversions are metered for plan quotas, while guest uploads stay on the free tier.
      </div>
    </div>
  );
}
