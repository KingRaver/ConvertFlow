import { getVisitorHeaders } from "./visitor";

const API_BASE = "";

export interface ConversionResponse {
  id: number;
  status: "pending" | "processing" | "completed" | "failed";
  outputFilename: string | null;
  convertedSize?: number | null;
  resultMessage?: string | null;
  expiresAt?: string | null;
  processingStartedAt?: string | null;
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
    headers: getVisitorHeaders(),
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Upload failed." }));
    throw new Error(err.error || "Upload failed.");
  }

  return res.json();
}

export async function checkConversionStatus(id: number): Promise<ConversionResponse> {
  const res = await fetch(`${API_BASE}/api/convert/${id}`, {
    headers: getVisitorHeaders(),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed to check status." }));
    throw new Error(err.error || "Failed to check status.");
  }

  return res.json();
}

export async function getConversions(): Promise<ConversionResponse[]> {
  const res = await fetch(`${API_BASE}/api/conversions`, {
    headers: getVisitorHeaders(),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed to fetch conversions." }));
    throw new Error(err.error || "Failed to fetch conversions.");
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
    headers: getVisitorHeaders(),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Download failed." }));
    throw new Error(err.error || "Download failed.");
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
