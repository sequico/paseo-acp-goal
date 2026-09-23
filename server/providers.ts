import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Which providers are ACP agents.
 *
 * This cannot come from `paseo.config.get()`: the daemon's mutable-config schema
 * exposes only `additionalModels`, `enabled`, and `paseoTools` for a provider
 * entry, while the `extends: "acp"` that identifies an ACP provider lives in the
 * config file. So the file is the source.
 *
 * The ACP set decides which agents get the goal tool injected. It is a default,
 * not a fence: an explicit goal label drives any provider through the same loop.
 */

export const ACP_EXTENDS = "acp";

interface ProviderEntry {
  extends?: unknown;
}

interface ConfigShape {
  agents?: { providers?: Record<string, ProviderEntry | undefined> | undefined } | undefined;
}

/** Provider ids whose config entry extends the ACP adapter. */
export function acpProvidersFromConfig(config: unknown): Set<string> {
  const acp = new Set<string>();
  if (config === null || typeof config !== "object") {
    return acp;
  }
  const providers = (config as ConfigShape).agents?.providers;
  if (providers === null || typeof providers !== "object") {
    return acp;
  }

  for (const [providerId, entry] of Object.entries(providers)) {
    if (entry !== null && typeof entry === "object" && entry.extends === ACP_EXTENDS) {
      acp.add(providerId);
    }
  }
  return acp;
}

export async function readAcpProviders(configPath: string): Promise<Set<string>> {
  const raw = await readFile(configPath, "utf8").catch(() => null);
  if (raw === null) {
    return new Set();
  }
  try {
    return acpProvidersFromConfig(JSON.parse(raw));
  } catch {
    // An unparseable config means an empty ACP set, so the plugin falls back to
    // explicit goal labels instead of guessing at provider identities.
    return new Set();
  }
}

export function configPathFor(paseoHome: string): string {
  return path.join(paseoHome, "config.json");
}
