export const AUTH_TOKEN_STORAGE_KEY = "convertflow.auth-token";

interface StorageLike {
  getItem(key: string): string | null;
  removeItem?(key: string): void;
  setItem(key: string, value: string): void;
}

function getStorage(storage?: StorageLike) {
  if (storage) {
    return storage;
  }

  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage;
}

export function getStoredAuthToken(storage?: StorageLike) {
  return getStorage(storage)?.getItem(AUTH_TOKEN_STORAGE_KEY) ?? null;
}

export function setStoredAuthToken(token: string, storage?: StorageLike) {
  getStorage(storage)?.setItem(AUTH_TOKEN_STORAGE_KEY, token);
}

export function clearStoredAuthToken(storage?: StorageLike) {
  getStorage(storage)?.removeItem?.(AUTH_TOKEN_STORAGE_KEY);
}
