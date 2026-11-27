import { defineAgent } from "eve";

export default defineAgent({
  defaultTools: false,
  description:
    "Researches a repository question with the repository tools and reports the facts it found.",
  model: "anthropic/claude-sonnet-5",
});
