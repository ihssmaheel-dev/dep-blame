import { c } from './ansi.js';

/**
 * Calculates aggregate stats over dependency events.
 *
 * @param {import('../diff/snapshot-diff.js').DependencyEvent[]} events
 * @returns {string} Formatted terminal summary
 */
export function renderStatsView(events) {
  if (!events || events.length === 0) {
    return c.dim('No dependency events to calculate statistics.');
  }

  let added = 0;
  let updated = 0;
  let removed = 0;

  const packageCounts = new Map(); // pkg -> { added: 0, updated: 0, removed: 0, total: 0 }
  const authorCounts = new Map(); // author -> count

  for (const ev of events) {
    if (ev.type === 'added') added++;
    else if (ev.type === 'updated') updated++;
    else if (ev.type === 'removed') removed++;

    // Track package stats
    const pkg = ev.package;
    if (!packageCounts.has(pkg)) {
      packageCounts.set(pkg, { added: 0, updated: 0, removed: 0, total: 0 });
    }
    const pEntry = packageCounts.get(pkg);
    pEntry[ev.type] = (pEntry[ev.type] || 0) + 1;
    pEntry.total++;

    // Track author stats
    const author = ev.author || 'Unknown';
    authorCounts.set(author, (authorCounts.get(author) || 0) + 1);
  }

  // Top churned packages
  const topPackages = Array.from(packageCounts.entries())
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 5);

  // Top authors
  const topAuthors = Array.from(authorCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const dates = events.map((e) => e.date).filter(Boolean).sort();
  const firstDate = dates[0] ? dates[0].slice(0, 10) : 'N/A';
  const lastDate = dates[dates.length - 1] ? dates[dates.length - 1].slice(0, 10) : 'N/A';

  const lines = [
    c.bold('Dependency Churn & History Statistics'),
    c.dim('────────────────────────────────────────────────────'),
    `Timeframe:             ${c.cyan(firstDate)} to ${c.cyan(lastDate)}`,
    `Total Events:          ${c.bold(events.length)}`,
    `Distinct Packages:     ${c.bold(packageCounts.size)}`,
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
    lines.push(`  ${author.padEnd(26)} ${c.bold(count)} commit(s)`);
  }

  return lines.join('\n');
}
