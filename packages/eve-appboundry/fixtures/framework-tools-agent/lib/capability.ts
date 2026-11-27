export const CAPABILITY_ENDPOINT = "https://capabilities.invalid/invoke";

export async function invokeCapability(
  capability: string,
  input: unknown,
  idempotencyKey: string,
): Promise<unknown> {
  const response = await fetch(CAPABILITY_ENDPOINT, {
    body: JSON.stringify({ capability, input, idempotencyKey }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json()) as { ok: boolean; value?: unknown; error?: unknown };
  return body.ok ? body.value : { error: body.error };
}
