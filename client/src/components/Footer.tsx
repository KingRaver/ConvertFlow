import { Link } from "wouter";
import { ArrowLeftRight } from "lucide-react";
import { POPULAR_CONVERSIONS } from "@shared/schema";

export default function Footer() {
  return (
    <footer className="border-t border-border/60 bg-card/50 mt-auto" data-testid="footer">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-12">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-8">
          <div className="col-span-2 sm:col-span-1">
            <div className="flex items-center gap-2 mb-3">
              <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-primary text-primary-foreground">
                <ArrowLeftRight className="w-3.5 h-3.5" />
              </div>
              <span className="text-sm font-semibold">ConvertFlow</span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed max-w-[200px]">
              Guest or account-backed file conversions with temporary output retention.
            </p>
          </div>

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
              <li><Link href="/pricing" className="text-xs text-muted-foreground hover:text-foreground transition-colors">Current Access</Link></li>
              <li><Link href="/convert/pdf-to-word" className="text-xs text-muted-foreground hover:text-foreground transition-colors">Preset Example</Link></li>
            </ul>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-border/60 flex justify-center">
          <p className="text-xs text-muted-foreground text-center">
            &copy; {new Date().getFullYear()} ConvertFlow. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
