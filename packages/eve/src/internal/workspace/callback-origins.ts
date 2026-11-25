export const CALLBACK_ALLOWED_ORIGINS_ENV = "EVE_CALLBACK_ALLOWED_ORIGINS";

export function isAllowedCallbackOrigin(origin: string): boolean {
  const configured = process.env[CALLBACK_ALLOWED_ORIGINS_ENV];
  if (configured === undefined || configured.trim().length === 0) return false;
  return configured
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .some((entry) => URL.parse(entry)?.origin === origin);
}
