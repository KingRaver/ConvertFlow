import { QueryClientProvider } from "@tanstack/react-query";
import { Route, Router, Switch } from "wouter";
import Footer from "@/components/Footer";
import Header from "@/components/Header";
import { ThemeProvider } from "@/components/ThemeProvider";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/context/AuthContext";
import ConvertPage from "@/pages/ConvertPage";
import Formats from "@/pages/Formats";
import History from "@/pages/History";
import Home from "@/pages/Home";
import Login from "@/pages/Login";
import NotFound from "@/pages/not-found";
import Pricing from "@/pages/Pricing";
import Register from "@/pages/Register";
import { queryClient } from "./lib/queryClient";

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/formats" component={Formats} />
      <Route path="/convert/:slug" component={ConvertPage} />
      <Route path="/pricing" component={Pricing} />
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      <Route path="/history" component={History} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <TooltipProvider>
            <Toaster />
            <Router>
              <div className="flex min-h-screen flex-col">
                <Header />
                <main className="flex-1">
                  <AppRouter />
                </main>
                <Footer />
              </div>
            </Router>
          </TooltipProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
