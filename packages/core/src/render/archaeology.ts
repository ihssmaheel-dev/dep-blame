import { c, stripControl } from './ansi.js';
import type { DependencyEvent, HeadEntry } from '../types.js';

function formatDate(isoString?: string): string {
  if (!isoString) return '';
  return isoString.split('T')[0] || isoString.slice(0, 10);
}

function formatRelativeTime(isoString?: string): string {
  if (!isoString) return '';
  const diff = Date.now() - new Date(isoString).getTime();
  if (isNaN(diff)) return '';
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

/**
 * Renders the package archaeology lifecycle view.
 *
 * When `headState` (HEAD-declared dependencies from the engine) is given,
 * per-manifest status comes from HEAD reality — not from the last
 * chronological event, which may live on an unmerged branch.
 */
export function renderArchaeologyView(
  packageName: string,
  events: DependencyEvent[],
  headState?: HeadEntry[],
  headStateComplete = true
): string {
  const safeName = stripControl(packageName);
  const pkgEvents = events.filter((e) => e.package === packageName);

  if (pkgEvents.length === 0) {
    return [
      c.bold('Archaeology for ') + c.bold(c.cyan(safeName)),
      c.dim(`No change events found for package "${safeName}".`)
    ].join('\n\n');
  }

  const latestEvent = pkgEvents[pkgEvents.length - 1];
  let statusBanner = '';

  const headEntries = headState ? headState.filter((h) => h.package === packageName) : null;

  if (headEntries && headEntries.length > 0) {
    const parts = headEntries.map(
      (h) => `${stripControl(h.version)} (${stripControl(h.depType)} in ${stripControl(h.manifest)})`
    );
    statusBanner = c.green('● Active at HEAD') + c.dim(` in ${headEntries.length} manifest(s): ${parts.join('; ')}`);
  } else if (headEntries && !headStateComplete) {
    statusBanner = c.yellow('● HEAD status unknown') + c.dim(' (unreadable manifest)');
  } else if (headEntries) {
    statusBanner = c.dim('● Not declared at HEAD') + c.dim(` (last event in ${stripControl(latestEvent.commit)})`);
  } else if (latestEvent.type === 'removed') {
    statusBanner = c.red('● Currently removed') + c.dim(` (last active in ${stripControl(latestEvent.commit)})`);
  } else {
    statusBanner =
      c.green('● Active') +
      c.bold(` ${stripControl(latestEvent.to || '')}`) +
      c.dim(` (${stripControl(latestEvent.depType || 'dependencies')} in ${stripControl(latestEvent.manifest)})`);
  }

  const lines = [
    c.bold('Archaeology for ') + c.bold(c.cyan(safeName)),
    `Status: ${statusBanner}`,
    `Total modifications: ${c.bold(pkgEvents.length)}`,
    '',
    c.dim('Timeline (chronological order):'),
    c.dim('──────────────────────────────────────────────────────────────────')
  ];

  for (let i = 0; i < pkgEvents.length; i++) {
    const ev = pkgEvents[i];
    const isLast = i === pkgEvents.length - 1;
    const date = formatDate(ev.date);
    const rel = formatRelativeTime(ev.date);

    let typeStr = '';
    let changeStr = '';

    if (ev.type === 'added') {
      typeStr = c.green('+ added  ');
      changeStr = c.bold(stripControl(ev.to || ''));
    } else if (ev.type === 'updated') {
      typeStr = c.yellow('↑ updated');
      const move = ev.depTypeFrom && ev.depTypeFrom !== ev.depType ? c.dim(` [${ev.depTypeFrom} → ${ev.depType}]`) : '';
      changeStr = `${stripControl(ev.from || '?')} -> ${c.bold(stripControl(ev.to || '?'))}${move}`;
    } else if (ev.type === 'removed') {
      typeStr = c.red('- removed');
      changeStr = c.dim(`was ${stripControl(ev.from || 'installed')}`);
    }

    const nodeSymbol = ev.type === 'added' ? c.green('●') : ev.type === 'removed' ? c.red('●') : c.yellow('●');
    const timeLabel = rel ? `${date} (${rel})` : date;

    lines.push(
      `${nodeSymbol}  ${c.dim(timeLabel.padEnd(20))}  ${typeStr}  ${changeStr.padEnd(24)}  ${c.cyan(stripControl(ev.commit))}  ${c.dim(stripControl(ev.author))}`
    );
    lines.push(`   ${c.dim('↳ ' + stripControl(ev.message || 'no commit message'))}`);

    if (!isLast) {
      lines.push(c.dim('│'));
    }
  }

  return lines.join('\n');
}
