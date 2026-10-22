/* A bounded dependency DAG viewport. No repository data or network access here. */
(() => {
  'use strict';
  const WIDTH = 264, HEIGHT = 178, GAP_X = 112, GAP_Y = 54;
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

  function layout(nodes, edges) {
    const byId = new Map(nodes.map((n, i) => [n.id, { id: n.id, index: i, rank: 0, incoming: [], outgoing: [] }]));
    const unique = new Map();
    for (const e of edges) if (e.from !== e.to && byId.has(e.from) && byId.has(e.to)) {
      const key = JSON.stringify([e.from, e.to, e.kind]);
      if (!unique.has(key)) unique.set(key, e);
    }
    for (const e of unique.values()) { byId.get(e.from).outgoing.push(e); byId.get(e.to).incoming.push(e); }
    const remaining = new Map([...byId.values()].map(n => [n.id, n.incoming.length]));
    const queue = [...byId.values()].filter(n => !n.incoming.length), visited = new Set();
    for (let i = 0; i < queue.length; i++) {
      const n = queue[i]; visited.add(n.id);
      for (const e of n.outgoing) {
        const to = byId.get(e.to); to.rank = Math.max(to.rank, n.rank + 1);
        remaining.set(to.id, remaining.get(to.id) - 1);
        if (!remaining.get(to.id)) queue.push(to);
      }
    }
    // Malformed cyclic input must not loop or present a fabricated connection.
    const columns = new Map();
    for (const n of byId.values()) {
      if (!visited.has(n.id)) n.rank = 0;
      if (!columns.has(n.rank)) columns.set(n.rank, []);
      columns.get(n.rank).push(n);
    }
    const rows = Math.max(1, ...[...columns.values()].map(c => c.length));
    for (const [rank, column] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
      const center = n => n.incoming.length ? n.incoming.reduce((sum, e) => sum + (byId.get(e.from).y || 0), 0) / n.incoming.length : n.index * (HEIGHT + GAP_Y);
      column.sort((a, b) => center(a) - center(b) || a.index - b.index);
      column.forEach((n, row) => { n.x = 48 + rank * (WIDTH + GAP_X); n.y = 96 + ((rows - column.length) / 2 + row) * (HEIGHT + GAP_Y); });
    }
    const paths = [...unique.values()].filter(e => visited.has(e.from) && visited.has(e.to)).map((e, index) => {
      const a = byId.get(e.from), b = byId.get(e.to), x = a.x + WIDTH, y = a.y + HEIGHT / 2, tx = b.x, ty = b.y + HEIGHT / 2;
      const bend = Math.min(GAP_X / 2, (tx - x) / 2);
      const lane = 20 + (index % 5) * 12;
      const d = b.rank - a.rank > 1
        ? `M${x},${y} C${x + bend},${y} ${x + bend},${lane} ${x + GAP_X / 2},${lane} L${tx - GAP_X / 2},${lane} C${tx - bend},${lane} ${tx - bend},${ty} ${tx},${ty}`
        : `M${x},${y} C${x + bend},${y} ${tx - bend},${ty} ${tx},${ty}`;
      return { ...e, d };
    });
    return { nodes: byId, edges: paths, width: Math.max(WIDTH, ...[...byId.values()].map(n => n.x + WIDTH)) + 48,
      height: 96 + rows * (HEIGHT + GAP_Y), incomplete: visited.size !== nodes.length };
  }
  function zoomAt(view, scale, point) {
    const k = clamp(scale, 0.12, 1.8), ratio = k / view.k;
    return { x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio, k };
  }
  function fit(bounds, width, height) {
    const k = clamp(Math.min((width - 48) / bounds.width, (height - 48) / bounds.height), 0.12, 1);
    return { x: (width - bounds.width * k) / 2, y: (height - bounds.height * k) / 2, k };
  }
  function create(root, data, onSelect) {
    const graph = layout(data.nodes, data.edges), world = root.querySelector('.flow-world');
    const svg = root.querySelector('.flow-connections'), mini = root.querySelector('.flow-minimap');
    const zoomLabel = root.querySelector('[data-flow-zoom]'), listeners = [], points = new Map();
    const elements = new Map([...root.querySelectorAll('[data-flow-node]')].map(el => [el.dataset.flowNode, el]));
    let view = { x: 24, y: 24, k: 1 }, frame = null, selected = '', destroyed = false, moved = false, start = null, initialized = false;
    const ns = 'http://www.w3.org/2000/svg';
    function element(name, attrs, parent) {
      const el = document.createElementNS(ns, name);
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
      parent.appendChild(el); return el;
    }
    svg.replaceChildren(); mini.replaceChildren();
    svg.setAttribute('width', graph.width); svg.setAttribute('height', graph.height);
    const defs = element('defs', {}, svg);
    const marker = element('marker', { id: 'flow-arrow', markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto', markerUnits: 'userSpaceOnUse' }, defs);
    element('path', { d: 'M0 0 L8 4 L0 8 Z', class: 'flow-arrow' }, marker);
    const edgeElements = graph.edges.map(e => ({ ...e, el: element('path', { d: e.d, class: 'flow-edge ' + e.kind, 'marker-end': 'url(#flow-arrow)' }, svg) }));
    for (const [id, el] of elements) {
      const n = graph.nodes.get(id); if (!n) continue;
      el.parentElement.style.transform = `translate(${n.x}px,${n.y}px)`;
    }
    mini.setAttribute('viewBox', `0 0 ${graph.width} ${graph.height}`);
    const miniNodes = new Map();
    for (const n of graph.nodes.values()) miniNodes.set(n.id, element('rect', { x: n.x, y: n.y, width: WIDTH, height: HEIGHT, rx: 18, class: 'flow-mini-node' }, mini));
    const miniView = element('rect', { class: 'flow-mini-viewport' }, mini);
    function paint() {
      frame = null; if (destroyed) return;
      if (!initialized && root.clientWidth && root.clientHeight) {
        initialized = true; view = fit(graph, root.clientWidth, root.clientHeight);
        if (view.k < .8 && data.nodes.length) {
          const first = graph.nodes.get(selected || data.nodes[0].id);
          view.k = .85; view.x = 40 - first.x * view.k;
          view.y = root.clientHeight / 2 - (first.y + HEIGHT / 2) * view.k;
        }
      }
      world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.k})`;
      zoomLabel.textContent = Math.round(view.k * 100) + '%';
      root.style.setProperty('--flow-grid', (24 * view.k) + 'px');
      root.style.backgroundPosition = `${view.x}px ${view.y}px`;
      for (const [key, val] of Object.entries({ x: -view.x / view.k, y: -view.y / view.k, width: root.clientWidth / view.k, height: root.clientHeight / view.k })) miniView.setAttribute(key, val);
    }
    const schedule = () => { if (frame === null && !destroyed) frame = requestAnimationFrame(paint); };
    const center = () => ({ x: root.clientWidth / 2, y: root.clientHeight / 2 });
    function focus(id) {
      const n = graph.nodes.get(id); if (!n) return;
      view.k = Math.max(.75, view.k);
      view.x = root.clientWidth / 2 - (n.x + WIDTH / 2) * view.k;
      view.y = root.clientHeight / 2 - (n.y + HEIGHT / 2) * view.k; schedule();
    }
    function select(id) {
      selected = id;
      const neighbors = new Set([id]);
      for (const e of edgeElements) { const active = e.from === id || e.to === id; e.el.classList.toggle('selected', active); if (active) { neighbors.add(e.from); neighbors.add(e.to); } }
      for (const [key, el] of elements) { el.classList.toggle('flow-muted', !neighbors.has(key)); el.setAttribute('aria-pressed', String(key === id)); }
      for (const [key, el] of miniNodes) el.classList.toggle('selected', key === id);
    }
    function listen(target, name, handler, options) { target.addEventListener(name, handler, options); listeners.push(() => target.removeEventListener(name, handler, options)); }
    function local(event) { const box = root.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; }
    listen(root, 'wheel', e => {
      if (e.target.closest('.flow-controls, .flow-minimap')) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) view = zoomAt(view, view.k * Math.exp(-e.deltaY * .008), local(e));
      else { const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? root.clientHeight : 1; view.x -= e.deltaX * unit; view.y -= e.deltaY * unit; }
      schedule();
    }, { passive: false });
    listen(root, 'pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button, .flow-minimap')) return;
      points.set(e.pointerId, local(e)); start = local(e); moved = false;
      root.setPointerCapture(e.pointerId); root.classList.add('panning'); root.focus({ preventScroll: true });
    });
    listen(root, 'pointermove', e => {
      if (!points.has(e.pointerId)) return;
      const before = [...points.values()], previous = points.get(e.pointerId), point = local(e);
      points.set(e.pointerId, point);
      if (start && Math.hypot(point.x - start.x, point.y - start.y) > 4) moved = true;
      if (points.size === 2) {
        const after = [...points.values()], midpoint = p => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 });
        const distance = p => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        const a = midpoint(before), b = midpoint(after);
        view = zoomAt(view, view.k * distance(after) / Math.max(1, distance(before)), a);
        view.x += b.x - a.x; view.y += b.y - a.y;
      } else { view.x += point.x - previous.x; view.y += point.y - previous.y; }
      schedule();
    });
    const end = e => { points.delete(e.pointerId); if (!points.size) root.classList.remove('panning'); };
    listen(root, 'pointerup', end); listen(root, 'pointercancel', end); listen(root, 'lostpointercapture', end);
    listen(root, 'click', e => {
      if (moved) { moved = false; e.stopPropagation(); return; }
      const control = e.target.closest('[data-flow-control]'); if (!control) return;
      const action = control.dataset.flowControl;
      if (action === 'fit') view = fit(graph, root.clientWidth, root.clientHeight);
      else if (action === 'focus') focus(selected);
      else view = zoomAt(view, view.k * (action === 'in' ? 1.25 : .8), center());
      schedule();
    });
    listen(mini, 'pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      // SVG coordinate conversion accounts for preserveAspectRatio letterboxing.
      const matrix = mini.getScreenCTM(); if (!matrix) return;
      const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
      view.x = root.clientWidth / 2 - point.x * view.k; view.y = root.clientHeight / 2 - point.y * view.k; schedule();
    });
    listen(root, 'keydown', e => {
      if (e.target.closest('.flow-controls')) return;
      const current = e.target.closest('[data-flow-node]');
      if (current && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) {
        const ids = [...elements.keys()], index = ids.indexOf(current.dataset.flowNode);
        const next = ids[e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : clamp(index + (e.key === 'ArrowRight' ? 1 : -1), 0, ids.length - 1)];
        e.preventDefault(); e.stopPropagation(); focus(next); onSelect(next); elements.get(next)?.focus({ preventScroll: true }); return;
      }
      if (e.target !== root) return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        view.x += e.key === 'ArrowLeft' ? 80 : e.key === 'ArrowRight' ? -80 : 0;
        view.y += e.key === 'ArrowUp' ? 80 : e.key === 'ArrowDown' ? -80 : 0;
      } else if (e.key === '+' || e.key === '=') view = zoomAt(view, view.k * 1.25, center());
      else if (e.key === '-') view = zoomAt(view, view.k * .8, center());
      else if (e.key.toLowerCase() === 'f') view = fit(graph, root.clientWidth, root.clientHeight);
      else return;
      e.preventDefault(); e.stopPropagation(); schedule();
    });
    listen(root, 'focusin', e => {
      const node = e.target.closest('[data-flow-node]'); if (!node) return;
      const n = graph.nodes.get(node.dataset.flowNode);
      if (n.x * view.k + view.x < 8 || (n.x + WIDTH) * view.k + view.x > root.clientWidth - 8 ||
        n.y * view.k + view.y < 8 || (n.y + HEIGHT) * view.k + view.y > root.clientHeight - 8) focus(n.id);
    });
    const observer = new ResizeObserver(schedule); observer.observe(root); schedule();
    return { select, focus, refresh: schedule, destroy() { destroyed = true; observer.disconnect(); for (const remove of listeners) remove(); if (frame !== null) cancelAnimationFrame(frame); points.clear(); } };
  }
  globalThis.DepBlameGraph = Object.freeze({ layout, zoomAt, fit, create });
})();
