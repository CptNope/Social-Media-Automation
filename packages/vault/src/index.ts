import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Credential vault — envelope encryption.
 *
 * - Each secret is encrypted with a fresh 256-bit data key (DEK) using AES-256-GCM.
 * - The DEK is wrapped by a key-encryption key (KEK) held in a KMS (AWS/GCP KMS in
 *   production, a local key in development).
 * - Additional authenticated data (AAD) binds every ciphertext to its tenant and
 *   integration, so a row copied to another tenant fails to decrypt.
 * - KEK rotation only re-wraps DEKs; secret ciphertext is untouched.
 */

export interface KekProvider {
  readonly kekId: string;
  wrap(dek: Buffer, aad: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer, aad: Buffer): Promise<Buffer>;
}

export interface SecretContext {
  tenantId: string;
  integrationId: string;
}

export interface EncryptedSecret {
  version: 1;
  kekId: string;
  /** base64 */
  wrappedDek: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

const ALG = "aes-256-gcm";
const IV_BYTES = 12;

function aadFor(ctx: SecretContext): Buffer {
  if (!ctx.tenantId || !ctx.integrationId) throw new Error("tenantId and integrationId are required");
  return Buffer.from(`jat-vault:v1|tenant:${ctx.tenantId}|integration:${ctx.integrationId}`, "utf8");
}

function gcmEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer) {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv(ALG, key, iv, { authTagLength: TAG_BYTES });
  c.setAAD(aad);
  const ciphertext = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv, ciphertext, authTag: c.getAuthTag() };
}

const TAG_BYTES = 16;

function gcmDecrypt(key: Buffer, iv: Buffer, ciphertext: Buffer, authTag: Buffer, aad: Buffer): Buffer {
  // Reject truncated tags and non-standard IVs explicitly (Node would otherwise accept short tags).
  if (iv.length !== IV_BYTES) throw new Error("Invalid IV length");
  if (authTag.length !== TAG_BYTES) throw new Error("Invalid auth tag length");
  const d = createDecipheriv(ALG, key, iv, { authTagLength: TAG_BYTES });
  d.setAAD(aad);
  d.setAuthTag(authTag);
  return Buffer.concat([d.update(ciphertext), d.final()]);
}

/** Development-only KEK provider backed by a 32-byte key from the environment. */
export class LocalKekProvider implements KekProvider {
  readonly #key: Buffer;
  constructor(
    key: Buffer,
    readonly kekId: string,
  ) {
    if (key.length !== 32) throw new Error("Local KEK must be exactly 32 bytes");
    this.#key = Buffer.from(key);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): LocalKekProvider {
    if (env.NODE_ENV === "production") throw new Error("LocalKekProvider must not be used in production; configure a KMS provider");
    const b64 = env.LOCAL_KEK_BASE64;
    if (!b64) throw new Error("LOCAL_KEK_BASE64 is not set");
    return new LocalKekProvider(Buffer.from(b64, "base64"), env.LOCAL_KEK_ID ?? "local-dev-1");
  }

  async wrap(dek: Buffer, aad: Buffer): Promise<Buffer> {
    const { iv, ciphertext, authTag } = gcmEncrypt(this.#key, dek, aad);
    return Buffer.concat([iv, authTag, ciphertext]);
  }

  async unwrap(wrapped: Buffer, aad: Buffer): Promise<Buffer> {
    const iv = wrapped.subarray(0, IV_BYTES);
    const tag = wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ct = wrapped.subarray(IV_BYTES + TAG_BYTES);
    return gcmDecrypt(this.#key, iv, ct, tag, aad);
  }
}

export async function encryptSecret(plaintext: string, ctx: SecretContext, kek: KekProvider): Promise<EncryptedSecret> {
  const aad = aadFor(ctx);
  const dek = randomBytes(32);
  try {
    const { iv, ciphertext, authTag } = gcmEncrypt(dek, Buffer.from(plaintext, "utf8"), aad);
    const wrappedDek = await kek.wrap(dek, aad);
    return {
      version: 1,
      kekId: kek.kekId,
      wrappedDek: wrappedDek.toString("base64"),
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  } finally {
    dek.fill(0);
  }
}

export async function decryptSecret(record: EncryptedSecret, ctx: SecretContext, keks: KekProvider | ReadonlyMap<string, KekProvider>): Promise<string> {
  const kek = "wrap" in keks ? keks : keks.get(record.kekId);
  if (!kek || kek.kekId !== record.kekId) throw new Error(`No KEK available for id ${record.kekId}`);
  const aad = aadFor(ctx);
  const dek = await kek.unwrap(Buffer.from(record.wrappedDek, "base64"), aad);
  try {
    return gcmDecrypt(dek, Buffer.from(record.iv, "base64"), Buffer.from(record.ciphertext, "base64"), Buffer.from(record.authTag, "base64"), aad).toString("utf8");
  } finally {
    dek.fill(0);
  }
}

/** Re-wrap the data key under a new KEK (key rotation). Secret ciphertext is unchanged. */
export async function rewrapSecret(record: EncryptedSecret, ctx: SecretContext, from: KekProvider, to: KekProvider): Promise<EncryptedSecret> {
  if (record.kekId !== from.kekId) throw new Error("Record is not wrapped by the source KEK");
  const aad = aadFor(ctx);
  const dek = await from.unwrap(Buffer.from(record.wrappedDek, "base64"), aad);
  try {
    const wrapped = await to.wrap(dek, aad);
    return { ...record, kekId: to.kekId, wrappedDek: wrapped.toString("base64") };
  } finally {
    dek.fill(0);
  }
}

/** Redact helper for logs: never print secret material. */
export const redact = (_secret: unknown): string => "[REDACTED]";
