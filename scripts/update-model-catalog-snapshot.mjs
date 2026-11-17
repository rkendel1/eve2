import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models/catalog";
const target = fileURLToPath(
  new URL("../packages/eve/src/compiler/model-catalog-snapshot.ts", import.meta.url),
);

const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error(`Model catalog request failed with HTTP ${response.status}.`);
const catalog = await response.json();

const models = catalog.models
  .map((model) => ({
    slug: model.slug,
    providers: (model.providers ?? [])
      .filter((provider) => provider.contextWindowTokens > 0)
      .map((provider) => ({
        provider: provider.provider,
        providerModelId: provider.providerModelId,
        contextWindowTokens: provider.contextWindowTokens,
      })),
  }))
  .filter((model) => model.providers.length > 0)
  .sort((left, right) => left.slug.localeCompare(right.slug));

const snapshot = {
  fetchedAt: new Date().toISOString().slice(0, 10) + "T00:00:00.000Z",
  models,
  providerAliases: catalog.providerAliases ?? {},
};

await writeFile(
  target,
  `import type { ModelCatalogSnapshot } from "#internal/model-catalog.js";\n\nexport const MODEL_CATALOG_SNAPSHOT: ModelCatalogSnapshot = ${JSON.stringify(snapshot)};\n`,
);
console.log(`[model-catalog-snapshot] wrote ${models.length} models to ${target}`);
