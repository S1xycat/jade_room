import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const missingSalt = randomBytes(16).toString('hex');
export const SESSION_SECONDS = 7 * 24 * 60 * 60;

export function loginName(value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const name = value.normalize('NFKC').trim();
  return /^[\p{L}\p{N}_-]{3,24}$/u.test(name) ? { name, key: name.toLowerCase() } : null;
}

export const validPassword = value => typeof value === 'string' && value.length >= 8 && Buffer.byteLength(value, 'utf8') <= 256;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: (await derive(password, salt, 64)).toString('hex') };
}

export async function checkPassword(password, credentials) {
  const actual = await derive(password, credentials?.salt ?? missingSalt, 64);
  return Boolean(credentials && timingSafeEqual(actual, Buffer.from(credentials.hash, 'hex')));
}

export function rateLimiter() {
  const buckets = new Map();
  const windowMs = 10 * 60_000;
  return (keys, now = Date.now()) => {
    for (const [key, entry] of buckets) if (entry.expires <= now) buckets.delete(key);
    if (keys.some(([key, limit]) => (buckets.get(key)?.amount ?? 0) >= limit)) return false;
    for (const [key] of keys) {
      const entry = buckets.get(key) ?? { amount: 0, expires: now + windowMs };
      entry.amount++;
      buckets.set(key, entry);
    }
    return true;
  };
}
