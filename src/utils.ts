import crypto from 'crypto';

/**
 * Formats a Date to HH:MM in Europe/Kyiv timezone.
 */
export function formatKyivTime(date: Date): string {
  return date.toLocaleTimeString('uk-UA', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Kyiv',
  });
}

/**
 * Returns the next occurrence of HH:MM in Kyiv time.
 * If that time has already passed today (Kyiv), returns tomorrow at that time.
 *
 * Works correctly regardless of the host system timezone because
 * Docker sets TZ=Europe/Kyiv, so new Date() / Date.now() are already Kyiv-local.
 */
export function nextOccurrenceKyiv(hour: number, minute: number): Date {
  const now = new Date();
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setHours(hour, minute);
  if (d.getTime() <= now.getTime()) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

export function isTomorrow(date: Date): boolean {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return date.getDate() === tomorrow.getDate();
}

export function token(): string {
  return crypto.randomBytes(4).toString('hex');
}
