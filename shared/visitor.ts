export const VISITOR_ID_HEADER = "x-visitor-id";
export const VISITOR_ID_STORAGE_KEY = "convertflow.visitor-id";
export const VISITOR_ID_PREFIX = "cf_";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function generateVisitorId(randomUUID: () => string): string {
  return `${VISITOR_ID_PREFIX}${randomUUID()}`;
}

export function isValidVisitorId(value: string | undefined | null): value is string {
  if (!value || !value.startsWith(VISITOR_ID_PREFIX)) {
    return false;
  }

  return UUID_PATTERN.test(value.slice(VISITOR_ID_PREFIX.length));
}
