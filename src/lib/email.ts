const EMAIL_LOCAL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const EMAIL_LABEL_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const EMAIL_TLD_RE = /^[a-zA-Z]{2,63}$/;

export function normalizeEmail(raw: string): string {
  return raw.trim();
}

export function isValidEmail(raw: string): boolean {
  const email = raw.trim();
  if (!email || email.length > 254) return false;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !EMAIL_LOCAL_RE.test(local)) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (!EMAIL_LABEL_RE.test(label)) return false;
  }
  const tld = labels[labels.length - 1]!;
  return EMAIL_TLD_RE.test(tld);
}
