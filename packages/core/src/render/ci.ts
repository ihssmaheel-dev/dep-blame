import { c } from './ansi.js';
import type { DependencyEvent } from '../types.js';

/**
 * Formats events into a compact CI summary report.
 */
export function renderCiSummary(events: DependencyEvent[], baseRef = 'default branch'): string {
  const lines: string[] = [];
  lines.push(c.bold(`─── dep-blame CI Summary (vs ${baseRef}) ───`));

  if (!events || events.length === 0) {
    lines.push(c.dim('No dependency changes detected in this branch/PR.'));
    return lines.join('\n');
  }

  let added = 0;
  let updated = 0;
  let removed = 0;

  for (const ev of events) {
    if (ev.type === 'added') {
      added++;
      lines.push(`${c.green('+ added')}   ${c.bold(ev.package)} ${c.bold(ev.to || '')} ${c.dim(`(${ev.manifest})`)}`);
    } else if (ev.type === 'updated') {
      updated++;
      lines.push(
        `${c.yellow('↑ updated')} ${c.bold(ev.package)} ${ev.from || '?'} -> ${c.bold(ev.to || '?')} ${c.dim(`(${ev.manifest})`)}`
      );
    } else if (ev.type === 'removed') {
      removed++;
      lines.push(`${c.red('- removed')} ${c.bold(ev.package)} ${c.dim(`was ${ev.from || 'installed'} (${ev.manifest})`)}`);
    }
  }

  lines.push('');
  const parts: string[] = [];
  if (added > 0) parts.push(c.green(`${added} added`));
  if (updated > 0) parts.push(c.yellow(`${updated} updated`));
  if (removed > 0) parts.push(c.red(`${removed} removed`));

  lines.push(c.bold(`Summary: `) + parts.join(', '));

  return lines.join('\n');
}
