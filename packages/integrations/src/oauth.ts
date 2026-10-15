import { createHash, randomBytes } from "node:crypto";

/** PKCE pair (RFC 7636, S256). The verifier never leaves the server. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
