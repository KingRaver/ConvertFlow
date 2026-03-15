import { ArrowLeftRight, Moon, Sun } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/context/AuthContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTheme } from "./ThemeProvider";

export default function Header() {
  const { theme, toggleTheme } = useTheme();
  const { isAuthenticated, logout, user } = useAuth();
  const [location] = useLocation();

  return (
    <header
      className="sticky top-0 z-50 w-full border-b border-border/60 bg-background/80 backdrop-blur-xl"
      data-testid="header"
    >
      <div className="relative flex h-14 w-full items-center px-3 sm:px-4">
        <Link href="/" className="group flex items-center gap-2" data-testid="link-home">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ArrowLeftRight className="h-4 w-4" />
          </div>
          <span className="text-base font-semibold tracking-tight">ConvertFlow</span>
        </Link>

        <nav className="absolute left-1/2 -translate-x-1/2 hidden items-center gap-1 sm:flex" data-testid="nav-main">
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
              Pricing
            </Button>
          </Link>
          {isAuthenticated && (
            <Link href="/history">
              <Button
                variant={location === "/history" ? "secondary" : "ghost"}
                size="sm"
                className="text-sm"
                data-testid="nav-history"
              >
                History
              </Button>
            </Link>
          )}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {isAuthenticated ? (
            <>
              <div className="hidden items-center gap-2 md:flex">
                <span className="text-xs text-muted-foreground">{user?.email}</span>
                <Badge variant="secondary" className="capitalize">
                  {user?.plan ?? "free"}
                </Badge>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void logout()}
                data-testid="button-logout"
              >
                Log out
              </Button>
            </>
          ) : (
            <>
              <Link href="/login">
                <Button variant="ghost" size="sm" data-testid="button-login">
                  Sign in
                </Button>
              </Link>
              <Link href="/register">
                <Button size="sm" data-testid="button-register">
                  Create account
                </Button>
              </Link>
            </>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            data-testid="button-theme-toggle"
            className="h-8 w-8 p-0"
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </header>
  );
}
