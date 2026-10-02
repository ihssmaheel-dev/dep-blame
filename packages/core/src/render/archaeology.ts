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
 * One distinct change within a lifecycle node: same type/version/section,
 * possibly across several manifests in the same commit.
 */
export interface LifecycleChange {
  type: 'added' | 'updated' | 'removed';
  from?: string;
  to?: string;
  depType?: string;
  depTypeFrom?: string;
  manifests: string[];
}

/**
 * One commit's worth of lifecycle for a package. A single real-world change
 * (e.g. "@types/node added everywhere") otherwise fans out into one event
 * per manifest plus one per lockfile — this node folds that back into a
 * single readable unit without dropping any evidence.
 */
export interface LifecycleNode {
  commit: string;
  commitFull?: string;
  date: string;
  author: string;
  message: string;
  /** Distinct manifests touched, first-seen order. */
  manifests: string[];
  /** Declared (`package.json`) changes, grouped by type/version/section. */
  declared: LifecycleChange[];
  /** Resolved (lockfile) changes, grouped the same way. */
  resolved: LifecycleChange[];
  /** Single distinct type, or 'mixed' when one commit both adds and removes. */
  headline: 'added' | 'updated' | 'removed' | 'mixed';
}

/**
 * Groups a package's events into per-commit lifecycle nodes (chronological).
 * Grouping is render-only: the engine keeps every raw event, so `--json`
 * and `--csv` stay complete.
 */
export function groupLifecycleNodes(
  pkgEvents: DependencyEvent[]
): LifecycleNode[] {
  const nodes: LifecycleNode[] = [];
  const byCommit = new Map<string, LifecycleNode>();
  for (const ev of pkgEvents) {
    const key = ev.commitFull || ev.commit;
    let node = byCommit.get(key);
    if (!node) {
      node = {
        commit: ev.commit,
        commitFull: ev.commitFull,
        date: ev.date,
        author: ev.author,
        message: ev.message,
        manifests: [],
        declared: [],
        resolved: [],
        headline: ev.type,
      };
      byCommit.set(key, node);
      nodes.push(node);
    }
    if (ev.manifest && !node.manifests.includes(ev.manifest)) {
      node.manifests.push(ev.manifest);
    }
    const list = ev.source === 'lockfile' ? node.resolved : node.declared;
    const existing = list.find(
      (ch) =>
        ch.type === ev.type &&
        (ch.from || '') === (ev.from || '') &&
        (ch.to || '') === (ev.to || '') &&
        (ch.depType || '') === (ev.depType || '') &&
        (ch.depTypeFrom || '') === (ev.depTypeFrom || '')
    );
    if (existing) {
      if (ev.manifest && !existing.manifests.includes(ev.manifest)) {
        existing.manifests.push(ev.manifest);
      }
    } else {
      list.push({
        type: ev.type,
        from: ev.from,
        to: ev.to,
        depType: ev.depType,
        depTypeFrom: ev.depTypeFrom,
        manifests: ev.manifest ? [ev.manifest] : [],
      });
    }
  }
  for (const node of nodes) {
    const types = new Set<string>();
    for (const ch of [...node.declared, ...node.resolved]) types.add(ch.type);
    node.headline = types.size === 1 ? ([...types][0] as LifecycleNode['headline']) : 'mixed';
  }
  return nodes;
}

/**
 * Renders the package archaeology lifecycle view.
 *
 * When `headState` (HEAD-declared dependencies from the engine) is given,
 * per-manifest status comes from HEAD reality — not from the last
 * chronological event, which may live on an unmerged branch.
 *
 * The timeline shows one node per commit: same-commit manifest + lockfile
 * evidence is folded into declared/resolved lines, so a dependency added
 * in ten workspaces reads as one lifecycle step, not twenty rows.
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

  const nodes = groupLifecycleNodes(pkgEvents);

  const lines = [
    c.bold('Archaeology for ') + c.bold(c.cyan(safeName)),
    `Status: ${statusBanner}`,
    `Total modifications: ${c.bold(pkgEvents.length)} events across ${c.bold(nodes.length)} commits`,
    '',
    c.dim('Timeline (chronological order, one node per commit):'),
    c.dim('──────────────────────────────────────────────────────────────────')
  ];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const date = formatDate(node.date);
    const rel = formatRelativeTime(node.date);

    let typeStr = '';
    if (node.headline === 'added') typeStr = c.green('+ added  ');
    else if (node.headline === 'updated') typeStr = c.yellow('↑ updated');
    else if (node.headline === 'removed') typeStr = c.red('- removed');
    else typeStr = c.yellow('± mixed  ');

    const nodeSymbol =
      node.headline === 'added' ? c.green('●') : node.headline === 'removed' ? c.red('●') : c.yellow('●');
    const timeLabel = rel ? `${date} (${rel})` : date;

    lines.push(
      `${nodeSymbol}  ${c.dim(timeLabel.padEnd(20))}  ${typeStr}  ${c.cyan(stripControl(node.commit))}  ${c.dim(stripControl(node.author))}`
    );
    for (const [label, changes] of [['declared', node.declared], ['resolved', node.resolved]] as const) {
      for (const ch of changes) {
        lines.push(`   ${c.dim(label)} ${formatLifecycleChange(ch)}`);
      }
    }
    lines.push(`   ${c.dim('↳ ' + stripControl(node.message || 'no commit message'))}`);

    if (!isLast) {
      lines.push(c.dim('│'));
    }
  }

  return lines.join('\n');
}

function formatManifestList(manifests: string[]): string {
  const shown = manifests.slice(0, 3).map((m) => stripControl(m));
  const extra = manifests.length - shown.length;
  return `[${shown.join(', ')}${extra > 0 ? ` +${extra} more` : ''}]`;
}

function formatLifecycleChange(ch: LifecycleChange): string {
  let changeStr = '';
  if (ch.type === 'added') {
    changeStr = `+added ${c.bold(stripControl(ch.to || ''))}`;
  } else if (ch.type === 'updated') {
    const move =
      ch.depTypeFrom && ch.depTypeFrom !== ch.depType ? c.dim(` [${ch.depTypeFrom} → ${ch.depType}]`) : '';
    changeStr = `${stripControl(ch.from || '?')} -> ${c.bold(stripControl(ch.to || '?'))}${move}`;
  } else if (ch.type === 'removed') {
    changeStr = `-removed ${c.dim(`was ${stripControl(ch.from || 'installed')}`)}`;
  }
  const section =
    ch.depType && ch.depType !== 'dependencies' ? c.dim(` (${stripControl(ch.depType)})`) : '';
  return `${changeStr}${section} ${c.dim(formatManifestList(ch.manifests))}`;
}
