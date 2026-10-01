import { c, stripControl } from './ansi.js';
import { eventDayKey } from './calendar.js';
import type { DependencyEvent } from '../types.js';

interface PackageStat {
  added: number;
  updated: number;
  removed: number;
  total: number;
}

/**
 * Calculates and formats aggregate stats over dependency events.
 * Declared (package.json) and resolved (lockfile) changes are counted
 * separately so one dependency isn't tallied twice for a single intent.
 */
export function renderStatsView(events: DependencyEvent[]): string {
  if (!events || events.length === 0) {
    return c.dim('No dependency events to calculate statistics.');
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  let declared = 0;
  let resolved = 0;

  const packageCounts = new Map<string, PackageStat>();
  const authorCounts = new Map<string, number>();

  for (const ev of events) {
    if (ev.type === 'added') added++;
    else if (ev.type === 'updated') updated++;
    else if (ev.type === 'removed') removed++;

    if (ev.source === 'lockfile') resolved++;
    else declared++;

    const pkg = stripControl(ev.package);
    if (!packageCounts.has(pkg)) {
      packageCounts.set(pkg, { added: 0, updated: 0, removed: 0, total: 0 });
    }
    const pEntry = packageCounts.get(pkg)!;
    pEntry[ev.type] = (pEntry[ev.type] || 0) + 1;
    pEntry.total++;

    const author = stripControl(ev.author) || 'Unknown';
    authorCounts.set(author, (authorCounts.get(author) || 0) + 1);
  }

  const topPackages = Array.from(packageCounts.entries())
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 5);

  const topAuthors = Array.from(authorCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const dates = events.map((e) => eventDayKey(e.date)).filter((d): d is string => !!d).sort();
  const firstDate = dates[0] || 'N/A';
  const lastDate = dates[dates.length - 1] || 'N/A';

  const lines = [
    c.bold('Dependency Churn & History Statistics'),
    c.dim('────────────────────────────────────────────────────'),
    `Timeframe:             ${c.cyan(firstDate)} to ${c.cyan(lastDate)}`,
    `Total Events:          ${c.bold(events.length)}`,
    `Distinct Packages:     ${c.bold(packageCounts.size)}`,
    `Declared Changes:      ${c.bold(declared)} (package.json)`,
    `Resolved Changes:      ${c.bold(resolved)} (lockfiles)`,
    '',
    c.bold('Event Breakdown:'),
    `  ${c.green('+ Added:')}            ${c.bold(added)}`,
    `  ${c.yellow('↑ Updated:')}          ${c.bold(updated)}`,
    `  ${c.red('- Removed:')}          ${c.bold(removed)}`,
    '',
    c.bold('Most Modified Packages (Top 5 Churn):')
  ];

  for (const [pkg, counts] of topPackages) {
    const detail = `(${counts.updated} updates, ${counts.added} adds, ${counts.removed} removes)`;
    lines.push(`  ${c.bold(pkg.padEnd(26))} ${c.cyan(String(counts.total).padStart(3))} changes  ${c.dim(detail)}`);
  }

  lines.push('');
  lines.push(c.bold('Top Authors (Dependency Touches):'));
  for (const [author, count] of topAuthors) {
    lines.push(`  ${author.padEnd(26)} ${c.bold(count)} event(s)`);
  }

  return lines.join('\n');
}
