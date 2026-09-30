import { c, stripControl } from './ansi.js';
import type { DependencyEvent } from '../types.js';

/**
 * Formats events into a compact CI summary report.
 * Commit SHAs shown are full-length for auditability.
 */
export function renderCiSummary(events: DependencyEvent[], baseRef = 'default branch'): string {
  const lines: string[] = [];
  lines.push(c.bold(`─── dep-blame CI Summary (vs ${stripControl(baseRef)}) ───`));

  if (!events || events.length === 0) {
    lines.push(c.dim('No dependency changes detected in this branch/PR.'));
    return lines.join('\n');
  }

  let added = 0;
  let updated = 0;
  let removed = 0;
  const fullShas = new Set<string>();

  for (const ev of events) {
    if (ev.commitFull) fullShas.add(ev.commitFull);
    const pkg = stripControl(ev.package);
    const manifest = stripControl(ev.manifest);
    if (ev.type === 'added') {
      added++;
      lines.push(`${c.green('+ added')}   ${c.bold(pkg)} ${c.bold(stripControl(ev.to || ''))} ${c.dim(`(${manifest})`)}`);
    } else if (ev.type === 'updated') {
      updated++;
      lines.push(
        `${c.yellow('↑ updated')} ${c.bold(pkg)} ${stripControl(ev.from || '?')} -> ${c.bold(stripControl(ev.to || '?'))} ${c.dim(`(${manifest})`)}`
      );
    } else if (ev.type === 'removed') {
      removed++;
      lines.push(`${c.red('- removed')} ${c.bold(pkg)} ${c.dim(`was ${stripControl(ev.from || 'installed')} (${manifest})`)}`);
    }
  }

  lines.push('');
  const parts: string[] = [];
  if (added > 0) parts.push(c.green(`${added} added`));
  if (updated > 0) parts.push(c.yellow(`${updated} updated`));
  if (removed > 0) parts.push(c.red(`${removed} removed`));

  lines.push(c.bold(`Summary: `) + parts.join(', '));
  if (fullShas.size > 0 && fullShas.size <= 20) {
    lines.push(c.dim(`Commits: ${Array.from(fullShas).join(', ')}`));
  } else if (fullShas.size > 20) {
    lines.push(c.dim(`Commits: ${fullShas.size} commits in range (see --json for full SHAs)`));
  }

  return lines.join('\n');
}
