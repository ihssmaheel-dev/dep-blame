import type { DependencyEvent } from '../types.js';

function cell(value: string | undefined | null): string {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Renders filtered events as CSV (RFC 4180 quoting) for release notes,
 * spreadsheets, and CI artifacts.
 */
export function renderCsv(events: DependencyEvent[]): string {
  const header = ['package', 'type', 'from', 'to', 'date', 'commit', 'commitFull', 'author', 'message', 'manifest', 'depType', 'source'].join(',');
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
      cell(ev.source || 'manifest')
    ].join(',')
  );
  return [header, ...rows].join('\n');
}
