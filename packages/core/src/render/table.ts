import { c, stripControl } from './ansi.js';
import type { DependencyEvent } from '../types.js';
import { describeUpdate } from './change.js';

function formatDate(isoString?: string): string {
  if (!isoString) return '';
  return isoString.split('T')[0] || isoString.slice(0, 10);
}

function formatChange(event: DependencyEvent): string {
  if (event.type === 'added') {
    return stripControl(event.to || '');
  }
  if (event.type === 'removed') {
    return stripControl(event.from || '');
  }
  if (event.type === 'updated') {
    if (event.from === undefined && event.to === undefined) return 'lockfile changed';
    if (event.resolutionsFrom) return 'resolved versions changed';
    if (event.from === event.to) return event.depTypeFrom ? 'section moved' : 'metadata changed';
    return `${stripControl(event.from || '?')} -> ${stripControl(event.to || '?')}`;
  }
  return '';
}

function formatSource(event: DependencyEvent): string {
  return event.source === 'lockfile' ? c.dim('[lock]') : c.dim('[decl]');
}

function formatType(type: string): string {
  switch (type) {
    case 'added':
      return c.green('+ added  ');
    case 'updated':
      return c.yellow('↑ updated');
    case 'removed':
      return c.red('- removed');
    default:
      return stripControl(type).padEnd(9);
  }
}

export interface RenderTableOptions {
  verbose?: boolean;
  collapseThreshold?: number;
}

/**
 * Renders dependency events into a clean, aligned ANSI table string.
 */
export function renderEventTable(
  events: DependencyEvent[],
  options: RenderTableOptions = {}
): string {
  const { verbose = false, collapseThreshold = 5 } = options;

  if (!events || events.length === 0) {
    return c.dim('No dependency change events found.');
  }

  let maxPkg = 'PACKAGE'.length;
  let maxChange = 'CHANGE'.length;
  let maxAuthor = 'AUTHOR'.length;

  for (const ev of events) {
    const pkg = ev.package || '';
    const change = formatChange(ev);
    const author = ev.author || '';

    if (pkg.length > maxPkg) maxPkg = pkg.length;
    if (change.length > maxChange) maxChange = change.length;
    if (author.length > maxAuthor) maxAuthor = author.length;
  }

  maxPkg = Math.min(maxPkg, 36);
  maxChange = Math.min(maxChange, 28);
  maxAuthor = Math.min(maxAuthor, 18);

  const header = [
    'DATE'.padEnd(10),
    'TYPE'.padEnd(9),
    'SRC'.padEnd(6),
    'PACKAGE'.padEnd(maxPkg),
    'CHANGE'.padEnd(maxChange),
    'AUTHOR'.padEnd(maxAuthor),
    'COMMIT'.padEnd(7),
    'MESSAGE'
  ].join('  ');

  const divider = c.dim('─'.repeat(header.length + 10));
  const lines: string[] = [c.bold(header), divider];

  // Group by commit for collapsing bulk updates
  const commitGroups: DependencyEvent[][] = [];
  let currentGroup: DependencyEvent[] = [];
  let currentCommit: string | null = null;

  for (const ev of events) {
    const identity = ev.commitFull || ev.commit;
    if (identity !== currentCommit) {
      if (currentGroup.length > 0) {
        commitGroups.push(currentGroup);
      }
      currentGroup = [ev];
      currentCommit = identity;
    } else {
      currentGroup.push(ev);
    }
  }
  if (currentGroup.length > 0) {
    commitGroups.push(currentGroup);
  }

  const renderSingleRow = (ev: DependencyEvent): string => {
    const date = formatDate(ev.date);
    const type = formatType(ev.type);
    const source = formatSource(ev);
    const pkg = stripControl(ev.package);
    const change = formatChange(ev);
    const author = stripControl(ev.author || '');
    const commit = stripControl(ev.commit || '');
    const message = stripControl(ev.message || '');

    const pkgTruncated = pkg.length > maxPkg ? pkg.slice(0, maxPkg - 1) + '…' : pkg;
    const changeTruncated = change.length > maxChange ? change.slice(0, maxChange - 1) + '…' : change;
    const authorTruncated = author.length > maxAuthor ? author.slice(0, maxAuthor - 1) + '…' : author;

    return [
      c.dim(date.padEnd(10)),
      type,
      source,
      c.bold(pkgTruncated.padEnd(maxPkg)),
      changeTruncated.padEnd(maxChange),
      c.dim(authorTruncated.padEnd(maxAuthor)),
      c.cyan(commit.padEnd(7)),
      c.dim(message)
    ].join('  ');
  };

  for (const group of commitGroups) {
    if (!verbose && group.length >= collapseThreshold) {
      const first = group[0];
      const date = formatDate(first.date);
      const commit = stripControl(first.commit);
      const count = group.length;
      const added = group.filter((e) => e.type === 'added').length;
      const updated = group.filter((e) => e.type === 'updated').length;
      const removed = group.filter((e) => e.type === 'removed').length;
      const parts: string[] = [];
      if (added > 0) parts.push(`${added} added`);
      if (updated > 0) parts.push(`${updated} updated`);
      if (removed > 0) parts.push(`${removed} removed`);
      const distinctManifests = new Set(group.map((e) => e.manifest)).size;
      const summaryMsg = `${count} changes (${parts.join(', ')}) across ${distinctManifests} manifest(s) [use --verbose to expand]`;

      const collapsedLine = [
        c.dim(date.padEnd(10)),
        c.yellow('⚡ collapsed'),
        c.dim('[group] '.padEnd(6)),
        c.bold(summaryMsg.padEnd(maxPkg + maxChange + 2)),
        c.dim(stripControl(first.author || '').slice(0, maxAuthor).padEnd(maxAuthor)),
        c.cyan(commit.padEnd(7)),
        c.dim(stripControl(first.message || ''))
      ].join('  ');

      lines.push(collapsedLine);
    } else {
      for (const ev of group) {
        lines.push(renderSingleRow(ev));
        if (ev.type === 'updated' && (ev.depTypeFrom || ev.resolutionsFrom || ev.from === ev.to)) {
          lines.push(c.dim('  ↳ ' + stripControl(describeUpdate(ev))));
        }
      }
    }
  }

  lines.push('');
  lines.push(c.dim(`Total events: ${events.length}`));

  return lines.join('\n');
}
