import { defineAgent } from "eve";

export default defineAgent({
  defaultTools: false,
  model: "anthropic/claude-sonnet-5",
});
