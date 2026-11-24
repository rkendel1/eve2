import { feltdbWorldMemory } from "@appport/eve-world-feltdb";
import { defineMemory } from "eve/memory";
import { fileMemory, inMemory } from "eve/memory/file";

function backend() {
  if (process.env.EVE_E2E_WORKFLOW_WORLD === "@appport/eve-world-feltdb")
    return feltdbWorldMemory();
  return inMemory();
}

const provider = process.env.VERCEL ? fileMemory() : fileMemory({ backend: backend() });

export default defineMemory({
  description: "Remember stable facts with the bounded file provider.",
  provider,
  scope: () =>
    process.env.VERCEL_DEPLOYMENT_ID?.trim() ||
    process.env.VERCEL_URL?.trim() ||
    "local-file-memory-e2e",
});
