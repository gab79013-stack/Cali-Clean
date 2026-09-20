const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const DISPOSABLE = new Set(['mailinator.com', 'yopmail.com', 'tempmail.com', 'guerrillamail.com', 'sharklasers.com', '10minutemail.com', 'trashmail.com']);

export const clean = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function validEmail(email) {
  const e = clean(email, 190).toLowerCase();
  if (!EMAIL_RE.test(e)) return { ok: false, reason: 'invalid' };
  const domain = e.split('@')[1];
  if (DISPOSABLE.has(domain)) return { ok: false, reason: 'disposable' };
  return { ok: true, email: e };
}

/** Normaliza teléfonos de EE.UU. a +1XXXXXXXXXX cuando es posible. */
export function normalizePhone(phone) {
  const digits = clean(phone, 30).replace(/[^\d]/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

export const validZip = (zip) => (/^\d{5}$/.test(clean(zip, 10)) ? clean(zip, 10) : clean(zip, 10));

export function validDate(value) {
  const v = clean(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return '';
  return Number.isNaN(new Date(`${v}T12:00:00`).getTime()) ? '' : v;
}
