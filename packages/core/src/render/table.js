import { c } from './ansi.js';

/**
 * Formats a date string to YYYY-MM-DD.
 */
function formatDate(isoString) {
  if (!isoString) return '';
  return isoString.split('T')[0] || isoString.slice(0, 10);
}

/**
 * Formats the change string (e.g. "1.0.0 -> 2.0.0").
 */
function formatChange(event) {
  if (event.type === 'added') {
    return event.to || '';
  }
  if (event.type === 'removed') {
    return event.from || '';
  }
  if (event.type === 'updated') {
    return `${event.from || '?'} -> ${event.to || '?'}`;
  }
  return '';
}

/**
 * Formats the event type with color and symbol.
 */
function formatType(type) {
  switch (type) {
    case 'added':
      return c.green('+ added  ');
    case 'updated':
      return c.yellow('↑ updated');
    case 'removed':
      return c.red('- removed');
    default:
      return type.padEnd(9);
  }
}

/**
 * Renders dependency events into a clean, aligned ANSI table string.
 *
 * @param {import('../diff/snapshot-diff.js').DependencyEvent[]} events
 * @returns {string}
 */
export function renderEventTable(events) {
  if (!events || events.length === 0) {
    return c.dim('No dependency change events found.');
  }

  // Calculate maximum column widths
  let maxPkg = 'PACKAGE'.length;
  let maxChange = 'CHANGE'.length;
  let maxAuthor = 'AUTHOR'.length;

  const rows = events.map((ev) => {
    const date = formatDate(ev.date);
    const type = formatType(ev.type);
    const rawType = ev.type;
    const pkg = ev.package;
    const change = formatChange(ev);
    const author = ev.author || '';
    const commit = ev.commit || '';
    const message = ev.message || '';

    if (pkg.length > maxPkg) maxPkg = pkg.length;
    if (change.length > maxChange) maxChange = change.length;
    if (author.length > maxAuthor) maxAuthor = author.length;

    return { date, type, rawType, pkg, change, author, commit, message };
  });

  // Keep max columns within readable bounds
  maxPkg = Math.min(maxPkg, 36);
  maxChange = Math.min(maxChange, 28);
  maxAuthor = Math.min(maxAuthor, 18);

  const header = [
    'DATE'.padEnd(10),
    'TYPE'.padEnd(9),
    'PACKAGE'.padEnd(maxPkg),
    'CHANGE'.padEnd(maxChange),
    'AUTHOR'.padEnd(maxAuthor),
    'COMMIT'.padEnd(7),
    'MESSAGE'
  ].join('  ');

  const divider = c.dim('─'.repeat(header.length + 10));

  const lines = [c.bold(header), divider];

  for (const row of rows) {
    const pkgTruncated = row.pkg.length > maxPkg ? row.pkg.slice(0, maxPkg - 1) + '…' : row.pkg;
    const changeTruncated = row.change.length > maxChange ? row.change.slice(0, maxChange - 1) + '…' : row.change;
    const authorTruncated = row.author.length > maxAuthor ? row.author.slice(0, maxAuthor - 1) + '…' : row.author;

    const line = [
      c.dim(row.date.padEnd(10)),
      row.type,
      c.bold(pkgTruncated.padEnd(maxPkg)),
      changeTruncated.padEnd(maxChange),
      c.dim(authorTruncated.padEnd(maxAuthor)),
      c.cyan(row.commit.padEnd(7)),
      c.dim(row.message)
    ].join('  ');

    lines.push(line);
  }

  lines.push('');
  lines.push(c.dim(`Total events: ${events.length}`));

  return lines.join('\n');
}
