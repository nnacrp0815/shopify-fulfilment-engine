import { createHmac, timingSafeEqual } from "node:crypto";
export function sign(body: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}
export function verify(
  body: Buffer,
  signature: string,
  secrets: readonly string[],
): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const received = Buffer.from(signature, "base64");
  let valid = false;
  for (const secret of secrets) {
    const expected = Buffer.from(sign(body, secret), "base64");
    valid = timingSafeEqual(received, expected) || valid;
  }
  return valid;
}
export function tokenMatches(received: string, expected: string): boolean {
  const a = Buffer.from(received),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
