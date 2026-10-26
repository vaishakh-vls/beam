// Recognises common credential formats so they stay out of clipboard history.

const SECRET_PATTERNS: RegExp[] = [
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack bot/user tokens
  /\bxapp-\d-[A-Za-z0-9-]{10,}/, // Slack app tokens
  /\bsk-(?:ant-|proj-|live_|test_)?[A-Za-z0-9_-]{20,}/, // Anthropic, OpenAI, Stripe secret keys
  /\b[rp]k_(?:live|test)_[A-Za-z0-9]{20,}/, // Stripe restricted/publishable keys
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{30,}/, // GitHub fine-grained tokens
  /\bglpat-[A-Za-z0-9_-]{20,}/, // GitLab tokens
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, // AWS access key IDs
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API keys
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWTs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private keys
];

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}
