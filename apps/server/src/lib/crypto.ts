import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.ts';

// Secrets at rest (mailbox refresh tokens): AES-256-GCM with a key derived from APP_ENCRYPTION_KEY.

const key = () => {
  if (!config.APP_ENCRYPTION_KEY) throw new Error('APP_ENCRYPTION_KEY is required to store tokens');
  return createHash('sha256').update(config.APP_ENCRYPTION_KEY).digest();
};

/** "v1.<iv>.<tag>.<ciphertext>", base64url. */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decrypt(token: string): string {
  const [v, iv, tag, data] = token.split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('bad ciphertext');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}
