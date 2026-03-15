import { Link } from "wouter";
import { ArrowLeftRight } from "lucide-react";
import { POPULAR_CONVERSIONS } from "@shared/schema";

export default function Footer() {
  return (
    <footer className="border-t border-border/60 bg-card/50 mt-auto" data-testid="footer">
      <div className="w-full px-3 py-12 sm:px-4">
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Popular</h4>
            <ul className="space-y-1.5">
              {POPULAR_CONVERSIONS.slice(0, 5).map((c) => (
                <li key={c.slug}>
                  <Link href={`/convert/${c.slug}`} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                    {c.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">More</h4>
            <ul className="space-y-1.5">
              {POPULAR_CONVERSIONS.slice(5, 10).map((c) => (
                <li key={c.slug}>
                  <Link href={`/convert/${c.slug}`} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                    {c.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Product</h4>
            <ul className="space-y-1.5">
              <li><Link href="/formats" className="text-xs text-muted-foreground hover:text-foreground transition-colors">All Formats</Link></li>
              <li><Link href="/pricing" className="text-xs text-muted-foreground hover:text-foreground transition-colors">Pricing &amp; Billing</Link></li>
              <li><Link href="/convert/pdf-to-word" className="text-xs text-muted-foreground hover:text-foreground transition-colors">Preset Example</Link></li>
            </ul>
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-3 border-t border-border/60 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ArrowLeftRight className="w-3.5 h-3.5" />
            </div>
            <span className="text-sm font-semibold">ConvertFlow</span>
          </div>
          <p className="text-xs text-muted-foreground sm:text-right">
            &copy; {new Date().getFullYear()} ConvertFlow. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
