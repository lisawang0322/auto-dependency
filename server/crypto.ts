/** Tokens at rest: AES-256-GCM with a key derived from TOKEN_KEY (or SESSION_SECRET). One string in, one string out. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export class TokenBox {
  private readonly key: Buffer;
  constructor(secret: string) { this.key = createHash("sha256").update(secret).digest(); }
  seal(value: unknown): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
  }
  /** null when the string was not sealed with this key or was tampered with. */
  open<T>(sealed: string): T | null {
    try {
      const b = Buffer.from(sealed, "base64url");
      const d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8")) as T;
    } catch { return null; }
  }
}
