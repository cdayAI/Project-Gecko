import type { Bar } from "../core/types.js";
import { etParts } from "../utils/time.js";

// Limited to this registered window. This is not a general exchange calendar.
// https://www.nyse.com/trade/hours-calendars (verified 2026-09-17).
// The only full closure in Aug 3 through Sep 16, 2026 is Labor Day, Sep 7.
export const RESEARCH_CALENDAR_SOURCE = "https://www.nyse.com/trade/hours-calendars";
export function expectedResearchSessions(): string[] {
  const dates: string[] = [];
  for (let ms = Date.parse("2026-08-03T00:00:00Z"); ms < Date.parse("2026-09-17T00:00:00Z"); ms += 86_400_000) {
    const date = new Date(ms);
    const key = date.toISOString().slice(0, 10);
    if (date.getUTCDay() > 0 && date.getUTCDay() < 6 && key !== "2026-09-07") dates.push(key);
  }
  return dates;
}

export function researchCoverageIssues(bars: readonly Bar[], symbols: readonly string[]): string[] {
  const dates = expectedResearchSessions();
  const expected = new Set(dates);
  const observed = new Set<string>();
  for (const bar of bars) {
    const parts = etParts(bar.timestamp);
    if (!expected.has(parts.date) || !symbols.includes(bar.symbol)) throw new Error("Bar outside registered date/symbol universe");
    observed.add(`${bar.symbol}:${parts.date}:${parts.hour * 60 + parts.minute}`);
  }
  const issues: string[] = [];
  for (const date of dates) for (const symbol of symbols) {
    let missing = 0;
    for (let minute = 570; minute <= 690; minute += 5) if (!observed.has(`${symbol}:${date}:${minute}`)) missing++;
    if (missing) issues.push(`${date} ${symbol}: ${missing} missing required morning observations`);
  }
  return issues;
}
