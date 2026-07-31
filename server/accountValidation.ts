const ISO_BIRTHDATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseBirthdate(value: string): { year: number; month: number; day: number } | null {
  const match = ISO_BIRTHDATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

export function isAtLeastAge(birthdate: string, minimumAge: number, now: Date = new Date()): boolean {
  const parsed = parseBirthdate(birthdate);
  if (!parsed || !Number.isInteger(minimumAge) || minimumAge < 0 || Number.isNaN(now.getTime())) return false;
  const today = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
  if (
    parsed.year > today.year
    || (parsed.year === today.year && parsed.month > today.month)
    || (parsed.year === today.year && parsed.month === today.month && parsed.day > today.day)
  ) return false;
  let age = today.year - parsed.year;
  if (today.month < parsed.month || (today.month === parsed.month && today.day < parsed.day)) age -= 1;
  return age >= minimumAge;
}
