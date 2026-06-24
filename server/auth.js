// Simple auth: scrypt password hashing + stateless HMAC-signed session tokens.
// Tokens are self-contained (payload.signature), so they survive restarts as long as
// the signing secret (persisted in DB settings) is stable — no server-side session store.

import crypto from 'node:crypto';

let SECRET = 'mindcanvas-dev-secret';
export function setAuthSecret(s) { if (s) SECRET = s; }

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 32);
  return salt.toString('hex') + ':' + hash.toString('hex');
}
export function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  let actual;
  try { actual = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 32); } catch { return false; }
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

export function issueToken({ username, role }, ttlMs = 7 * 24 * 3600 * 1000) {
  const payload = b64(JSON.stringify({ u: username, r: role, exp: Date.now() + ttlMs }));
  return payload + '.' + sign(payload);
}
export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!sig || sign(payload) !== sig) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  if (!data.exp || data.exp < Date.now()) return null;
  return { username: data.u, role: data.r };
}
