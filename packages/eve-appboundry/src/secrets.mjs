const FORMATS = [
  ["an Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["an OpenAI-style API key", /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ["a GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}/],
  ["an AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["a Vercel AI Gateway key", /\bvck_[A-Za-z0-9]{30,}/],
  ["a private key", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
];
const CREDENTIAL_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

export function findSecrets(text, where, env = process.env) {
  const found = FORMATS.filter(([, pattern]) => pattern.test(text)).map(
    ([kind]) => `${where} contains ${kind}`,
  );
  for (const [name, value] of Object.entries(env)) {
    if (
      CREDENTIAL_NAME.test(name) &&
      typeof value === "string" &&
      value.length >= 12 &&
      text.includes(value)
    )
      found.push(`${where} contains the value of $${name}`);
  }
  return found;
}
