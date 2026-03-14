import type { UserPlan } from "@shared/schema";
import { clearStoredAuthToken, getStoredAuthToken } from "./auth";
import { getVisitorHeaders } from "./visitor";

const API_BASE = "";

export interface AuthUser {
  createdAt: string | null;
  email: string;
  id: number;
  plan: UserPlan;
  role: "user" | "admin";
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

export interface ConversionResponse {
  convertedSize?: number | null;
  createdAt?: string | null;
  engineUsed?: string | null;
  expiresAt?: string | null;
  fileSize?: number;
  id: number;
  originalFormat?: string;
  originalName?: string;
  outputFilename: string | null;
  processingStartedAt?: string | null;
  resultMessage?: string | null;
  status: "pending" | "processing" | "completed" | "failed";
  targetFormat?: string;
}

export interface ConversionListResponse {
  items: ConversionResponse[];
  limit: number;
  page: number;
  total: number;
  totalPages: number;
}

export interface BillingRedirectResponse {
  url: string;
}

export interface ServiceHealthResponse {
  capabilities: {
    billingConfigured: boolean;
    legacyDocConverterAvailable: boolean;
  };
  db: "ok" | "error";
  queue: "ok" | "error";
  runtime: {
    filestore: "local" | "s3";
    queue: "memory" | "pg-boss";
    storage: "memory" | "postgres";
  };
  status: "ok" | "error";
  storage: "ok" | "error";
}

function buildHeaders(extraHeaders?: HeadersInit) {
  const headers = new Headers(getVisitorHeaders());
  const token = getStoredAuthToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => {
      headers.set(key, value);
    });
  }

  return headers;
}

async function readErrorMessage(res: Response, fallback: string) {
  const errorBody = await res.json().catch(() => ({ error: fallback }));
  return errorBody.error || fallback;
}

export async function registerUser(email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE}/api/auth/register`, {
    method: "POST",
    headers: buildHeaders({
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Registration failed."));
  }

  return res.json();
}

export async function loginUser(email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: buildHeaders({
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Login failed."));
  }

  return res.json();
}

export async function getCurrentUser(): Promise<AuthUser> {
  const res = await fetch(`${API_BASE}/api/auth/me`, {
    headers: buildHeaders(),
  });

  if (res.status === 401) {
    clearStoredAuthToken();
    throw new Error("Authentication required.");
  }

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Failed to load account."));
  }

  return res.json();
}

export async function logoutUser(): Promise<void> {
  const res = await fetch(`${API_BASE}/api/auth/logout`, {
    method: "POST",
    headers: buildHeaders(),
  });

  if (res.status === 401) {
    clearStoredAuthToken();
    return;
  }

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Logout failed."));
  }
}

export async function createBillingCheckout(
  plan: Exclude<UserPlan, "free">,
): Promise<BillingRedirectResponse> {
  const res = await fetch(`${API_BASE}/api/billing/checkout`, {
    method: "POST",
    headers: buildHeaders({
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({ plan }),
  });

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Failed to start checkout."));
  }

  return res.json();
}

export async function createBillingPortal(): Promise<BillingRedirectResponse> {
  const res = await fetch(`${API_BASE}/api/billing/portal`, {
    method: "POST",
    headers: buildHeaders(),
  });

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Failed to open billing portal."));
  }

  return res.json();
}

export async function getServiceHealth(): Promise<ServiceHealthResponse> {
  const res = await fetch(`${API_BASE}/api/health`, {
    headers: buildHeaders(),
  });
  const body = await res.json().catch(() => null) as ServiceHealthResponse | { error?: string } | null;

  if (!body) {
    throw new Error("Failed to load deployment capabilities.");
  }

  if (!res.ok && res.status !== 503) {
    throw new Error("error" in body ? body.error || "Failed to load deployment capabilities." : "Failed to load deployment capabilities.");
  }

  if ("error" in body) {
    throw new Error(body.error || "Failed to load deployment capabilities.");
  }

  return body as ServiceHealthResponse;
}

export async function uploadAndConvert(
  file: File,
  targetFormat: string,
): Promise<ConversionResponse> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("targetFormat", targetFormat);

  const res = await fetch(`${API_BASE}/api/convert`, {
    method: "POST",
    headers: buildHeaders(),
    body: formData,
  });

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Upload failed."));
  }

  return res.json();
}

export async function checkConversionStatus(id: number): Promise<ConversionResponse> {
  const res = await fetch(`${API_BASE}/api/convert/${id}`, {
    headers: buildHeaders(),
  });

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Failed to check status."));
  }

  return res.json();
}

export async function getConversions(options?: {
  format?: string;
  limit?: number;
  page?: number;
  status?: string;
}): Promise<ConversionListResponse> {
  const searchParams = new URLSearchParams();
  if (options?.page) {
    searchParams.set("page", String(options.page));
  }
  if (options?.limit) {
    searchParams.set("limit", String(options.limit));
  }
  if (options?.status) {
    searchParams.set("status", options.status);
  }
  if (options?.format) {
    searchParams.set("format", options.format);
  }

  const queryString = searchParams.toString();
  const res = await fetch(
    `${API_BASE}/api/conversions${queryString ? `?${queryString}` : ""}`,
    {
      headers: buildHeaders(),
    },
  );

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Failed to fetch conversions."));
  }

  return res.json();
}

export function getDownloadUrl(filename: string) {
  return `${API_BASE}/api/download/${filename}`;
}

export async function fetchDownloadBlob(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Blob> {
  const res = await fetchImpl(url, {
    headers: buildHeaders(),
  });

  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Download failed."));
  }

  return res.blob();
}

export async function downloadFile(
  filename: string,
  originalName: string,
  targetFormat: string,
) {
  const blob = await fetchDownloadBlob(getDownloadUrl(filename));
  const link = document.createElement("a");
  const objectUrl = URL.createObjectURL(blob);
  const baseName = originalName.replace(/\.[^/.]+$/, "");

  link.href = objectUrl;
  link.download = `${baseName}.${targetFormat}`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(objectUrl);
}
