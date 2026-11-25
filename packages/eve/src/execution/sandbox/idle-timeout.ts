import { isToolSessionId } from "#execution/tool-session/id.js";
import { owningSandboxDefinition, type RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type { SandboxProviderRuntime } from "#sandbox/provider.js";
import { recordedSandboxStopsIdle, type SandboxSessionState } from "#sandbox/state.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";

export function idleStop(
  registry: RuntimeSandboxRegistry,
  sessionId: string,
): { readonly idleTimeoutMs: number; readonly provider: SandboxProviderRuntime } | undefined {
  const registered = registry.sandbox;
  if (registered === null || isToolSessionId(sessionId)) return undefined;
  const owner = owningSandboxDefinition(registered);
  if (owner.kind !== "independent") return undefined;
  const provider = getSandboxEnvironmentRuntime(owner.environment);
  const { idleTimeoutMs } = provider;
  if (provider.implementation.onSessionIdle === undefined || idleTimeoutMs === false)
    return undefined;
  return { idleTimeoutMs, provider };
}

export function sandboxIdleTimeoutMs(
  registry: RuntimeSandboxRegistry,
  sessionId: string,
  recorded?: SandboxSessionState | null,
): number | undefined {
  const stop = idleStop(registry, sessionId);
  if (stop === undefined || !recordedSandboxStopsIdle(stop.provider, recorded)) return undefined;
  return stop.idleTimeoutMs;
}
