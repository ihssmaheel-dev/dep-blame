import type { DependencyEvent } from '../types.js';

function cell(value: string | undefined | null): string {
  let s = value === undefined || value === null ? '' : String(value);
  // Repository-controlled author/message fields must stay text in spreadsheet apps.
  if (/^[\s]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Renders filtered events as CSV (RFC 4180 quoting) for release notes,
 * spreadsheets, and CI artifacts.
 */
export function renderCsv(events: DependencyEvent[]): string {
  const header = ['package', 'type', 'from', 'to', 'date', 'commit', 'commitFull', 'author', 'message', 'manifest', 'depType', 'source', 'lockfile', 'depTypeFrom', 'isDirect', 'resolutions', 'ambiguous', 'changeOrigin', 'commitParents', 'resolutionsFrom'].join(',');
  const rows = (events || []).map((ev) =>
    [
      cell(ev.package),
      cell(ev.type),
      cell(ev.from),
      cell(ev.to),
      cell(ev.date),
      cell(ev.commit),
      cell(ev.commitFull),
      cell(ev.author),
      cell(ev.message),
      cell(ev.manifest),
      cell(ev.depType),
      cell(ev.source || 'manifest'),
      cell(ev.lockfile),
      cell(ev.depTypeFrom),
      cell(ev.isDirect === undefined ? '' : String(ev.isDirect)),
      cell(ev.resolutions ? ev.resolutions.join(' | ') : ''),
      cell(ev.ambiguous ? 'true' : ''),
      cell(ev.changeOrigin),
      cell(ev.commitParents?.join(' ')),
      cell(ev.resolutionsFrom?.join(' | '))
    ].join(',')
  );
  return [header, ...rows].join('\n');
}
