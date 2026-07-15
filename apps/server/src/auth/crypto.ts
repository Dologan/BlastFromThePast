import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Symmetric encryption for OAuth tokens at rest. The 32-byte key lives in a
 * file beside the DB (generated on first use, chmod 600), never in the DB
 * itself, so a leaked DB file alone does not expose usable tokens.
 */
export class TokenCrypto {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('TokenCrypto key must be 32 bytes');
  }

  /** An in-memory key that does not survive restart — for tests only. */
  static ephemeral(): TokenCrypto {
    return new TokenCrypto(crypto.randomBytes(32));
  }

  static loadOrCreate(keyPath: string): TokenCrypto {
    if (fs.existsSync(keyPath)) {
      return new TokenCrypto(fs.readFileSync(keyPath));
    }
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    return new TokenCrypto(key);
  }

  /** Returns base64(iv | authTag | ciphertext). */
  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
  }

  decrypt(blob: string): string {
    const buf = Buffer.from(blob, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}
