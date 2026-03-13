import { Link, useLocation } from "wouter";
import { useTheme } from "./ThemeProvider";
import { Sun, Moon, ArrowLeftRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Header() {
  const { theme, toggleTheme } = useTheme();
  const [location] = useLocation();

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/60 bg-background/80 backdrop-blur-xl" data-testid="header">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 group" data-testid="link-home">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary text-primary-foreground">
            <ArrowLeftRight className="w-4 h-4" />
          </div>
          <span className="text-base font-semibold tracking-tight">ConvertFlow</span>
        </Link>

        <nav className="hidden sm:flex items-center gap-1" data-testid="nav-main">
          <Link href="/">
            <Button
              variant={location === "/" ? "secondary" : "ghost"}
              size="sm"
              className="text-sm"
              data-testid="nav-home"
            >
              Convert
            </Button>
          </Link>
          <Link href="/formats">
            <Button
              variant={location === "/formats" ? "secondary" : "ghost"}
              size="sm"
              className="text-sm"
              data-testid="nav-formats"
            >
              Formats
            </Button>
          </Link>
          <Link href="/pricing">
            <Button
              variant={location === "/pricing" ? "secondary" : "ghost"}
              size="sm"
              className="text-sm"
              data-testid="nav-pricing"
            >
              Access
            </Button>
          </Link>
        </nav>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            data-testid="button-theme-toggle"
            className="w-8 h-8 p-0"
          >
            {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </Button>
        </div>
      </div>
    </header>
  );
}
