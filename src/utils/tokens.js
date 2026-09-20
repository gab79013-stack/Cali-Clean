import crypto from 'node:crypto';
import { config } from '../config.js';

export function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', config.secret).update(data).digest('base64url').slice(0, 24);
  return `${data}.${sig}`;
}

export function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', config.secret).update(data).digest('base64url').slice(0, 24);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export const newUid = () => crypto.randomBytes(9).toString('base64url');
