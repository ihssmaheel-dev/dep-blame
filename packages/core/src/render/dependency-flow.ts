import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { DependencyEvent, HeadEntry } from '../types.js';
import { readResolvedDependencyState } from '../engine.js';

export interface FlowNode {
  id: string;
  commit: string;
  date: string;
  author: string;
  message: string;
  kind: 'change' | 'integration' | 'merge-change' | 'unknown';
  changes: DependencyEvent[];
  gaps: string[];
}
export interface FlowEdge {
  from: string;
  to: string;
  kind: 'continuation' | 'integration';
  source: 'manifest' | 'lockfile';
  manifest: string;
  file: string;
  /** Direct incoming parent whose snapshot was checked by the scanner. */
  viaParent?: string;
}
export interface DependencyFlow {
  package: string;
  manifest: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  headState: HeadEntry[];
  headResolved: { file: string; status: 'resolved' | 'absent' | 'unavailable'; versions: string[]; ambiguous?: boolean }[];
  headStateComplete: boolean;
  truncated: boolean;
}
type Demand = { event: DependencyEvent; kind: FlowEdge['kind']; viaParent?: string };
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
/** Older single-map parsers name the lockfile in manifest; scope it to its owning declaration file. */
export function flowManifestForEvent(e: DependencyEvent): string {
  if (e.source === 'lockfile' && !e.lockfile && /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(e.manifest)) {
    return e.manifest.replace(/[^/]+$/, 'package.json');
  }
  return e.manifest;
}
function streamKey(e: DependencyEvent): string {
  return JSON.stringify([e.manifest, e.source, e.lockfile || '']);
}
function state(e: DependencyEvent, before: boolean): string | null {
  if ((before && e.type === 'added') || (!before && e.type === 'removed')) return 'absent';
  const version = before ? e.from : e.to;
  if (!version) return null;
  const versions = before ? e.resolutionsFrom || (e.type === 'removed' ? e.resolutions : undefined) : e.resolutions;
  // Ambiguous representative versions cannot establish continuity alone.
  if (e.ambiguous && !versions?.length) return null;
  return JSON.stringify([version, before ? e.depTypeFrom || e.depType : e.depType,
    [...new Set(versions?.length ? versions : [version])].sort()]);
}

/**
 * Walk children before parents, forwarding requests along the first-parent
 * path. Only the frontier and selected dependency events are retained; the
 * repository DAG and unchanged commits are never materialized. Matching
 * state is necessary in addition to ancestry. An incoming edge requires the
 * scanner's matching-parent snapshot proof, never just equal version strings.
 */
export async function buildDependencyFlow(repoRoot: string, events: DependencyEvent[], options: {
  package: string; manifest: string; head: string; headState?: HeadEntry[];
  headStateComplete?: boolean; truncated?: boolean; signal?: AbortSignal;
}): Promise<DependencyFlow> {
  if (!SHA.test(options.head)) throw new Error('Dependency flow requires a resolved HEAD SHA.');
  const byCommit = new Map<string, FlowNode>();
  const selectedEvents: DependencyEvent[] = [];
  for (const original of events) {
    const manifest = flowManifestForEvent(original);
    if (original.package !== options.package || manifest !== options.manifest) continue;
    const e = manifest !== original.manifest ? { ...original, manifest, lockfile: original.manifest } : original;
    selectedEvents.push(e);
    const id = e.commitFull || e.commit;
    let node = byCommit.get(id);
    if (!node) {
      node = { id, commit: e.commit, date: e.date, author: e.author, message: e.message,
        kind: 'change', changes: [], gaps: [] };
      byCommit.set(id, node);
    }
    node.changes.push(e);
  }
  for (const node of byCommit.values()) {
    const merge = node.changes.some(e => (e.commitParents?.length || 0) > 1);
    const proven = node.changes.every(e => e.changeOrigin === 'merge-integration' && e.flowEvidence?.matchingParents.length);
    const incomplete = node.changes.some(e => !e.flowEvidence || !e.flowEvidence.previousReadable ||
      (merge && !e.flowEvidence.complete && !e.flowEvidence.matchingParents.length));
    node.kind = proven ? 'integration' : incomplete ? 'unknown' : merge ? 'merge-change' : 'change';
    if (incomplete) node.gaps.push('Some snapshot or origin evidence is unavailable. Connections require readable matching states.');
  }
  const pending = new Map<string, Map<string, Demand[]>>();
  function forward(sha: string, key: string, demands: Demand[]) {
    if (!demands.length) return;
    let streams = pending.get(sha);
    if (!streams) { streams = new Map(); pending.set(sha, streams); }
    const existing = streams.get(key);
    if (existing) for (const demand of demands) existing.push(demand);
    else streams.set(key, demands);
  }
  const edges: FlowEdge[] = [], ordered: FlowNode[] = [];
  const child = spawn('git', ['rev-list', '--topo-order', '--parents', options.head, '--'],
    { cwd: repoRoot, windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim() || 'Could not read dependency ancestry.')));
  });
  // Attach rejection handling before consuming stdout (spawn failures can be immediate).
  void done.catch(() => {});
  let stopped = false;
  const abort = () => { stopped = true; child.kill(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timeout = setTimeout(abort, 60_000);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (stopped) throw new Error('Dependency flow request was cancelled or exceeded its time limit.');
      if (line.length > 65536) throw new Error('Git ancestry record exceeds its safety limit.');
      const [sha, ...parents] = line.trim().split(/\s+/);
      if (!SHA.test(sha) || parents.some(p => !SHA.test(p))) throw new Error('Invalid dependency ancestry record.');
      const node = byCommit.get(sha);
      const demands = pending.get(sha);
      pending.delete(sha);
      const streams = node ? new Map(node.changes.map(e => [streamKey(e), e])) : undefined;
      if (demands) for (const [key, list] of demands) {
        const previous = streams?.get(key);
        if (!previous) {
          if (parents[0]) forward(parents[0], key, list);
          continue;
        }
        for (const demand of list) {
          const expected = state(demand.event, demand.kind === 'continuation');
          const actual = state(previous, false);
          if (expected !== null && actual === expected) {
            edges.push({ from: sha, to: demand.event.commitFull!, kind: demand.kind,
              source: demand.event.source, manifest: demand.event.manifest,
              file: demand.event.lockfile || demand.event.manifest,
              ...(demand.viaParent ? { viaParent: demand.viaParent } : {}) });
          } else {
            const target = byCommit.get(demand.event.commitFull!);
            const message = 'Earlier recorded state differs or is incomplete; no continuity arrow is inferred.';
            if (target && !target.gaps.includes(message)) target.gaps.push(message);
          }
        }
      }
      if (!node) continue;
      ordered.push(node);
      for (const event of node.changes) {
        const key = streamKey(event);
        if (parents[0] && event.flowEvidence?.previousReadable) forward(parents[0], key, [{ event, kind: 'continuation' }]);
        for (const parent of event.flowEvidence?.matchingParents || []) {
          if (parents.slice(1).includes(parent)) forward(parent, key, [{ event, kind: 'integration', viaParent: parent }]);
        }
      }
    }
    await done;
    if (stopped) throw new Error('Dependency flow request was cancelled or exceeded its time limit.');
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
    lines.close();
    if (child.exitCode === null) child.kill();
  }
  const seen = new Set(ordered.map(n => n.id));
  for (const node of byCommit.values()) if (!seen.has(node.id)) {
    node.kind = 'unknown'; node.gaps.push('Commit is outside the captured checkout ancestry.'); ordered.push(node);
  }
  ordered.reverse();
  if (options.signal?.aborted) throw new Error('Dependency flow request was cancelled.');
  const lockfiles = [...new Set(selectedEvents.filter(e => e.lockfile).map(e => e.lockfile!))];
  const headResolved = await readResolvedDependencyState(repoRoot, options.head, options.package, options.manifest, lockfiles);
  return { package: options.package, manifest: options.manifest, nodes: ordered, edges,
    headResolved,
    headState: (options.headState || []).filter(e => e.package === options.package && e.manifest === options.manifest),
    headStateComplete: options.headStateComplete !== false, truncated: Boolean(options.truncated) };
}

/** A bounded window; references outside it stay explicit and navigable. */
export function pageDependencyFlow(flow: DependencyFlow, offset = 0, limit = 50) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid dependency flow window.');
  const start = Math.max(0, Math.min(flow.nodes.length, Math.trunc(offset)));
  const size = Math.max(1, Math.min(100, Math.trunc(limit)));
  const nodes = flow.nodes.slice(start, start + size), ids = new Set(nodes.map(n => n.id));
  const related = new Set<string>();
  const edges = flow.edges.filter(e => {
    const include = ids.has(e.to) || ids.has(e.from);
    if (include && !ids.has(e.from)) related.add(e.from);
    if (include && !ids.has(e.to)) related.add(e.to);
    return include;
  });
  const references = flow.nodes.flatMap((n, index) => related.has(n.id) ? [{ id: n.id, commit: n.commit, offset: Math.floor(index / size) * size }] : []);
  return { ...flow, nodes, edges, references, total: flow.nodes.length, offset: start, limit: size,
    nextOffset: start + size < flow.nodes.length ? start + size : null };
}
