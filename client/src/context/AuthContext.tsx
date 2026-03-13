import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  type AuthUser,
  getCurrentUser,
  loginUser,
  logoutUser,
  registerUser,
} from "@/lib/api";
import {
  clearStoredAuthToken,
  getStoredAuthToken,
  setStoredAuthToken,
} from "@/lib/auth";

interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  user: AuthUser | null;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => getStoredAuthToken());
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(token));

  useEffect(() => {
    let isActive = true;

    if (!token) {
      setUser(null);
      setIsLoading(false);
      return () => {
        isActive = false;
      };
    }

    setIsLoading(true);
    void getCurrentUser()
      .then((currentUser) => {
        if (!isActive) {
          return;
        }

        setUser(currentUser);
      })
      .catch(() => {
        clearStoredAuthToken();
        if (!isActive) {
          return;
        }

        setToken(null);
        setUser(null);
      })
      .finally(() => {
        if (!isActive) {
          return;
        }

        setIsLoading(false);
      });

    return () => {
      isActive = false;
    };
  }, [token]);

  const value: AuthContextValue = {
    isAuthenticated: user !== null,
    isLoading,
    login: async (email: string, password: string) => {
      const response = await loginUser(email, password);
      setStoredAuthToken(response.token);
      setToken(response.token);
      setUser(response.user);
      setIsLoading(false);
    },
    logout: async () => {
      try {
        await logoutUser();
      } finally {
        clearStoredAuthToken();
        setToken(null);
        setUser(null);
        setIsLoading(false);
      }
    },
    register: async (email: string, password: string) => {
      const response = await registerUser(email, password);
      setStoredAuthToken(response.token);
      setToken(response.token);
      setUser(response.user);
      setIsLoading(false);
    },
    user,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used within an AuthProvider.");
  }

  return value;
}
