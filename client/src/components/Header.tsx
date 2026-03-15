import { useEffect, useState } from "react";
import { ArrowLeftRight, Menu, Moon, Sun } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/context/AuthContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useTheme } from "./ThemeProvider";

export default function Header() {
  const { theme, toggleTheme } = useTheme();
  const { isAuthenticated, logout, user } = useAuth();
  const [location] = useLocation();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const isConvertRoute = location === "/" || location.startsWith("/convert/");

  const primaryLinks = [
    {
      href: "/",
      isActive: isConvertRoute,
      label: "Convert",
      menuTestId: "menu-convert",
      navTestId: "nav-home",
    },
    {
      href: "/formats",
      isActive: location === "/formats",
      label: "Formats",
      menuTestId: "menu-formats",
      navTestId: "nav-formats",
    },
    {
      href: "/pricing",
      isActive: location === "/pricing",
      label: "Pricing",
      menuTestId: "menu-pricing",
      navTestId: "nav-pricing",
    },
  ] as const;

  useEffect(() => {
    setIsMenuOpen(false);
  }, [location]);

  const handleLogout = () => {
    setIsMenuOpen(false);
    void logout();
  };

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
          {primaryLinks.map((link) => (
            <Link key={link.href} href={link.href}>
              <Button
                variant={link.isActive ? "secondary" : "ghost"}
                size="sm"
                className="text-sm"
                data-testid={link.navTestId}
              >
                {link.label}
              </Button>
            </Link>
          ))}
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
          {isAuthenticated && (
            <div className="hidden items-center gap-2 md:flex">
              <span className="text-xs text-muted-foreground">{user?.email}</span>
              <Badge variant="secondary" className="capitalize">
                {user?.plan ?? "free"}
              </Badge>
            </div>
          )}

          <Sheet open={isMenuOpen} onOpenChange={setIsMenuOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Open menu"
                data-testid="button-menu"
                className="h-8 w-8 p-0"
              >
                <Menu className="h-4 w-4" />
              </Button>
            </SheetTrigger>

            <SheetContent
              side="right"
              className="w-full border-l border-border/60 bg-background/95 p-0 backdrop-blur-xl sm:max-w-sm"
              data-testid="menu-overlay"
            >
              <div className="flex h-full flex-col">
                <SheetHeader className="border-b border-border/60 px-6 py-6 text-left">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                      <ArrowLeftRight className="h-5 w-5" />
                    </div>
                    <div className="space-y-1">
                      <SheetTitle className="tracking-tight">Menu</SheetTitle>
                      <p className="text-sm text-muted-foreground">Navigation and account access.</p>
                    </div>
                  </div>
                </SheetHeader>

                {isAuthenticated && (
                  <div className="border-b border-border/60 px-6 py-4">
                    <div className="text-sm font-medium text-foreground">{user?.email ?? "Signed in"}</div>
                    <div className="mt-2">
                      <Badge variant="secondary" className="capitalize">
                        {user?.plan ?? "free"}
                      </Badge>
                    </div>
                  </div>
                )}

                <div className="flex flex-1 flex-col gap-2 px-4 py-4">
                  {!isAuthenticated && (
                    <>
                      <SheetClose asChild>
                        <Button asChild variant="ghost" className="h-12 justify-between rounded-xl px-4 text-base" data-testid="button-login">
                          <Link href="/login">Sign In</Link>
                        </Button>
                      </SheetClose>

                      <SheetClose asChild>
                        <Button asChild className="h-12 justify-between rounded-xl px-4 text-base" data-testid="button-register">
                          <Link href="/register">Create Account</Link>
                        </Button>
                      </SheetClose>
                    </>
                  )}

                  {primaryLinks.map((link) => (
                    <SheetClose asChild key={link.href}>
                      <Button
                        asChild
                        variant={link.isActive ? "secondary" : "ghost"}
                        className={cn(
                          "h-12 justify-between rounded-xl px-4 text-base",
                          link.isActive && "border-secondary-border",
                        )}
                        data-testid={link.menuTestId}
                      >
                        <Link href={link.href}>{link.label}</Link>
                      </Button>
                    </SheetClose>
                  ))}

                  {isAuthenticated && (
                    <>
                      <SheetClose asChild>
                        <Button
                          asChild
                          variant={location === "/history" ? "secondary" : "ghost"}
                          className={cn(
                            "h-12 justify-between rounded-xl px-4 text-base",
                            location === "/history" && "border-secondary-border",
                          )}
                          data-testid="menu-history"
                        >
                          <Link href="/history">History</Link>
                        </Button>
                      </SheetClose>

                      <div className="mt-auto border-t border-border/60 pt-4">
                        <Button
                          variant="outline"
                          className="h-12 w-full justify-between rounded-xl px-4 text-base"
                          onClick={handleLogout}
                          data-testid="button-logout"
                        >
                          Log out
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </SheetContent>
          </Sheet>

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
