export function ratingToHours(rating: number): number {
  if (rating >= 10) return Infinity; // Critical/irreversible — never auto-decide
  return Math.max(0, rating * 2 - 1);
}

export function isActiveHour(hour: number): boolean {
  return hour >= 9 && hour < 21;
}

export function calculateDeadline(rating: number, from: Date = new Date()): Date {
  const hours = ratingToHours(rating);
  if (hours === 0) return from;
  if (!isFinite(hours)) return new Date('9999-12-31T23:59:59Z'); // Never auto-decide

  const cursor = new Date(from);
  let remaining = hours;

  while (remaining > 0) {
    cursor.setHours(cursor.getHours() + 1);
    if (isActiveHour(cursor.getHours())) {
      remaining--;
    }
  }

  return cursor;
}

export function hasDeadlinePassed(deadline: string, now: Date = new Date()): boolean {
  return now >= new Date(deadline);
}

export function extendDeadline(currentDeadline: string, activeHours: number): string {
  const cursor = new Date(currentDeadline);
  let remaining = activeHours;

  while (remaining > 0) {
    cursor.setHours(cursor.getHours() + 1);
    if (isActiveHour(cursor.getHours())) {
      remaining--;
    }
  }

  return cursor.toISOString();
}

export function pauseForVacation(deadline: string, now: Date = new Date()): number {
  const end = new Date(deadline);
  if (now >= end) return 0;

  const cursor = new Date(now);
  let activeHours = 0;

  while (cursor < end) {
    cursor.setHours(cursor.getHours() + 1);
    if (isActiveHour(cursor.getHours())) {
      activeHours++;
    }
  }

  return activeHours;
}

export function deadlineFromActiveHours(activeHours: number, from: Date = new Date()): string {
  if (activeHours <= 0) return from.toISOString();
  const cursor = new Date(from);
  let remaining = activeHours;
  while (remaining > 0) {
    cursor.setHours(cursor.getHours() + 1);
    if (isActiveHour(cursor.getHours())) {
      remaining--;
    }
  }
  return cursor.toISOString();
}
