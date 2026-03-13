import { Link } from "wouter";
import { Check, FolderTree, Route, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const CARDS = [
  {
    name: "Current Build",
    description: "What is live in this repository today",
    icon: Zap,
    badge: "Available now",
    features: [
      "Real converted downloads",
      "Route-aware upload validation",
      "Visitor-scoped job tracking",
      "50MB upload cap",
      "Automatic cleanup and expiry",
      "Guest uploads or account history",
    ],
    cta: "Open Converter",
    href: "/",
    variant: "default" as const,
    highlighted: true,
  },
  {
    name: "Route Catalog",
    description: "Review active format pairs and jump straight into a preset conversion page",
    icon: FolderTree,
    features: [
      "Browse document, image, audio, video, and data routes",
      "Inspect active source-to-target pairs",
      "Share direct links without hash fragments",
      "Validate preset page behavior",
    ],
    cta: "Browse Routes",
    href: "/formats",
    variant: "outline" as const,
    highlighted: false,
  },
  {
    name: "Preset Example",
    description: "See a locked route page with source-format enforcement",
    icon: Route,
    features: [
      "Deep-linkable preset page",
      "Source extension locked to the route",
      "Target format fixed by the slug",
      "Job completion state with downloadable output",
    ],
    cta: "View Example",
    href: "/convert/pdf-to-word",
    variant: "outline" as const,
    highlighted: false,
  },
];

export default function Pricing() {
  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-12 sm:py-16" data-testid="page-pricing">
      <div className="text-center mb-12">
        <h1 className="text-xl font-bold tracking-tight mb-2">Current Access</h1>
        <p className="text-sm text-muted-foreground max-w-2xl mx-auto">
          This page now reflects the current build truthfully. Paid tiers, API access, and production
          conversion promises stay hidden until the implementation actually exists.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-5xl mx-auto">
        {CARDS.map((card) => (
          <div
            key={card.name}
            className={`relative p-6 rounded-xl border flex flex-col ${
              card.highlighted
                ? "border-primary bg-primary/[0.02] shadow-md"
                : "border-border/60 bg-card"
            }`}
            data-testid={`pricing-${card.name.toLowerCase().replace(/\s/g, "-")}`}
          >
            {card.badge && (
              <Badge className="absolute -top-2.5 left-1/2 -translate-x-1/2 text-[10px]">
                {card.badge}
              </Badge>
            )}

            <div className="mb-4">
              <div className="flex items-center gap-2 mb-2">
                <card.icon className={`w-4 h-4 ${card.highlighted ? "text-primary" : "text-muted-foreground"}`} />
                <span className="text-sm font-semibold">{card.name}</span>
              </div>
              <p className="text-xs text-muted-foreground">{card.description}</p>
            </div>

            <ul className="space-y-2 mb-6 flex-1">
              {card.features.map((feature) => (
                <li key={feature} className="flex items-start gap-2 text-xs">
                  <Check className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${card.highlighted ? "text-primary" : "text-muted-foreground"}`} />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>

            <Link href={card.href}>
              <Button
                variant={card.variant}
                className="w-full text-sm"
                data-testid={`button-plan-${card.name.toLowerCase().replace(/\s/g, "-")}`}
              >
                {card.cta}
              </Button>
            </Link>
          </div>
        ))}
      </div>

      <div className="mt-12 text-center">
        <p className="text-xs text-muted-foreground max-w-2xl mx-auto">
          When real conversion engines, billing, quotas, or an external API ship, this page should evolve
          again. Until then, it is intentionally an access and rollout summary rather than a sales page.
        </p>
      </div>
    </div>
  );
}
