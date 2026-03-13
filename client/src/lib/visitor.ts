import {
  VISITOR_ID_HEADER,
  VISITOR_ID_STORAGE_KEY,
  generateVisitorId,
  isValidVisitorId,
} from "@shared/visitor";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function getOrCreateVisitorId(
  storage: StorageLike = window.localStorage,
  randomUUID: () => string = () => crypto.randomUUID(),
): string {
  const existing = storage.getItem(VISITOR_ID_STORAGE_KEY);
  if (isValidVisitorId(existing)) {
    return existing;
  }

  const nextVisitorId = generateVisitorId(randomUUID);
  storage.setItem(VISITOR_ID_STORAGE_KEY, nextVisitorId);
  return nextVisitorId;
}

export function getVisitorHeaders(): HeadersInit {
  return {
    [VISITOR_ID_HEADER]: getOrCreateVisitorId(),
  };
}
