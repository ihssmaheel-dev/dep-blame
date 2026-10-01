  let allEvents = [];
  let currentFilter = 'all';
  let currentSearch = '';
  let currentManifest = 'all';
  let currentView = 'timeline';
  let sortField = 'date';
  let sortAsc = false;
  let selectedPkgName = null;
  let currentPage = 1;
  let pageSize = 100;
  const PAGE_SIZES = [25, 50, 100];
  let searchTimer = null;
  let colFilterTimer = null;
  // Per-column datatable filters. Sets (packages/changes/authors) and the
  // date range are empty/off when inactive; selects use 'all'.
  let colFilters = freshColFilters();
  function freshColFilters() {
    return { dateFrom: '', dateTo: '', datePreset: '', action: 'all', packages: [], changes: [], type: 'all', manifest: '', authors: [], commit: '' };
  }

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  let repoOwner = null;
  let repoHost = 'github.com';
  let remoteUrl = null;
  let currentBranch = 'main';
  let currentRepo = '';
  let currentPm = 'npm';
  let workspacePackages = {};
  let authorsMap = {};
  let headStateData = [];

  // Theme Management (Dark Theme Default)
  function initTheme() {
    const savedTheme = localStorage.getItem('dep-blame-theme') || 'dark';
    setTheme(savedTheme);

    document.getElementById('theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    setTheme(next);
    });
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('dep-blame-theme', theme);
    const darkIcon = document.getElementById('theme-icon-dark');
    const lightIcon = document.getElementById('theme-icon-light');
    if (theme === 'dark') {
    darkIcon.style.display = 'block';
    lightIcon.style.display = 'none';
    } else {
    darkIcon.style.display = 'none';
    lightIcon.style.display = 'block';
    }
  }

  // Resolves author information. Fully offline: no remote avatar fetches
  // (initials are rendered instead) and no email exposure.
  function getAuthorDetails(author) {
    if (!author || author === 'Unknown') {
    return {
      name: 'Unknown',
      username: 'unknown',
      profileUrl: '#'
    };
    }

    if (authorsMap && authorsMap[author]) {
    const a = authorsMap[author];
    return { name: a.name || author, username: a.username || 'author', profileUrl: a.profileUrl || '#' };
    }

    const clean = author.trim().replace(/^@/, '');
    let username = '';
    if (/^[a-zA-Z0-9_\-]+$/.test(clean)) {
    username = clean;
    } else if (repoOwner) {
    username = repoOwner;
    } else {
    username = clean.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    }

    const cleanHost = repoHost || 'github.com';
    const profileUrl = username ? `https://${cleanHost}/${encodeURIComponent(username)}` : '#';

    return {
    name: author,
    username: username || 'author',
    profileUrl
    };
  }

  // Backward-compatibility wrapper
  function getAuthorProfileUrl(author) {
    return getAuthorDetails(author).profileUrl;
  }

  function renderScanningState() {
    const tbody = document.getElementById('events-tbody');
    if (!tbody) return;
    tbody.innerHTML = `
    <tr>
      <td colspan="8" style="padding: 0; border: none;">
      <div class="scan-progress-container" id="scan-progress-box" role="status" aria-live="polite" aria-label="Repository scan progress">
        <div class="scan-spinner-wrap">
        <div class="scan-spinner-glow"></div>
        <div class="scan-spinner-ring"></div>
        <svg class="scan-spinner-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
        </svg>
        </div>
        <div class="scan-badge">
        <span class="scan-badge-dot"></span>
        <span id="scan-stage-badge">Connecting</span>
        </div>
        <div class="scan-title" id="scan-title-text">Connecting to analysis stream...</div>
        <div class="scan-steps" id="scan-steps" aria-hidden="true">
          <span class="scan-step" data-phase="initializing"><span class="dot"></span>Init</span>
          <span class="scan-step" data-phase="discovering"><span class="dot"></span>Manifests</span>
          <span class="scan-step" data-phase="reading_commits"><span class="dot"></span>Commits</span>
          <span class="scan-step" data-phase="analyzing"><span class="dot"></span>Analyzing</span>
          <span class="scan-step" data-phase="saving"><span class="dot"></span>Saving</span>
          <span class="scan-step" data-phase="complete"><span class="dot"></span>Ready</span>
        </div>
        <div class="scan-bar-track" id="scan-bar-track">
        <div class="scan-bar-fill" id="scan-bar-fill" style="width: 4%;"></div>
        </div>
        <div class="scan-stats-row">
        <span id="scan-commits-count">Connecting to analysis stream...</span>
        <span id="scan-percent-label" style="font-weight: 700; color: var(--color-text);">…</span>
        </div>
        <div class="scan-detail-ticker" id="scan-detail-ticker"></div>
      </div>
      </td>
    </tr>
    `;
  }

  // Exact pipeline stages in order. Percent is derived from the real
  // phase position; the analyzing phase interpolates commit progress.
  // When a total is unknown the bar switches to indeterminate shimmer.
  const SCAN_PHASES = ['initializing', 'discovering', 'reading_commits', 'analyzing', 'saving', 'complete'];
  const SCAN_PHASE_LABEL = {
    initializing: 'Initializing',
    discovering: 'Manifests',
    reading_commits: 'Commits',
    analyzing: 'Analyzing',
    saving: 'Saving',
    complete: 'Ready'
  };
  const SCAN_PHASE_BASE_PCT = {
    initializing: 4,
    discovering: 18,
    reading_commits: 34,
    analyzing: 46,
    saving: 97,
    complete: 100
  };

  function updateScanProgress(p) {
    if (!p) return;
    const badge = document.getElementById('scan-stage-badge');
    const title = document.getElementById('scan-title-text');
    const track = document.getElementById('scan-bar-track');
    const bar = document.getElementById('scan-bar-fill');
    const count = document.getElementById('scan-commits-count');
    const pctLabel = document.getElementById('scan-percent-label');
    const ticker = document.getElementById('scan-detail-ticker');
    const indexTime = document.getElementById('index-time');

    const phase = SCAN_PHASES.includes(p.phase) ? p.phase : 'initializing';
    const stageName = SCAN_PHASE_LABEL[phase];
    let pct = SCAN_PHASE_BASE_PCT[phase];
    let determinate = true;

    if (phase === 'analyzing') {
      if (p.total > 0) {
        pct = Math.min(95, Math.max(46, Math.round(46 + (p.current / p.total) * 49)));
      } else {
        determinate = false;
      }
    }

    const steps = document.querySelectorAll('#scan-steps .scan-step');
    const activeIdx = SCAN_PHASES.indexOf(phase);
    steps.forEach((el, i) => {
      el.classList.toggle('done', i < activeIdx);
      el.classList.toggle('active', i === activeIdx);
    });

    if (badge) badge.textContent = stageName;
    if (title) title.textContent = p.message || `${stageName}…`;
    if (track) track.classList.toggle('indeterminate', !determinate);
    if (bar && determinate) bar.style.width = pct + '%';
    if (pctLabel) pctLabel.textContent = determinate ? pct + '%' : '…';
    if (count) {
    if (phase === 'analyzing' && p.total > 0) {
      count.textContent = `Commit ${p.current} of ${p.total}`;
    } else if (phase === 'analyzing') {
      count.textContent = p.current > 0 ? `Commit ${p.current}…` : 'Analyzing commits…';
    } else {
      count.textContent = p.message || 'Scanning...';
    }
    }
    if (ticker) ticker.textContent = p.detail || '';
    if (indexTime) indexTime.textContent = determinate ? `Scanning ${pct}% · ${stageName}` : `Scanning · ${stageName}…`;
  }

  function applyLoadedData(data) {
    allEvents = data.events || [];
    repoOwner = data.repoOwner || null;
    repoHost = data.repoHost || 'github.com';
    remoteUrl = data.remoteUrl || null;
    currentBranch = data.branch || 'main';
    currentRepo = data.repository || '';
    currentPm = data.packageManager || 'npm';
    workspacePackages = data.workspacePackages || {};
    authorsMap = data.authors || {};
    headStateData = Array.isArray(data.headState) ? data.headState : [];

    document.getElementById('repo-name').textContent = data.repository || 'repository';
    document.getElementById('branch-name').textContent = data.branch || 'main';
    document.getElementById('pm-pill').textContent = data.packageManager || 'npm';
    document.getElementById('index-time').textContent = 'Indexed ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    populateManifestDropdown();
    populateManifestDatalist();
    updateStats();
    renderView();
  }

  // Only one analysis stream at a time: a refresh during a scan joins
  // the in-flight server scan instead of stacking another one.
  let activeStream = null;
  let streamAttempts = 0;

  function closeActiveStream() {
    if (activeStream) {
      try { activeStream.close(); } catch {}
      activeStream = null;
    }
  }

  async function loadData() {
    const syncIcon = document.getElementById('sync-icon');
    if (syncIcon) syncIcon.style.animation = 'spin 1s linear infinite';
    renderScanningState();
    closeActiveStream();

    if (typeof window.EventSource !== 'undefined' && streamAttempts < 2) {
    try {
      await openAnalysisStream();
      streamAttempts = 0;
      return;
    } catch (err) {
      streamAttempts++;
      // Fall through to plain fetch on the last attempt.
      if (streamAttempts < 2) {
        return loadData();
      }
      // Final fallback below.
    } finally {
      if (syncIcon) syncIcon.style.animation = '';
    }
    }
    streamAttempts = 0;

    try {
    const res = await fetch('/api/events');
    const data = await res.json();
    applyLoadedData(data);
    } catch (err) {
    document.getElementById('events-tbody').innerHTML = `
      <tr><td colspan="8" class="empty-state" style="color: var(--color-removed)">
      Failed to fetch dependency events from /api/events.
      </td></tr>
    `;
    } finally {
    if (syncIcon) syncIcon.style.animation = '';
    }
  }

  // Opens the SSE stream with a stall watchdog: if the server accepts
  // the connection but yields no progress (e.g. it is still acquiring
  // the scan lock), the ticker says so instead of hanging silently.
  function openAnalysisStream() {
    return new Promise((resolve, reject) => {
    const es = new EventSource('/api/events/stream');
    activeStream = es;
    let settled = false;
    let gotProgress = false;

    const stallTimer = setTimeout(() => {
      if (settled || gotProgress) return;
      const ticker = document.getElementById('scan-detail-ticker');
      if (ticker) ticker.textContent = 'Still connecting — server may be finishing another scan…';
    }, 6000);

    const done = (fn) => (arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      if (activeStream === es) activeStream = null;
      try { es.close(); } catch {}
      fn(arg);
    };

    es.addEventListener('progress', (e) => {
      gotProgress = true;
      try {
      updateScanProgress(JSON.parse(e.data));
      } catch {}
    });

    es.addEventListener('complete', done((e) => {
      try {
      applyLoadedData(JSON.parse(e.data));
      resolve();
      } catch (err) {
      reject(err);
      }
    }));

    es.addEventListener('error', done((err) => {
      reject(err instanceof Error ? err : new Error('Stream failed'));
    }));
    });
  }

  // Custom Dropdown Populator (No native select)
  function populateManifestDropdown() {
    const manifests = Array.from(new Set(allEvents.map(e => e.manifest).filter(Boolean))).sort();
    const menu = document.getElementById('manifest-dropdown-menu');
    
    let html = `<div class="dropdown-item ${currentManifest === 'all' ? 'selected' : ''}" role="option" tabindex="0" data-value="all">All Manifests (${manifests.length})</div>`;
    for (const m of manifests) {
    html += `<div class="dropdown-item ${currentManifest === m ? 'selected' : ''}" role="option" tabindex="0" data-value="${escapeHtml(m)}">${escapeHtml(m)}</div>`;
    }
    menu.innerHTML = html;

    menu.querySelectorAll('.dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      currentManifest = item.dataset.value;
      currentPage = 1;
      document.getElementById('manifest-selected-label').textContent = currentManifest === 'all' ? 'All Manifests' : currentManifest;
      menu.querySelectorAll('.dropdown-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
      document.getElementById('manifest-dropdown').classList.remove('open');
      renderView();
    });
    });
  }

  // Dropdown toggle & click outside
  const manifestDropdown = document.getElementById('manifest-dropdown');
  document.getElementById('manifest-dropdown-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    manifestDropdown.classList.toggle('open');
  });
  window.addEventListener('click', (e) => {
    if (!manifestDropdown.contains(e.target)) {
    manifestDropdown.classList.remove('open');
    }
  });

  function updateStats() {
    const added = allEvents.filter(e => e.type === 'added').length;
    const updated = allEvents.filter(e => e.type === 'updated').length;
    const removed = allEvents.filter(e => e.type === 'removed').length;
    const distinct = new Set(allEvents.map(e => e.package)).size;

    document.getElementById('kpi-total').textContent = allEvents.length.toLocaleString();
    document.getElementById('kpi-distinct').textContent = `Across ${distinct} distinct packages`;
    document.getElementById('kpi-added').textContent = added.toLocaleString();
    document.getElementById('kpi-updated').textContent = updated.toLocaleString();
    document.getElementById('kpi-removed').textContent = removed.toLocaleString();

    document.getElementById('count-all').textContent = allEvents.length;
    document.getElementById('count-added').textContent = added;
    document.getElementById('count-updated').textContent = updated;
    document.getElementById('count-removed').textContent = removed;
  }

  function setFilter(type) {
    if (currentFilter === type) return;
    currentFilter = type;
    currentPage = 1;
    document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === type);
    });
    renderView();
  }

  function getFilteredEvents() {
    return allEvents.filter(ev => {
    if (currentFilter !== 'all' && ev.type !== currentFilter) return false;
    if (currentManifest !== 'all' && ev.manifest !== currentManifest) return false;
    if (!matchesColFilters(ev)) return false;
    if (currentSearch) {
      const q = currentSearch.toLowerCase();
      const matchDate = (ev.date || '').toLowerCase().includes(q);
      const matchPkg = (ev.package || '').toLowerCase().includes(q);
      const matchAuthor = (ev.author || '').toLowerCase().includes(q);
      const authorInfo = getAuthorDetails(ev.author);
      const matchUsername = (authorInfo && authorInfo.username ? authorInfo.username.toLowerCase().includes(q) : false);
      const matchSha = (ev.commit || '').toLowerCase().includes(q);
      const matchMsg = (ev.message || '').toLowerCase().includes(q);
      const matchManifest = (ev.manifest || '').toLowerCase().includes(q);
      const matchTo = (ev.to || '').toLowerCase().includes(q);
      const matchFrom = (ev.from || '').toLowerCase().includes(q);
      const matchDepType = (ev.depType || '').toLowerCase().includes(q);
      if (!matchDate && !matchPkg && !matchAuthor && !matchUsername && !matchSha && !matchMsg && !matchManifest && !matchTo && !matchFrom && !matchDepType) return false;
    }
    return true;
    });
  }

  // Per-column datatable filters. Sets (packages/changes/authors) and the
  // date range are empty/off when inactive; selects match exactly.
  // Returns true when the event passes all set columns.
  function eventDateKey(ev) {
    return (ev.date || '').slice(0, 10);
  }

  function changeKeyOf(ev) {
    if (ev.type === 'added') return `+ ${ev.to || ''}`;
    if (ev.type === 'removed') return `− ${ev.from || ''}`;
    return `${ev.from || '?'} → ${ev.to || '?'}`;
  }

  function changeTextOf(ev) {
    if (ev.type === 'added') return ev.to || '';
    if (ev.type === 'removed') return ev.from || '';
    return `${ev.from || ''} ${ev.to || ''}`;
  }

  function typeTagOf(ev) {
    if (ev.source === 'lockfile') return 'resolved';
    if (ev.isDirect === false || ev.is_direct === false) return 'dep';
    return 'direct';
  }

  function matchesColFilters(ev) {
    const f = colFilters;
    if ((f.dateFrom || f.dateTo)) {
      const d = eventDateKey(ev);
      if (!d) return false;
      if (f.dateFrom && d < f.dateFrom) return false;
      if (f.dateTo && d > f.dateTo) return false;
    }
    if (f.action !== 'all' && ev.type !== f.action) return false;
    if (f.packages.length > 0 && !f.packages.includes(ev.package || '')) return false;
    if (f.changes.length > 0 && !f.changes.includes(changeKeyOf(ev))) return false;
    if (f.type !== 'all' && typeTagOf(ev) !== f.type) return false;
    if (f.manifest && !(ev.manifest || '').toLowerCase().includes(f.manifest)) return false;
    if (f.authors.length > 0 && !f.authors.includes(ev.author || '')) return false;
    if (f.commit && !`${ev.commit || ''} ${ev.commitFull || ''}`.toLowerCase().includes(f.commit)) return false;
    return true;
  }

  function authorUsername(author) {
    try {
      const info = getAuthorDetails(author);
      return (info && info.username) || '';
    } catch {
      return '';
    }
  }

  function setColFilter(col, value) {
    colFilters[col] = value;
    currentPage = 1;
    renderView();
  }

  function clearColFilters() {
    colFilters = freshColFilters();
    document.querySelectorAll('.col-filter').forEach(el => {
      el.value = el.tagName === 'SELECT' ? 'all' : '';
      el.classList.remove('active-filter');
    });
    refreshColFilterState();
    currentPage = 1;
  }

  function colFiltersActive() {
    const f = colFilters;
    return !!(f.dateFrom || f.dateTo || f.action !== 'all' || f.packages.length > 0 ||
      f.changes.length > 0 || f.type !== 'all' || f.manifest || f.authors.length > 0 || f.commit);
  }

  function shortDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d.getTime()) ? iso : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function refreshColFilterState() {
    const f = colFilters;
    const clearBtn = document.getElementById('col-filter-clear');
    if (clearBtn) clearBtn.style.display = colFiltersActive() ? 'inline-block' : 'none';
    document.querySelectorAll('.col-filter').forEach(el => {
      const col = el.dataset.col;
      const v = colFilters[col];
      el.classList.toggle('active-filter', col === 'action' || col === 'type' ? v !== 'all' : v !== '');
    });
    const labels = {
      date: f.dateFrom || f.dateTo
        ? (f.datePreset && !f.datePreset.startsWith('custom')
          ? f.datePreset
          : `${shortDate(f.dateFrom) || '…'} – ${shortDate(f.dateTo) || '…'}`)
        : 'All dates',
      package: f.packages.length === 0 ? 'All packages' : `${f.packages.length} selected`,
      change: f.changes.length === 0 ? 'All versions' : `${f.changes.length} selected`,
      author: f.authors.length === 0 ? 'All authors' : `${f.authors.length} selected`
    };
    document.querySelectorAll('[data-col-label]').forEach(el => {
      const col = el.dataset.colLabel;
      if (labels[col] !== undefined) el.textContent = labels[col];
      const btn = el.closest('.col-filter-btn');
      if (btn) btn.classList.toggle('active-filter', colFiltersActiveFor(col));
    });
  }

  function colFiltersActiveFor(col) {
    const f = colFilters;
    if (col === 'date') return !!(f.dateFrom || f.dateTo);
    if (col === 'package') return f.packages.length > 0;
    if (col === 'change') return f.changes.length > 0;
    if (col === 'author') return f.authors.length > 0;
    return false;
  }

  // Rich floating panels for date + multi-select columns. One shared
  // container positioned under the trigger button; closes on outside
  // click, Escape, scroll, or resize. Selections apply explicitly.
  let openPanelKind = null;

  function closeFilterPanel() {
    const panel = document.getElementById('filter-panel');
    if (panel) panel.hidden = true;
    openPanelKind = null;
  }

  function isoDay(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function datePresets() {
    const now = new Date();
    const today = isoDay(now);
    const yesterday = isoDay(new Date(now.getTime() - 86400000));
    const last7 = isoDay(new Date(now.getTime() - 6 * 86400000));
    const last30 = isoDay(new Date(now.getTime() - 29 * 86400000));
    const firstOfMonth = `${today.slice(0, 7)}-01`;
    return [
      { name: 'Today', from: today, to: today },
      { name: 'Yesterday', from: yesterday, to: yesterday },
      { name: 'Last 7 days', from: last7, to: today },
      { name: 'Last 30 days', from: last30, to: today },
      { name: 'This month', from: firstOfMonth, to: today }
    ];
  }

  function facetValues(kind) {
    const counts = new Map();
    for (const ev of allEvents) {
      let key = null;
      if (kind === 'package') key = ev.package || '(unknown)';
      else if (kind === 'author') key = ev.author || 'Unknown';
      else if (kind === 'change') key = changeKeyOf(ev);
      if (key === null) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  }

  function openFilterPanel(kind, anchor) {
    const panel = document.getElementById('filter-panel');
    if (!panel) return;
    if (openPanelKind === kind) {
      closeFilterPanel();
      return;
    }
    openPanelKind = kind;
    if (kind === 'date') renderDatePanel(panel);
    else renderMultiPanel(panel, kind);
    panel.hidden = false;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(280, window.innerWidth - 16);
    let left = Math.min(rect.left, window.innerWidth - width - 8);
    left = Math.max(8, left);
    panel.style.left = left + 'px';
    panel.style.top = Math.min(rect.bottom + 6, window.innerHeight - 40) + 'px';
    const focusTarget = panel.querySelector('.filter-panel-search, input[type="date"], .filter-preset');
    if (focusTarget) focusTarget.focus();
  }

  function renderDatePanel(panel) {
    const f = colFilters;
    const presets = datePresets();
    panel.innerHTML = `
      <div class="filter-panel-head">Date range</div>
      <div class="filter-presets">
        ${presets.map(p => `<button class="filter-preset${f.datePreset === p.name ? ' current' : ''}" data-preset="${p.name}">${p.name}</button>`).join('')}
      </div>
      <div class="filter-range">
        <input type="date" id="filter-date-from" value="${escapeHtml(f.dateFrom)}" aria-label="From date" max="${isoDay(new Date())}">
        <span>–</span>
        <input type="date" id="filter-date-to" value="${escapeHtml(f.dateTo)}" aria-label="To date" max="${isoDay(new Date())}">
      </div>
      <div class="filter-panel-foot">
        <button class="pager-btn" data-panel-act="clear">Clear</button>
        <button class="pager-btn apply" data-panel-act="apply">Apply</button>
      </div>`;
    panel.querySelectorAll('[data-preset]').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = presets.find(x => x.name === btn.dataset.preset);
        if (!p) return;
        panel.querySelector('#filter-date-from').value = p.from;
        panel.querySelector('#filter-date-to').value = p.to;
        panel.querySelectorAll('[data-preset]').forEach(b => b.classList.toggle('current', b === btn));
        colFilters.datePreset = p.name;
      });
    });
    const markCustom = () => {
      colFilters.datePreset = 'custom';
      panel.querySelectorAll('[data-preset]').forEach(b => b.classList.remove('current'));
    };
    panel.querySelector('#filter-date-from').addEventListener('change', markCustom);
    panel.querySelector('#filter-date-to').addEventListener('change', markCustom);
    panel.querySelector('[data-panel-act="clear"]').addEventListener('click', () => {
      colFilters.dateFrom = '';
      colFilters.dateTo = '';
      colFilters.datePreset = '';
      currentPage = 1;
      refreshColFilterState();
      closeFilterPanel();
      renderView();
    });
    panel.querySelector('[data-panel-act="apply"]').addEventListener('click', () => {
      let from = panel.querySelector('#filter-date-from').value;
      let to = panel.querySelector('#filter-date-to').value;
      if (from && to && from > to) { const t = from; from = to; to = t; }
      colFilters.dateFrom = from;
      colFilters.dateTo = to;
      if (!from && !to) colFilters.datePreset = '';
      else if (!colFilters.datePreset) colFilters.datePreset = 'custom';
      currentPage = 1;
      refreshColFilterState();
      closeFilterPanel();
      renderView();
    });
  }

  function renderMultiPanel(panel, kind) {
    const titles = { package: 'Dependencies', change: 'Version changes', author: 'Authors' };
    const stateKey = kind === 'package' ? 'packages' : kind === 'change' ? 'changes' : 'authors';
    const selected = new Set(colFilters[stateKey]);
    const items = facetValues(kind);
    panel.innerHTML = `
      <div class="filter-panel-head">${titles[kind]} (${items.length})</div>
      <input type="text" class="filter-panel-search" placeholder="Search ${titles[kind].toLowerCase()}…" aria-label="Search ${titles[kind].toLowerCase()}">
      <div class="filter-panel-list" role="group" aria-label="${titles[kind]}"></div>
      <div class="filter-panel-foot">
        <button class="pager-btn" data-panel-act="clear">Clear</button>
        <button class="pager-btn" data-panel-act="all">All</button>
        <button class="pager-btn apply" data-panel-act="apply">Apply</button>
      </div>`;
    const list = panel.querySelector('.filter-panel-list');
    const search = panel.querySelector('.filter-panel-search');
    const draw = (query) => {
      const q = (query || '').toLowerCase();
      const shown = items.filter(([name]) => !q || name.toLowerCase().includes(q));
      if (shown.length === 0) {
        list.innerHTML = '<div class="filter-panel-empty">No matches.</div>';
        return;
      }
      list.innerHTML = shown.map(([name, count]) => `
        <button class="filter-check" data-name="${escapeHtml(name)}" aria-checked="${selected.has(name)}" role="checkbox">
          <span class="box">✓</span>
          <span class="lbl" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
          <span class="cnt">${count}</span>
        </button>`).join('');
    };
    draw('');
    search.addEventListener('input', () => draw(search.value.trim()));
    list.addEventListener('click', (e) => {
      const row = e.target.closest('[data-name]');
      if (!row) return;
      const name = row.getAttribute('data-name') || '';
      if (selected.has(name)) selected.delete(name);
      else selected.add(name);
      row.setAttribute('aria-checked', String(selected.has(name)));
    });
    panel.querySelector('[data-panel-act="clear"]').addEventListener('click', () => {
      selected.clear();
      list.querySelectorAll('[aria-checked="true"]').forEach(el => el.setAttribute('aria-checked', 'false'));
    });
    panel.querySelector('[data-panel-act="all"]').addEventListener('click', () => {
      for (const [name] of items) selected.add(name);
      list.querySelectorAll('.filter-check').forEach(el => el.setAttribute('aria-checked', 'true'));
    });
    panel.querySelector('[data-panel-act="apply"]').addEventListener('click', () => {
      colFilters[stateKey] = items.map(([name]) => name).filter(name => selected.has(name));
      currentPage = 1;
      refreshColFilterState();
      closeFilterPanel();
      renderView();
    });
  }

  function populateManifestDatalist() {
    const dl = document.getElementById('manifest-datalist');
    if (!dl) return;
    const manifests = Array.from(new Set(allEvents.map(e => e.manifest).filter(Boolean))).sort();
    dl.innerHTML = manifests.map(m => `<option value="${escapeHtml(m)}"></option>`).join('');
  }

  function getSortedEvents() {
    const events = getFilteredEvents();
    return events.sort((a, b) => {
    let valA = a[sortField] || '';
    let valB = b[sortField] || '';
    if (sortField === 'date') {
      valA = new Date(valA).getTime() || 0;
      valB = new Date(valB).getTime() || 0;
    }
    if (valA < valB) return sortAsc ? -1 : 1;
    if (valA > valB) return sortAsc ? 1 : -1;
    return 0;
    });
  }

  function toggleSort(field) {
    if (sortField === field) {
    sortAsc = !sortAsc;
    } else {
    sortField = field;
    sortAsc = false;
    }
    document.getElementById('sort-date-icon').textContent = sortField === 'date' ? (sortAsc ? '↑' : '↓') : '';
    document.getElementById('sort-pkg-icon').textContent = sortField === 'package' ? (sortAsc ? '↑' : '↓') : '';
    const dateTh = document.querySelector('th [data-sort="date"]')?.closest('th');
    const pkgTh = document.querySelector('th [data-sort="package"]')?.closest('th');
    if (dateTh) dateTh.setAttribute('aria-sort', sortField === 'date' ? (sortAsc ? 'ascending' : 'descending') : 'none');
    if (pkgTh) pkgTh.setAttribute('aria-sort', sortField === 'package' ? (sortAsc ? 'ascending' : 'descending') : 'none');
    currentPage = 1;
    renderTable();
  }

  function renderView() {
    if (currentView === 'timeline') renderTable();
    else if (currentView === 'calendar') renderCalendar();
  }

  function renderTable() {
    const tbody = document.getElementById('events-tbody');
    const filtered = getSortedEvents();

    if (filtered.length === 0) {
    const isEmptyRepo = allEvents.length === 0;
    tbody.innerHTML = `
      <tr><td colspan="8" class="empty-state">
      <svg class="empty-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
      <div class="empty-title">${isEmptyRepo ? 'This repository has no dependency events yet' : 'No events matching your filter or search query'}</div>
      <div class="empty-subtitle">${isEmptyRepo ? 'Commit a package.json change and rescan to start the timeline.' : 'Try adjusting your filters, clearing your search query, or switching tabs.'}</div>
      ${isEmptyRepo ? '' : '<button class="btn-action" style="margin-top: 6px;" data-action="reset-filters">Reset Filters</button>'}
      </td></tr>
    `;
    renderPager(0, 0, 0);
    return;
    }

    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * pageSize;
    const page = filtered.slice(start, start + pageSize);

    tbody.innerHTML = page.map(ev => {
    const dateStr = (ev.date || '').slice(0, 10);
    let badgeClass = 'updated';
    let badgeLabel = '↑ Updated';

    if (ev.type === 'added') {
      badgeClass = 'added';
      badgeLabel = '+ Added';
    } else if (ev.type === 'removed') {
      badgeClass = 'removed';
      badgeLabel = '- Removed';
    }

    let changeHtml = '';
    if (ev.type === 'added') {
      changeHtml = `<span class="diff-to">${escapeHtml(ev.to || '')}</span>`;
    } else if (ev.type === 'removed') {
      changeHtml = `<span class="diff-from">was ${escapeHtml(ev.from || '')}</span>`;
    } else {
      changeHtml = `
      <span class="diff-from">${escapeHtml(ev.from || '?')}</span>
      <span class="diff-arrow">&rarr;</span>
      <span class="diff-to">${escapeHtml(ev.to || '?')}</span>
      `;
    }

    const authorInfo = getAuthorDetails(ev.author);
    const authorInitial = (authorInfo.name || 'U')[0].toUpperCase();
    const isResolved = ev.source === 'lockfile';
    const isTransitive = ev.isDirect === false || ev.is_direct === false;
    const typeBadge = isResolved
      ? `<span class="dep-type-tag">resolved</span>`
      : isTransitive
        ? `<span class="dep-type-tag">dep</span>`
        : `<span class="dep-type-tag direct">direct</span>`;

    const isWs = Boolean(
      (workspacePackages && Object.prototype.hasOwnProperty.call(workspacePackages, ev.package)) ||
      (currentRepo && ev.package === currentRepo) ||
      String(ev.to || ev.from || '').startsWith('workspace:')
    );
    const pkgIconSvg = isWs
      ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>`
      : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`;

    return `
      <tr>
      <td style="color: var(--color-text-secondary); font-family: var(--font-mono); font-size: 11.5px;">${dateStr}</td>
      <td><span class="badge-status ${badgeClass}">${badgeLabel}</span></td>
      <td>
        <div class="package-cell">
        <span class="package-cell-icon ${isWs ? 'ws' : ''}" title="${isWs ? 'Internal repository package' : 'Package'}">${pkgIconSvg}</span>
        <button class="package-name" data-pkg="${escapeHtml(ev.package)}" title="${escapeHtml(ev.package)} (click for archaeology)">
          ${escapeHtml(ev.package)}
        </button>
        </div>
      </td>
      <td><div class="diff-pill">${changeHtml}</div></td>
      <td>${typeBadge}</td>
      <td><span class="manifest-badge" title="${escapeHtml(ev.manifest)}">${escapeHtml(ev.manifest)}</span></td>
      <td>
        <a href="${authorInfo.profileUrl}" target="_blank" rel="noopener noreferrer" class="author-cell-link" title="View ${escapeHtml(authorInfo.name)} (@${escapeHtml(authorInfo.username)}) on ${repoHost}">
        <div class="author-avatar-wrapper">
          <div class="author-avatar-fallback" style="display: flex;">${escapeHtml(authorInitial)}</div>
        </div>
        <div class="author-meta">
          <span class="author-name">${escapeHtml(authorInfo.name)}</span>
          <span class="author-user">@${escapeHtml(authorInfo.username)}</span>
        </div>
        </a>
      </td>
      <td>
        <button class="commit-tag" data-commit="${escapeHtml(ev.commit)}" data-full="${escapeHtml(ev.commitFull || ev.commit)}" title="${escapeHtml(ev.message || '')} (${remoteUrl ? 'open on GitHub' : 'click to copy'})">
        ${ev.commit}
        </button>
      </td>
      </tr>
    `;
    }).join('');
    renderPager(filtered.length, start, totalPages);
  }

  function renderPager(total, start, totalPages) {
    const pager = document.getElementById('pager');
    const info = document.getElementById('pager-info');
    const first = document.getElementById('pager-first');
    const prev = document.getElementById('pager-prev');
    const next = document.getElementById('pager-next');
    const last = document.getElementById('pager-last');
    const numbers = document.getElementById('pager-numbers');
    const sizeSel = document.getElementById('pager-size');
    if (!pager) return;
    if (sizeSel && String(pageSize) !== sizeSel.value) sizeSel.value = String(pageSize);
    if (total <= pageSize) {
      pager.hidden = total === 0 ? false : true;
      if (info) info.textContent = total === 0 ? 'Showing 0 events' : `Showing all ${total} events`;
      if (numbers) numbers.innerHTML = '';
      if (first) first.disabled = true;
      if (prev) prev.disabled = true;
      if (next) next.disabled = true;
      if (last) last.disabled = true;
      return;
    }
    pager.hidden = false;
    if (info) info.textContent = `Showing ${total === 0 ? 0 : start + 1}–${Math.min(start + pageSize, total)} of ${total} events · page ${currentPage}/${totalPages}`;
    if (first) first.disabled = currentPage <= 1;
    if (prev) prev.disabled = currentPage <= 1;
    if (next) next.disabled = currentPage >= totalPages;
    if (last) last.disabled = currentPage >= totalPages;
    if (numbers) {
      numbers.innerHTML = pageNumberWindow(currentPage, totalPages).map(n =>
        n === '…'
          ? '<span class="pager-ellipsis">…</span>'
          : `<button class="pager-btn pager-num${n === currentPage ? ' current' : ''}" data-page="${n}" aria-label="Page ${n}"${n === currentPage ? ' aria-current="page"' : ''}>${n}</button>`
      ).join('');
    }
  }

  // Windowed page numbers: 1 … c-1 c c+1 … N (at most 7 slots).
  function pageNumberWindow(current, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const set = new Set([1, 2, current - 1, current, current + 1, total - 1, total].filter(n => n >= 1 && n <= total));
    const sorted = Array.from(set).sort((a, b) => a - b);
    const out = [];
    let prevN = 0;
    for (const n of sorted) {
      if (n - prevN > 1) out.push('…');
      out.push(n);
      prevN = n;
    }
    return out;
  }

  function gotoPage(n, totalPages) {
    const clamped = Math.min(Math.max(1, n), totalPages);
    if (clamped !== currentPage) {
      currentPage = clamped;
      renderTable();
    }
  }

  // Single delegated click handler for the events table: package
  // archaeology, commit open/copy, and empty-state reset. No inline
  // handlers, so repository data can never break into script context.
  function initTableDelegation() {
    const tbody = document.getElementById('events-tbody');
    if (!tbody || tbody.dataset.delegated) return;
    tbody.dataset.delegated = '1';
    tbody.addEventListener('click', (e) => {
      const pkg = e.target.closest('[data-pkg]');
      if (pkg && tbody.contains(pkg)) {
        openArchaeology(pkg.getAttribute('data-pkg') || '');
        return;
      }
      const commit = e.target.closest('[data-commit]');
      if (commit && tbody.contains(commit)) {
        const short = commit.getAttribute('data-commit') || '';
        const full = commit.getAttribute('data-full') || short;
        if (remoteUrl) window.open(remoteUrl + '/commit/' + full, '_blank');
        else copyText(short, 'Commit SHA copied!');
        return;
      }
      const action = e.target.closest('[data-action="reset-filters"]');
      if (action && tbody.contains(action)) resetFilters();
    });
  }

  let calendarYear = new Date().getFullYear();
  let calendarMonth = new Date().getMonth();
  let calendarInitialized = false;

  function renderCalendar() {
    const grid = document.getElementById('calendar-days-grid');
    const titleElem = document.getElementById('calendar-month-title');
    const statsElem = document.getElementById('calendar-month-stats');
    if (!grid || !titleElem) return;

    const filtered = getFilteredEvents();

    // If opening calendar for first time, center on latest event's month
    if (!calendarInitialized && filtered.length > 0) {
    for (const ev of filtered) {
      if (ev.date) {
      const d = new Date(ev.date);
      if (!isNaN(d.getTime())) {
        calendarYear = d.getFullYear();
        calendarMonth = d.getMonth();
        break;
      }
      }
    }
    calendarInitialized = true;
    }

    titleElem.textContent = `${MONTHS[calendarMonth]} ${calendarYear}`;

    const ymPrefix = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}`;
    // Viewer-local basis (same helper as grouping): boundary events
    // can't select one month but render in another.
    const monthEvents = filtered.filter(e => {
      const k = dayKeyLocal(e.date);
      return k !== null && k.startsWith(ymPrefix);
    });

    const dayEventMap = new Map();
    let monthAdded = 0, monthUpdated = 0, monthRemoved = 0;
    for (const ev of monthEvents) {
    const k = dayKeyLocal(ev.date);
    if (k === null) continue;
    const day = parseInt(k.slice(8, 10), 10);
    if (!dayEventMap.has(day)) dayEventMap.set(day, []);
    dayEventMap.get(day).push(ev);
    if (ev.type === 'added') monthAdded++;
    else if (ev.type === 'removed') monthRemoved++;
    else monthUpdated++;
    }

    if (statsElem) {
    statsElem.textContent = `${monthEvents.length} change${monthEvents.length === 1 ? '' : 's'} (${monthAdded} added, ${monthUpdated} updated, ${monthRemoved} removed)`;
    }

    const firstDayOfWeek = new Date(calendarYear, calendarMonth, 1).getDay(); // 0 = Sun
    const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
    const daysInPrevMonth = new Date(calendarYear, calendarMonth, 0).getDate();

    const now = new Date();
    const isCurrentMonthYear = now.getFullYear() === calendarYear && now.getMonth() === calendarMonth;
    const todayDate = now.getDate();

    let cellsHtml = '';

    // 1. Previous month trailing days
    for (let i = firstDayOfWeek - 1; i >= 0; i--) {
    const d = daysInPrevMonth - i;
    cellsHtml += `
      <div class="calendar-day-box outside-month">
      <div class="day-box-header">
        <span class="day-number">${d}</span>
      </div>
      </div>
    `;
    }

    // 2. Current month days
    for (let d = 1; d <= daysInMonth; d++) {
    const dayEvents = dayEventMap.get(d) || [];
    const isToday = isCurrentMonthYear && todayDate === d;
    const dayStr = `${ymPrefix}-${String(d).padStart(2, '0')}`;

    let eventsHtml = '';
    if (dayEvents.length > 0) {
      const displayCount = Math.min(dayEvents.length, 3);
      for (let i = 0; i < displayCount; i++) {
      const ev = dayEvents[i];
      let symbol = '+';
      if (ev.type === 'removed') symbol = '–';
      else if (ev.type === 'updated') symbol = '↑';

      const ver = ev.type === 'removed' ? (ev.from || '') : (ev.to || '');
      eventsHtml += `
        <button class="day-event-pill ${ev.type}" data-pkg="${escapeHtml(ev.package)}" title="${symbol} ${escapeHtml(ev.package)} ${ver ? '(' + escapeHtml(ver) + ')' : ''} by ${escapeHtml(ev.author || '')}">
        <span>${symbol}</span>
        <span style="overflow: hidden; text-overflow: ellipsis;">${escapeHtml(ev.package)}</span>
        </button>
      `;
      }

      if (dayEvents.length > 3) {
      eventsHtml += `<div class="day-event-more">+${dayEvents.length - 3} more</div>`;
      }
    }

    const countBadge = dayEvents.length > 0 ? `<span class="day-badge-count">${dayEvents.length}</span>` : '';

    cellsHtml += `
      <div class="calendar-day-box ${isToday ? 'today' : ''} ${dayEvents.length > 0 ? 'has-events' : ''}" data-day="${dayStr}" role="button" tabindex="${dayEvents.length > 0 ? '0' : '-1'}" aria-label="${d} ${MONTHS[calendarMonth]}: ${dayEvents.length} change(s). Activate to view day timeline." title="${d} ${MONTHS[calendarMonth]}: ${dayEvents.length} change(s). Click to view day timeline.">
      <div class="day-box-header">
        <span class="day-number">${d}</span>
        ${countBadge}
      </div>
      <div class="day-events-stack">
        ${eventsHtml}
      </div>
      </div>
    `;
    }

    // 3. Next month leading days to complete grid row
    const totalCellsSoFar = firstDayOfWeek + daysInMonth;
    const nextMonthDays = (7 - (totalCellsSoFar % 7)) % 7;
    for (let d = 1; d <= nextMonthDays; d++) {
    cellsHtml += `
      <div class="calendar-day-box outside-month">
      <div class="day-box-header">
        <span class="day-number">${d}</span>
      </div>
      </div>
    `;
    }

    grid.innerHTML = cellsHtml;
    initCalendarDelegation();
  }

  // Delegated calendar interactions: package pills open archaeology,
  // day boxes filter the timeline. Keyboard accessible via Enter/Space.
  function initCalendarDelegation() {
    const grid = document.getElementById('calendar-days-grid');
    if (!grid || grid.dataset.delegated) return;
    grid.dataset.delegated = '1';
    grid.addEventListener('click', (e) => {
      const pkg = e.target.closest('[data-pkg]');
      if (pkg && grid.contains(pkg)) {
        e.stopPropagation();
        openArchaeology(pkg.getAttribute('data-pkg') || '');
        return;
      }
      const day = e.target.closest('[data-day]');
      if (day && grid.contains(day)) filterByDay(day.getAttribute('data-day') || '');
    });
    grid.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const pkg = e.target.closest('[data-pkg]');
      if (pkg && grid.contains(pkg)) {
        e.preventDefault();
        e.stopPropagation();
        openArchaeology(pkg.getAttribute('data-pkg') || '');
        return;
      }
      const day = e.target.closest('[data-day]');
      if (day && grid.contains(day)) {
        e.preventDefault();
        filterByDay(day.getAttribute('data-day') || '');
      }
    });
  }

  function filterByDay(dayStr) {
    document.getElementById('search-input').value = dayStr;
    currentSearch = dayStr;
    document.getElementById('search-clear').style.display = 'block';
    switchToTimeline();
  }

  function resetFilters() {
    currentFilter = 'all';
    currentSearch = '';
    currentManifest = 'all';
    closeFilterPanel();
    clearColFilters();
    currentPage = 1;
    document.getElementById('search-input').value = '';
    document.getElementById('search-clear').style.display = 'none';
    document.getElementById('manifest-selected-label').textContent = 'All Manifests';
    document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === 'all');
    });
    renderView();
  }

  // Archaeology Drawer
  function openArchaeology(pkgName) {
    selectedPkgName = pkgName;
    const pkgEvents = allEvents.filter(e => e.package === pkgName);
    if (pkgEvents.length === 0) return;

    document.getElementById('drawer-title').textContent = pkgName;

    // Detect if package is internal workspace / repo package
    const isWorkspacePkg = Boolean(
    (workspacePackages && Object.prototype.hasOwnProperty.call(workspacePackages, pkgName)) ||
    (currentRepo && pkgName === currentRepo) ||
    pkgEvents.some(e => {
      const v = String(e.to || e.from || '');
      return v.startsWith('workspace:') || v.startsWith('file:') || v.startsWith('link:') || v.startsWith('portal:');
    })
    );

    // Workspace badge
    const workspaceBadge = document.getElementById('drawer-workspace-badge');
    if (workspaceBadge) {
    workspaceBadge.style.display = isWorkspacePkg ? 'inline-block' : 'none';
    }

    // Package Avatar Icon: Book/Repo icon for workspace packages, 3D cube for external registry packages
    const avatarContainer = document.getElementById('drawer-pkg-avatar-icon');
    if (avatarContainer) {
    if (isWorkspacePkg) {
      avatarContainer.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
      </svg>
      `;
      avatarContainer.title = 'Internal workspace / repository package';
    } else {
      avatarContainer.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
        <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
        <line x1="12" y1="22.08" x2="12" y2="12"></line>
      </svg>
      `;
      avatarContainer.title = 'External registry package';
    }
    }

    // Package Action Link: link to GitHub repo directory or registry
    const pkgLink = document.getElementById('drawer-package-link');
    const pkgLinkText = document.getElementById('drawer-package-link-text');
    const pkgLinkIcon = document.getElementById('drawer-package-link-icon');

    if (pkgLink && pkgLinkText) {
    if (isWorkspacePkg) {
      const pkgRelDir = (workspacePackages && workspacePackages[pkgName]) || '';
      if (remoteUrl) {
      const cleanRemote = remoteUrl.replace(/\/+$/, '');
      const branchRef = encodeURIComponent(currentBranch || 'main');
      const targetUrl = pkgRelDir ? `${cleanRemote}/tree/${branchRef}/${pkgRelDir}` : cleanRemote;
      pkgLink.href = targetUrl;
      pkgLink.title = `View package directory (${pkgRelDir || 'root'}) on GitHub`;
      pkgLinkText.textContent = 'View in Repo';
      pkgLink.classList.remove('disabled');
      pkgLink.setAttribute('target', '_blank');
      if (pkgLinkIcon) {
        pkgLinkIcon.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`;
      }
      } else {
      pkgLink.removeAttribute('href');
      pkgLink.title = 'Internal repository package (no remote repository configured)';
      pkgLinkText.textContent = 'Local Package';
      pkgLink.classList.add('disabled');
      if (pkgLinkIcon) {
        pkgLinkIcon.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>`;
      }
      }
    } else {
      pkgLink.classList.remove('disabled');
      pkgLink.setAttribute('target', '_blank');
      if (currentPm === 'cargo') {
      pkgLink.href = `https://crates.io/crates/${encodeURIComponent(pkgName)}`;
      pkgLink.title = 'View on crates.io registry';
      pkgLinkText.textContent = 'crates.io package';
      } else {
      pkgLink.href = `https://www.npmjs.com/package/${encodeURIComponent(pkgName)}`;
      pkgLink.title = 'View on npm registry';
      pkgLinkText.textContent = 'npm package';
      }
      if (pkgLinkIcon) {
      pkgLinkIcon.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`;
      }
    }
    }

    const latest = pkgEvents[pkgEvents.length - 1];
    const statusBadge = document.getElementById('drawer-status');
    const statusText = document.getElementById('drawer-status-text');
    // HEAD-derived status when available: per-manifest reality, not the
    // last chronological event (which may live on an unmerged branch).
    const headEntries = headStateData.filter(h => h.package === pkgName);
    if (headEntries.length > 0) {
    statusBadge.className = 'drawer-status-pill added';
    if (statusText) {
      const first = headEntries[0];
      statusText.textContent = headEntries.length === 1
      ? `Active ${first.version || ''} · ${first.manifest}`
      : `Active in ${headEntries.length} manifests`;
    }
    } else if (latest.type === 'removed') {
    statusBadge.className = 'drawer-status-pill removed';
    if (statusText) statusText.textContent = 'Removed (was ' + (latest.from || latest.to || '') + ')';
    } else {
    statusBadge.className = 'drawer-status-pill removed';
    if (statusText) statusText.textContent = 'Removed at HEAD';
    }

    // Deptype badge
    const depTypeElem = document.getElementById('drawer-deptype');
    if (depTypeElem) {
    depTypeElem.textContent = latest.depType || pkgEvents[0].depType || 'dependencies';
    }

    // Manifest summary
    const manifestElem = document.getElementById('drawer-manifest-summary');
    if (manifestElem) {
    const manifests = Array.from(new Set(pkgEvents.map(e => e.manifest).filter(Boolean)));
    manifestElem.textContent = manifests.length === 1 ? manifests[0] : `${manifests.length} manifests`;
    }

    // Stats strip
    const changesCountElem = document.getElementById('drawer-changes-count');
    if (changesCountElem) {
    changesCountElem.textContent = `${pkgEvents.length} ${pkgEvents.length === 1 ? 'change' : 'changes'}`;
    }

    const firstDateElem = document.getElementById('drawer-first-date');
    if (firstDateElem) {
    firstDateElem.textContent = (pkgEvents[0].date || '').slice(0, 10);
    }

    const authorsCountElem = document.getElementById('drawer-authors-count');
    if (authorsCountElem) {
    const authors = new Set(pkgEvents.map(e => e.author).filter(Boolean));
    authorsCountElem.textContent = `${authors.size} ${authors.size === 1 ? 'author' : 'authors'}`;
    }

    const timeline = document.getElementById('drawer-timeline');
    timeline.innerHTML = pkgEvents.map(ev => {
    const dateStr = (ev.date || '').slice(0, 10);
    let actionSymbol = '';
    if (ev.type === 'added') actionSymbol = '+';
    else if (ev.type === 'removed') actionSymbol = '–';
    else actionSymbol = '↑';

    let actionText = '';
    if (ev.type === 'added') actionText = `Added version <span style="color: var(--color-added)">${escapeHtml(ev.to || '')}</span>`;
    else if (ev.type === 'removed') actionText = `Removed dependency (was ${escapeHtml(ev.from || '')})`;
    else actionText = `Upgraded ${escapeHtml(ev.from || '')} &rarr; <span style="color: var(--color-updated)">${escapeHtml(ev.to || '')}</span>`;

    const authorInfo = getAuthorDetails(ev.author);
    const authorInitial = (authorInfo.name || 'U')[0].toUpperCase();

    return `
      <div class="timeline-node ${ev.type}">
      <div class="node-icon">${actionSymbol}</div>
      <div class="node-card">
        <div class="node-meta">
        <span>${dateStr}</span>
        <button class="commit-tag" data-commit="${escapeHtml(ev.commit)}" data-full="${escapeHtml(ev.commitFull || ev.commit)}" title="${escapeHtml(ev.message || '')} (${remoteUrl ? 'open on GitHub' : 'click to copy'})">${ev.commit}</button>
        </div>
        <div class="node-version">${actionText}</div>
        <div class="node-msg">${escapeHtml(ev.message || 'No commit message')}</div>
        <div style="font-size: 11px; color: var(--color-text-secondary); margin-top: 6px; display: flex; align-items: center; gap: 7px;">
        <div class="author-avatar-wrapper" style="width: 18px; height: 18px;">
          <div class="author-avatar-fallback" style="font-size: 9px; display: flex;">${escapeHtml(authorInitial)}</div>
        </div>
        <span>by <a href="${authorInfo.profileUrl}" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: underline; font-weight: 500;" title="View ${escapeHtml(authorInfo.name)} (@${escapeHtml(authorInfo.username)}) on GitHub">${escapeHtml(authorInfo.name)}</a> <span style="font-family: var(--font-mono); font-size: 10px; color: var(--color-text-secondary);">@${escapeHtml(authorInfo.username)}</span> in <span style="font-family: var(--font-mono)">${escapeHtml(ev.manifest)}</span></span>
        </div>
      </div>
      </div>
    `;
    }).join('');

    document.getElementById('drawer-overlay').classList.add('active');
    initTimelineDelegation();
    // Move focus into the dialog for keyboard and screen-reader users.
    const closeBtn = document.getElementById('drawer-close');
    if (closeBtn) closeBtn.focus();
  }

  // Delegated commit open/copy inside the archaeology timeline.
  function initTimelineDelegation() {
    const timeline = document.getElementById('drawer-timeline');
    if (!timeline || timeline.dataset.delegated) return;
    timeline.dataset.delegated = '1';
    timeline.addEventListener('click', (e) => {
      const commit = e.target.closest('[data-commit]');
      if (commit && timeline.contains(commit)) {
        const short = commit.getAttribute('data-commit') || '';
        const full = commit.getAttribute('data-full') || short;
        if (remoteUrl) window.open(remoteUrl + '/commit/' + full, '_blank');
        else copyText(short, 'Commit SHA copied!');
      }
    });
  }

  function closeArchaeology() {
    document.getElementById('drawer-overlay').classList.remove('active');
    selectedPkgName = null;
  }

  function copyText(text, msg = 'Copied to clipboard!') {
    navigator.clipboard.writeText(text).then(() => {
    showToast(msg);
    });
  }

  function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  }

  /**
   * Viewer-local calendar day key. Single basis for month grouping,
   * month selection, and day cells so boundary events can't select
   * one month but render in another.
   */
  function dayKeyLocal(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function switchToTimeline() {
    if (currentView === 'timeline') return;
    currentView = 'timeline';
    document.getElementById('view-timeline-btn').classList.add('active');
    document.getElementById('view-calendar-btn').classList.remove('active');
    document.getElementById('timeline-view').style.display = 'block';
    document.getElementById('calendar-view').classList.remove('active');
    renderTable();
  }

  function switchToCalendar() {
    if (currentView === 'calendar') return;
    currentView = 'calendar';
    document.getElementById('view-calendar-btn').classList.add('active');
    document.getElementById('view-timeline-btn').classList.remove('active');
    document.getElementById('timeline-view').style.display = 'none';
    document.getElementById('calendar-view').classList.add('active');
    renderCalendar();
  }

  // View toggles
  document.getElementById('view-timeline-btn').addEventListener('click', switchToTimeline);
  document.getElementById('view-calendar-btn').addEventListener('click', switchToCalendar);

  // Calendar navigation
  const calPrev = document.getElementById('cal-prev-btn');
  if (calPrev) {
    calPrev.addEventListener('click', () => {
    calendarMonth--;
    if (calendarMonth < 0) {
      calendarMonth = 11;
      calendarYear--;
    }
    renderCalendar();
    });
  }

  const calNext = document.getElementById('cal-next-btn');
  if (calNext) {
    calNext.addEventListener('click', () => {
    calendarMonth++;
    if (calendarMonth > 11) {
      calendarMonth = 0;
      calendarYear++;
    }
    renderCalendar();
    });
  }

  const calToday = document.getElementById('cal-today-btn');
  if (calToday) {
    calToday.addEventListener('click', () => {
    const filtered = getFilteredEvents();
    if (filtered.length > 0) {
      for (const ev of filtered) {
      if (ev.date) {
        const d = new Date(ev.date);
        if (!isNaN(d.getTime())) {
        calendarYear = d.getFullYear();
        calendarMonth = d.getMonth();
        renderCalendar();
        return;
        }
      }
      }
    }
    const now = new Date();
    calendarYear = now.getFullYear();
    calendarMonth = now.getMonth();
    renderCalendar();
    });
  }

  // Filter pills
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
    currentPage = 1;
    setFilter(btn.dataset.filter);
    });
  });

  // KPI cards act as type filters (real buttons, keyboard accessible)
  document.querySelectorAll('[data-kpi-filter]').forEach(card => {
    card.addEventListener('click', () => {
    currentPage = 1;
    setFilter(card.getAttribute('data-kpi-filter') || 'all');
    });
  });

  // Sortable column headers with accessible sort state
  document.querySelectorAll('.th-sort').forEach(btn => {
    btn.addEventListener('click', () => {
    toggleSort(btn.getAttribute('data-sort') || 'date');
    });
  });

  // Manifest dropdown: reset page on change + keyboard access
  const manifestMenu = document.getElementById('manifest-dropdown-menu');
  if (manifestMenu) {
    manifestMenu.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.classList.contains('dropdown-item')) {
      e.preventDefault();
      e.target.click();
    }
    });
  }

  // Pager: full controls — first/prev/numbered/next/last + page size.
  // The footer is fixed below the rows-only scroll region.
  function pagerTotalPages() {
    const total = getFilteredEvents().length;
    return Math.max(1, Math.ceil(total / pageSize));
  }
  const pagerFirst = document.getElementById('pager-first');
  const pagerPrev = document.getElementById('pager-prev');
  const pagerNext = document.getElementById('pager-next');
  const pagerLast = document.getElementById('pager-last');
  const pagerNumbers = document.getElementById('pager-numbers');
  const pagerSize = document.getElementById('pager-size');
  if (pagerFirst) pagerFirst.addEventListener('click', () => gotoPage(1, pagerTotalPages()));
  if (pagerPrev) pagerPrev.addEventListener('click', () => {
    if (currentPage > 1) {
    currentPage--;
    renderTable();
    }
  });
  if (pagerNext) pagerNext.addEventListener('click', () => {
    const totalPages = pagerTotalPages();
    if (currentPage < totalPages) {
    currentPage++;
    renderTable();
    }
  });
  if (pagerLast) pagerLast.addEventListener('click', () => gotoPage(pagerTotalPages(), pagerTotalPages()));
  if (pagerNumbers) pagerNumbers.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-page]');
    if (btn) gotoPage(parseInt(btn.dataset.page, 10) || 1, pagerTotalPages());
  });
  if (pagerSize) pagerSize.addEventListener('change', (e) => {
    const next = parseInt(e.target.value, 10);
    pageSize = [25, 50, 100].includes(next) ? next : 100;
    currentPage = 1;
    renderTable();
  });

  // Per-column datatable filters (debounced text, immediate selects).
  // Date/package/change/author columns open rich floating panels instead.
  document.querySelectorAll('.col-filter-btn[data-panel]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openFilterPanel(btn.dataset.panel, btn);
    });
  });
  document.addEventListener('click', (e) => {
    const panel = document.getElementById('filter-panel');
    if (panel && !panel.hidden && !panel.contains(e.target) && !e.target.closest('.col-filter-btn')) {
      closeFilterPanel();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openPanelKind) closeFilterPanel();
  });
  window.addEventListener('resize', closeFilterPanel);
  const tableScroll = document.querySelector('.table-responsive');
  if (tableScroll) tableScroll.addEventListener('scroll', closeFilterPanel, { passive: true });
  document.querySelectorAll('.col-filter').forEach(el => {
    const col = el.dataset.col;
    if (!col) return;
    if (el.tagName === 'SELECT') {
      el.addEventListener('change', () => {
        setColFilter(col, el.value);
        refreshColFilterState();
      });
    } else {
      el.addEventListener('input', () => {
        if (colFilterTimer) clearTimeout(colFilterTimer);
        const value = el.value;
        colFilterTimer = setTimeout(() => {
          setColFilter(col, value.trim().toLowerCase());
          refreshColFilterState();
        }, 150);
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          if (colFilterTimer) clearTimeout(colFilterTimer);
          setColFilter(col, el.value.trim().toLowerCase());
          refreshColFilterState();
        } else if (e.key === 'Escape') {
          el.value = '';
          if (colFilterTimer) clearTimeout(colFilterTimer);
          setColFilter(col, col === 'action' || col === 'type' ? 'all' : '');
          refreshColFilterState();
        }
        e.stopPropagation();
      });
    }
  });
  const colClearBtn = document.getElementById('col-filter-clear');
  if (colClearBtn) colClearBtn.addEventListener('click', () => {
    clearColFilters();
    refreshColFilterState();
    renderView();
  });

  // Live search (debounced so large histories don't re-render per keystroke)
  const searchInput = document.getElementById('search-input');
  const searchClear = document.getElementById('search-clear');
  searchInput.addEventListener('input', (e) => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      currentSearch = e.target.value.trim();
      currentPage = 1;
      searchClear.style.display = currentSearch ? 'block' : 'none';
      renderView();
    }, 150);
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    currentSearch = '';
    searchClear.style.display = 'none';
    renderView();
    searchInput.focus();
  });

  // Keyboard shortcuts (ignored while typing in any field)
  function isTypingTarget(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  }
  window.addEventListener('keydown', (e) => {
    if ((e.key === '/' || (e.ctrlKey && e.key === 'k') || (e.metaKey && e.key === 'k')) && !isTypingTarget(document.activeElement)) {
    e.preventDefault();
    searchInput.focus();
    } else if (e.key === 'Escape') {
    if (document.getElementById('drawer-overlay').classList.contains('active')) {
      closeArchaeology();
    } else if (document.activeElement === searchInput) {
      searchInput.blur();
    }
    } else if (e.key === '1' && !isTypingTarget(document.activeElement)) {
    switchToTimeline();
    } else if (e.key === '2' && !isTypingTarget(document.activeElement)) {
    document.getElementById('view-calendar-btn').click();
    }
  });

  // Drawer events
  document.getElementById('drawer-close').addEventListener('click', closeArchaeology);
  document.getElementById('drawer-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'drawer-overlay') closeArchaeology();
  });

  // Drawer copy package name
  document.getElementById('drawer-copy-name').addEventListener('click', () => {
    if (!selectedPkgName) return;
    copyText(selectedPkgName, `Copied "${selectedPkgName}" to clipboard!`);
  });

  // Drawer filter table by package
  document.getElementById('drawer-filter-btn').addEventListener('click', () => {
    if (!selectedPkgName) return;
    const pkg = selectedPkgName;
    closeArchaeology();
    const searchInput = document.getElementById('search-input');
    searchInput.value = pkg;
    currentSearch = pkg;
    document.getElementById('search-clear').style.display = 'block';
    renderView();
    showToast(`Filtered table by "${pkg}"`);
  });

  // Copy Markdown Summary for drawer
  document.getElementById('drawer-copy-md').addEventListener('click', () => {
    if (!selectedPkgName) return;
    const pkgEvents = allEvents.filter(e => e.package === selectedPkgName);
    let md = `### Dependency Archaeology: \`${selectedPkgName}\`\n\n`;
    md += `| Date | Action | From | To | Commit | Author |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;
    for (const ev of pkgEvents) {
    const d = (ev.date || '').slice(0, 10);
    md += `| ${d} | ${ev.type} | ${ev.from || '-'} | ${ev.to || '-'} | ${ev.commit} | ${ev.author || '-'} |\n`;
    }
    copyText(md, `Copied ${selectedPkgName} markdown changelog!`);
  });

  // Export JSON
  document.getElementById('export-json-btn').addEventListener('click', () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(allEvents, null, 2));
    const a = document.createElement('a');
    a.setAttribute('href', dataStr);
    a.setAttribute('download', `dep-blame-${document.getElementById('repo-name').textContent || 'export'}.json`);
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('Exported events as JSON');
  });

  // Sync button
  document.getElementById('refresh-btn').addEventListener('click', () => {
    loadData();
    showToast('Synced with git repository!');
  });

  initTheme();
  initTableDelegation();
  initCalendarDelegation();
  loadData();