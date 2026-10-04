  let allEvents = [];
  let historyState = 'loading';
  let historyError = '';
  const DOWN_CHEVRON = '<svg class="control-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';
  let currentFilter = 'all';
  let currentSearch = '';
  let currentView = 'timeline';
  let sortField = 'date';
  let sortAsc = false;
  let selectedPkgName = null;
  let currentPage = 1;
  let pageSize = 100;
  const PAGE_SIZES = [25, 50, 100];
  let searchTimer = null;
  // Per-column datatable filters. Sets (packages/changes/authors) and the
  // date range are empty/off when inactive; selects use 'all'.
  let colFilters = freshColFilters();
  function freshColFilters() {
    return { dateFrom: '', dateTo: '', datePreset: '', action: 'all', packages: [], changes: [], type: 'all', manifest: '', authors: [], commit: '' };
  }

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  let repoOwner = null;
  let repoHost = '';
  let hosting = {provider: 'local', label: 'Local Git', host: ''};
  let authorGeneration = 0;
  const authorProfiles = new Map();
  const authorRequests = new Set();
  let authorTimer = null;
  let remoteUrl = null;
  let currentBranch = 'main';
  let currentRepo = '';
  let currentPm = 'npm';
  let workspacePackages = {};
  let authorsMap = {};
  let headStateData = [];
  let headStateComplete = true;
  let historyWarnings = [];
  let historyTruncated = false;
  let drawerReturnFocus = null;

  // Theme Management (Dark Theme Default)
  function initTheme() {
    let savedTheme = 'dark';
    try { savedTheme = localStorage.getItem('dep-blame-theme') || 'dark'; } catch {}
    if (!['dark', 'light'].includes(savedTheme)) savedTheme = 'dark';
    setTheme(savedTheme);

    document.getElementById('theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    setTheme(next);
    });
  }

  function setTheme(theme) {
    const root = document.documentElement;
    // One-frame swap without per-element transitions (the toggle lag).
    root.classList.add('theme-switching');
    root.setAttribute('data-theme', theme);
    try { localStorage.setItem('dep-blame-theme', theme); } catch {}
    const darkIcon = document.getElementById('theme-icon-dark');
    const lightIcon = document.getElementById('theme-icon-light');
    if (theme === 'dark') {
    darkIcon.style.display = 'block';
    lightIcon.style.display = 'none';
    } else {
    darkIcon.style.display = 'none';
    lightIcon.style.display = 'block';
    }
    // Flush styles while the guard is on, then lift it next frame.
    void root.offsetHeight;
    requestAnimationFrame(() => root.classList.remove('theme-switching'));
  }

  function getAuthorDetails(author, commit) {
    const profile = authorProfiles.get(commit)?.profile;
    return {name: author || 'Unknown', username: profile?.username || '', profileUrl: safeExternalUrl(profile?.profileUrl)};
  }

  function renderAuthorName(author, commit) {
    const details = getAuthorDetails(author, commit);
    const name = escapeHtml(details.name);
    return details.profileUrl
      ? `<a class="author-name" href="${escapeHtml(details.profileUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml('Hosting account: ' + details.username)}">${name}</a>`
      : `<span class="author-name" title="Git author; no linked hosting account available yet">${name}</span>`;
  }

  function updateHosting(value) {
    if (value && typeof value.label === 'string') { hosting = value; remoteUrl = safeExternalUrl(value.url) || remoteUrl; }
    const el = document.getElementById('forge-host');
    el.textContent = hosting.host ? hosting.label + ' · ' + hosting.host : 'Local Git';
    el.title = el.textContent;
    if (remoteUrl) el.href = remoteUrl; else el.removeAttribute('href');
  }
  function commitUrl(full) {
    if (!remoteUrl || ['local', 'unknown'].includes(hosting.provider)) return null;
    const segment = hosting.provider === 'gitlab' ? '/-/commit/' :
      ['bitbucket', 'bitbucket-server'].includes(hosting.provider) ? '/commits/' : '/commit/';
    return remoteUrl + segment + encodeURIComponent(full);
  }
  function treeUrl(ref, relativePath) {
    if (hosting.provider === 'unknown') return remoteUrl;
    const segment = hosting.provider === 'gitlab' ? '/-/tree/' :
      ['gitea', 'forgejo'].includes(hosting.provider) ? '/src/branch/' :
      ['bitbucket', 'bitbucket-server'].includes(hosting.provider) ? '/src/' : '/tree/';
    if (hosting.provider === 'bitbucket-server') return remoteUrl.replace(/\/+$/, '') + '/browse/' + relativePath.split('/').map(encodeURIComponent).join('/') + '?at=' + encodeURIComponent(ref);
    return remoteUrl.replace(/\/+$/, '') + segment + encodeURIComponent(ref) + '/' + relativePath.split('/').map(encodeURIComponent).join('/');
  }
  function hydrateAuthors() {
    const missing = new Set();
    document.querySelectorAll('[data-author-commit]').forEach(wrapper => {
      const sha = wrapper.dataset.authorCommit;
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)) return;
      const cached = authorProfiles.get(sha);
      if (!cached || cached.until < Date.now()) { if (!authorRequests.has(sha)) missing.add(sha); return; }
      const profile = cached.profile;
      if (!profile) { wrapper.title = 'No linked hosting account available; showing Git initials'; return; }
      const imageUrl = /^\/api\/avatars\/[a-f0-9]{64}$/.test(profile.avatarUrl || '') ? profile.avatarUrl : '';
      if (imageUrl && !wrapper.querySelector('img')) {
        const img = document.createElement('img');
        img.className = 'author-avatar-img'; img.alt = ''; img.width = 26; img.height = 26;
        img.loading = 'lazy'; img.decoding = 'async';
        img.addEventListener('load', () => { const fallback = wrapper.querySelector('.author-avatar-fallback'); if (fallback) fallback.hidden = true; });
        img.addEventListener('error', () => { img.remove(); wrapper.title = 'Profile picture unavailable; showing Git initials'; });
        img.src = imageUrl; wrapper.appendChild(img);
      }
      wrapper.title = 'Hosting account: ' + (profile.username || 'author');
      const name = wrapper.closest('[data-author-entry]')?.querySelector('.author-name');
      const profileUrl = safeExternalUrl(profile.profileUrl);
      if (name && profileUrl && name.tagName !== 'A') {
        const link = document.createElement('a'); link.className = name.className;
        link.textContent = name.textContent; link.href = profileUrl;
        link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.title = wrapper.title; name.replaceWith(link);
      }
    });
    if (missing.size && remoteUrl && hosting.avatarsEnabled !== false) {
      clearTimeout(authorTimer);
      const generation = authorGeneration;
      authorTimer = setTimeout(() => loadAuthors([...missing].slice(0,20), generation), 80);
    }
  }
  async function loadAuthors(commits, generation) {
    commits.forEach(sha => authorRequests.add(sha));
    try {
      const response = await fetch('/api/authors?commits=' + commits.join(','));
      if (!response.ok) throw new Error('Author profiles unavailable');
      const data = await response.json();
      if (generation !== authorGeneration) return;
      updateHosting(data.hosting);
      for (const sha of commits) {
        authorProfiles.delete(sha);
        authorProfiles.set(sha, {profile: data.profiles?.[sha] || null, until: Date.now() + 300000});
      }
      while (authorProfiles.size > 512) authorProfiles.delete(authorProfiles.keys().next().value);
    } catch {
      if (generation === authorGeneration) commits.forEach(sha => authorProfiles.set(sha, {profile: null, until: Date.now() + 60000}));
    } finally {
      if (generation === authorGeneration) {
        commits.forEach(sha => authorRequests.delete(sha));
        while (authorProfiles.size > 512) authorProfiles.delete(authorProfiles.keys().next().value);
        hydrateAuthors();
      }
    }
  }

  function renderScanningState() {
    updateScanProgress({phase: 'initializing', message: 'Connecting to analysis stream…'});
    hideSlowNote();
    armSlowNoteTimer();
    renderView();
  }

  // Slow-scan reassurance, shown two ways: immediately when the engine
  // reports a heavy history (>= 1000 commits), or after 20 quiet seconds
  // for walks whose totals are unknowable up front. Hidden on every fresh
  // scan and once loading finishes.
  let slowNoteTimer = 0;
  function slowNoteText(total) {
    const scope = total > 0 ? `Big history here — ${total} commits. ` : 'Still working here — ';
    return `${scope}Sorry for the wait: this first scan walks everything to build the cache. Afterwards only new commits are read, so future runs take seconds and always include your latest changes.`;
  }
  function updateSlowNote(phase, total) {
    const note = document.getElementById('scan-slow-note');
    if (!note) return;
    if (phase === 'analyzing' && total >= 1000) {
      note.textContent = slowNoteText(total);
      note.hidden = false;
    } else if (phase === 'analyzing' && total > 0) {
      // Known-small history: no apology needed (also clears a timer note
      // if the scan turned out quicker than the 20s tripwire).
      note.hidden = true;
    }
  }
  function hideSlowNote() {
    const note = document.getElementById('scan-slow-note');
    if (note) note.hidden = true;
  }
  function armSlowNoteTimer() {
    clearSlowNoteTimer();
    slowNoteTimer = setTimeout(() => {
      slowNoteTimer = 0;
      if (historyState !== 'loading') return;
      const note = document.getElementById('scan-slow-note');
      if (note && note.hidden) {
        note.textContent = slowNoteText(0);
        note.hidden = false;
      }
    }, 20000);
  }
  function clearSlowNoteTimer() {
    if (slowNoteTimer) { clearTimeout(slowNoteTimer); slowNoteTimer = 0; }
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
    } else if (phase === 'discovering' || phase === 'reading_commits') {
      // Totals are unknowable while git walks: a frozen-looking static bar
      // is worse than none. Shimmer + live counts from the message instead.
      determinate = false;
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
    if (ticker) {
    ticker.textContent = p.detail || '';
    }
    // Friendly slow-scan note: heavy histories (or a scan that simply runs
    // long) explain the wait and the cache payoff, instead of looking stuck.
    updateSlowNote(phase, p.total);
    if (indexTime) indexTime.textContent = determinate ? `Scanning ${pct}% · ${stageName}` : `Scanning · ${stageName}…`;
  }

  function applyLoadedData(data) {
    if (data.schemaVersion !== 1 || !Array.isArray(data.events)) throw new Error('Unsupported history response.');
    allEvents = data.events;
    historyState = 'ready';
    historyError = '';
    clearSlowNoteTimer();
    hideSlowNote();
    calendarCache = null;
    sortedCache = null;
    facetCache.clear();
    repoOwner = data.repoOwner || null;
    repoHost = data.repoHost || '';
    authorGeneration++;
    authorProfiles.clear(); authorRequests.clear(); clearTimeout(authorTimer);
    remoteUrl = safeExternalUrl(data.remoteUrl) || null;
    currentBranch = data.branch || 'main';
    currentRepo = data.repository || '';
    currentPm = data.packageManager || 'npm';
    workspacePackages = data.workspacePackages || {};
    authorsMap = data.authors || {};
    updateHosting(data.hosting);
    headStateData = Array.isArray(data.headState) ? data.headState : [];
    headStateComplete = data.headStateComplete !== false;

    document.getElementById('repo-name').textContent = data.repository || 'repository';
    document.getElementById('branch-name').textContent = data.branch || 'main';
    document.getElementById('pm-pill').textContent = data.packageManager || 'npm';
    document.getElementById('index-time').textContent = 'Indexed ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    historyWarnings = Array.isArray(data.warnings) ? data.warnings : [];
    historyTruncated = Boolean(data.truncated);
    renderNoticesButton();
    updateStats();
    renderView();
  }

  // Scan notices live behind a toolbar button + modal — never as a yellow
  // wall of text above the table. Closed automatically when a clean scan
  // leaves nothing to report.
  let noticesReturnFocus = null;
  function noticesItems() {
    const items = [];
    if (historyTruncated) items.push('History is incomplete: the scan limit was reached.');
    for (const w of historyWarnings) items.push(w);
    return items;
  }
  function renderNoticesButton() {
    const btn = document.getElementById('notices-btn');
    const count = document.getElementById('notices-count');
    const n = noticesItems().length;
    if (count) count.textContent = n > 0 ? String(n) : '';
    if (btn) btn.hidden = n === 0;
    if (n === 0) closeNotices(false);
  }
  function openNotices() {
    const items = noticesItems();
    if (!items.length) return;
    noticesReturnFocus = document.activeElement;
    const list = document.getElementById('notices-list');
    list.innerHTML = items.map((text) => `<li>${noticeHtml(text)}</li>`).join('');
    const sub = document.getElementById('notices-subtitle');
    if (sub) sub.textContent = `${items.length} ${items.length === 1 ? 'notice' : 'notices'} about this scan. History itself is unaffected unless stated.`;
    document.getElementById('notices-overlay').hidden = false;
    const closeBtn = document.getElementById('notices-close');
    if (closeBtn) closeBtn.focus();
  }
  // One notice row, readable: escape first (so markup can never inject),
  // then highlight manifest paths and short commit SHAs. The SHA pattern
  // requires a non-hex boundary on both sides, so it never fires inside
  // 40-char SHAs or long integrity hashes.
  function noticeHtml(text) {
    return escapeHtml(text)
      .replace(/((?:[A-Za-z0-9_@][A-Za-z0-9_@./-]*\/)?(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?))/g, '<span class="notice-path">$1</span>')
      .replace(/(^|[\s(])([0-9a-f]{7})(?![0-9a-f])/g, '$1<span class="notice-sha">$2</span>');
  }
  function closeNotices(restoreFocus = true) {
    const overlay = document.getElementById('notices-overlay');
    if (overlay) overlay.hidden = true;
    if (restoreFocus && noticesReturnFocus && noticesReturnFocus.isConnected !== false) {
      try { noticesReturnFocus.focus(); } catch { /* focus is best-effort */ }
    }
    noticesReturnFocus = null;
  }

  // Only one analysis stream at a time: a refresh during a scan joins
  // the in-flight server scan instead of stacking another one.
  let activeStream = null;

  function closeActiveStream() {
    if (activeStream) {
      try { activeStream.close(); } catch {}
      activeStream = null;
    }
  }

  async function loadData() {
    if (activeStream || (historyState === 'loading' && document.getElementById('refresh-btn').disabled)) return false;
    const syncIcon = document.getElementById('sync-icon');
    const syncButton = document.getElementById('refresh-btn');
    syncButton.disabled = true;
    syncIcon.style.animation = 'spin 1s linear infinite';
    historyState = 'loading';
    historyError = '';
    closeFilterPanel();
    renderScanningState();
    closeActiveStream();
    try {
      if (typeof window.EventSource !== 'undefined') {
        for (let attempt = 0; attempt < 2; attempt++) {
          try { await openAnalysisStream(); return true; }
          catch { /* Retry once, then use the same server scan through fetch. */ }
        }
      }
      const res = await fetch('/api/events');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'History request failed (' + res.status + ').');
      applyLoadedData(data);
      return true;
    } catch (err) {
      historyState = 'error';
      historyError = err.message || 'Failed to load dependency history. Try Sync again.';
      document.getElementById('index-time').textContent = 'Sync failed';
      clearSlowNoteTimer();
      hideSlowNote();
      renderView();
      return false;
    } finally {
      syncIcon.style.animation = '';
      syncButton.disabled = false;
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
    colFilters.action = type;
    refreshColFilterState();
    currentPage = 1;
    document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === type);
    });
    renderView();
  }

  function getFilteredEvents() {
    selectedFilterSets = {packages: new Set(colFilters.packages), changes: new Set(colFilters.changes), authors: new Set(colFilters.authors)};
    const searchQuery = currentSearch.toLowerCase();
    return allEvents.filter(ev => {
    if (currentFilter !== 'all' && ev.type !== currentFilter) return false;
    if (!matchesColFilters(ev)) return false;
    if (currentSearch) {
      const q = searchQuery;
      const matchDate = (ev.date || '').toLowerCase().includes(q);
      const matchPkg = (ev.package || '').toLowerCase().includes(q);
      const matchAuthor = (ev.author || '').toLowerCase().includes(q);
      const matchSha = `${ev.commit || ''} ${ev.commitFull || ''}`.toLowerCase().includes(q);
      const matchMsg = (ev.message || '').toLowerCase().includes(q);
      const matchManifest = (ev.manifest || '').toLowerCase().includes(q);
      const matchTo = (ev.to || '').toLowerCase().includes(q);
      const matchFrom = (ev.from || '').toLowerCase().includes(q);
      const matchDepType = (ev.depType || '').toLowerCase().includes(q);
      if (!matchDate && !matchPkg && !matchAuthor && !matchSha && !matchMsg && !matchManifest && !matchTo && !matchFrom && !matchDepType) return false;
    }
    return true;
    });
  }

  // Per-column datatable filters. Sets (packages/changes/authors) and the
  // date range are empty/off when inactive; selects match exactly.
  // Returns true when the event passes all set columns.
  function eventDateKey(ev) {
    return dayKeyLocal(ev.date) || '';
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
    return ev.source === 'lockfile' ? 'resolved' : 'declared';
  }

  function matchesColFilters(ev) {
    const f = colFilters;
    if ((f.dateFrom || f.dateTo)) {
      const d = eventDateKey(ev);
      if (!d) return false;
      if (f.dateFrom && d < f.dateFrom) return false;
      if (f.dateTo && d > f.dateTo) return false;
    }
    // Action is shared with the toolbar.
    if (f.packages.length > 0 && !selectedFilterSets.packages.has(ev.package || '')) return false;
    if (f.changes.length > 0 && !selectedFilterSets.changes.has(changeKeyOf(ev))) return false;
    if (f.type !== 'all' && typeTagOf(ev) !== f.type) return false;
    if (f.manifest && ev.manifest !== f.manifest) return false;
    if (f.authors.length > 0 && !selectedFilterSets.authors.has(ev.author || '')) return false;
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
  }

  function clearColFilters() {
    colFilters = freshColFilters();
    currentFilter = 'all';
    document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === 'all'));
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
    document.querySelectorAll('.filter-btn').forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.filter === currentFilter)));
    const chips = document.getElementById('active-filters');
    const values = [];
    if (currentFilter !== 'all') values.push(['action', `Action: ${currentFilter}`]);
    if (f.dateFrom || f.dateTo) values.push(['date', `Date: ${f.dateFrom || 'any'} → ${f.dateTo || 'any'}`]);
    for (const [key, title] of [['packages', 'Dependencies'], ['changes', 'Versions'], ['authors', 'Authors']]) {
      if (f[key].length) values.push([key, `${title}: ${f[key].length === 1 ? f[key][0] : f[key].length + ' selected'}`]);
    }
    for (const [key, title] of [['type', 'Source'], ['manifest', 'Manifest'], ['commit', 'Commit']]) {
      if (f[key] && f[key] !== 'all') values.push([key, `${title}: ${f[key]}`]);
    }
    if (chips) {
      chips.hidden = !values.length;
      document.getElementById('filter-chip-list').innerHTML = values.map(([key, label]) => `<button class="filter-chip" data-clear-filter="${key}" aria-label="Clear ${escapeHtml(label)}"><span>${escapeHtml(label)}</span><span aria-hidden="true">×</span></button>`).join('');
    }
    const manifestLabel = document.getElementById('manifest-selected-label');
    if (manifestLabel) { manifestLabel.textContent = f.manifest || 'All manifests'; manifestLabel.title = manifestLabel.textContent; }
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
    // Header icon buttons carry the active state (with unread dot).
    document.querySelectorAll('.col-filter-icon[data-panel]').forEach(btn => {
      btn.classList.toggle('active-filter', colFiltersActiveFor(btn.dataset.panel));
    });
  }

  function colFiltersActiveFor(col) {
    const f = colFilters;
    if (col === 'date') return !!(f.dateFrom || f.dateTo);
    if (col === 'package') return f.packages.length > 0;
    if (col === 'change') return f.changes.length > 0;
    if (col === 'author') return f.authors.length > 0;
    if (col === 'manifest') return f.manifest !== '';
    if (col === 'commit') return f.commit !== '';
    if (col === 'action') return f.action !== 'all';
    if (col === 'type') return f.type !== 'all';
    return false;
  }

  // Rich floating panels for date + multi-select columns. One shared
  // container positioned under the trigger button; closes on outside
  // click or Escape. Placement follows the trigger during scroll/resize.
  let selectedFilterSets = {packages: new Set(), changes: new Set(), authors: new Set()};
  let sortedCache = null;
  const facetCache = new Map();
  let openPanelKind = null;

  let panelAnchor = null;
  let panelPlacement = null;
  let panelPositionFrame = null;
  function closeFilterPanel(restoreFocus = false) {
    const panel = document.getElementById('filter-panel');
    if (panel) { panel.hidden = true; delete panel.dataset.placement; }
    if (panelPositionFrame !== null) cancelAnimationFrame(panelPositionFrame);
    panelPositionFrame = null;
    panelPlacement = null;
    if (panelAnchor) {
      panelAnchor.setAttribute('aria-expanded', 'false');
      if (restoreFocus) panelAnchor.focus({preventScroll: true});
    }
    panelAnchor = null;
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
    const before = n => isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
    const yesterday = before(1);
    const last7 = before(6);
    const last30 = before(29);
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
    if (facetCache.has(kind)) return facetCache.get(kind);
    const counts = new Map();
    for (const ev of allEvents) {
      let key = null;
      if (kind === 'package') key = ev.package || '(unknown)';
      else if (kind === 'author') key = ev.author || 'Unknown';
      else if (kind === 'change') key = changeKeyOf(ev);
      else if (kind === 'manifest') key = ev.manifest || '(unknown)';
      if (key === null) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const values = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    facetCache.set(kind, values);
    return values;
  }

  function openFilterPanel(kind, anchor) {
    const panel = document.getElementById('filter-panel');
    if (!panel) return;
    if (openPanelKind === kind && panelAnchor === anchor) {
      closeFilterPanel();
      return;
    }
    closeFilterPanel();
    openPanelKind = kind;
    panelAnchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    anchor.setAttribute('aria-controls', 'filter-panel');
    panel.setAttribute('aria-label', kind === 'page-size' ? 'Rows per page' : kind === 'filters' ? 'Filter history' : kind === 'calendar-month' ? 'Choose month with changes' : `${kind} filters`);
    if (kind === 'date') renderDatePanel(panel);
    else if (kind === 'manifest') renderManifestPanel(panel);
    else if (kind === 'commit') renderTextPanel(panel, kind);
    else if (kind === 'calendar-month') renderCalendarMonthPanel(panel);
    else if (kind === 'action' || kind === 'type') renderOptionsPanel(panel, kind);
    else if (kind === 'page-size') renderPageSizePanel(panel);
    else if (kind === 'filters') renderFilterMenu(panel);
    else renderMultiPanel(panel, kind);
    // Keep header/actions fixed; only the filter content scrolls.
    const head = panel.querySelector('.filter-panel-head');
    const foot = panel.querySelector('.filter-panel-foot');
    const body = document.createElement('div');
    body.className = 'filter-panel-body';
    for (const child of [...panel.children]) if (child !== head && child !== foot) body.appendChild(child);
    panel.insertBefore(body, foot);
    panel.scrollTop = 0;
    panel.hidden = false;
    positionFilterPanel();
    if (panel.hidden) return;
    const focusTarget = panel.querySelector('input, button');
    if (focusTarget) focusTarget.focus({preventScroll: true});
  }

  function positionFilterPanel() {
    const panel = document.getElementById('filter-panel');
    if (!openPanelKind || panel.hidden) return;
    if (!panelAnchor?.isConnected) { closeFilterPanel(); return; }
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft || 0;
    const viewportTop = viewport?.offsetTop || 0;
    const viewportRight = viewportLeft + (viewport?.width || window.innerWidth);
    const viewportBottom = viewportTop + (viewport?.height || window.innerHeight);
    const footer = document.querySelector('.bottom-status-bar')?.getBoundingClientRect();
    const header = document.querySelector('header')?.getBoundingClientRect();
    const safeLeft = viewportLeft + 12;
    const safeRight = viewportRight - 12;
    const safeTop = Math.max(viewportTop + 12, header && header.bottom > viewportTop && header.top < viewportBottom ? header.bottom + 8 : viewportTop + 12);
    const safeBottom = Math.min(viewportBottom, footer && footer.top > viewportTop && footer.top < viewportBottom ? footer.top : viewportBottom) - 12;
    const rect = panelAnchor.getBoundingClientRect();
    const clip = panelAnchor.closest('.table-responsive')?.getBoundingClientRect();
    if (rect.bottom <= safeTop || rect.top >= safeBottom || rect.right <= safeLeft || rect.left >= safeRight ||
        (clip && (rect.right <= clip.left || rect.left >= clip.right))) { closeFilterPanel(); return; }

    const preferredWidth = openPanelKind === 'date' ? 340 : openPanelKind === 'page-size' ? 160 : 300;
    const heightLimit = openPanelKind === 'date' ? 580 : 400;
    panel.style.width = Math.max(0, Math.min(preferredWidth, safeRight - safeLeft)) + 'px';
    panel.style.maxHeight = Math.max(0, Math.min(heightLimit, safeBottom - safeTop)) + 'px';
    const desiredHeight = panel.getBoundingClientRect().height;
    const below = Math.max(0, safeBottom - rect.bottom - 8);
    const above = Math.max(0, rect.top - safeTop - 8);
    // Preserve the chosen side while there is useful space, including when
    // facet search or validation changes the popup's content height.
    const usefulHeight = Math.min(160, desiredHeight);
    const currentSpace = panelPlacement === 'bottom' ? below : above;
    const otherSpace = panelPlacement === 'bottom' ? above : below;
    if (!panelPlacement || currentSpace < usefulHeight || (desiredHeight > currentSpace && otherSpace > currentSpace + 80)) {
      panelPlacement = desiredHeight <= below || below >= above ? 'bottom' : 'top';
    }
    const availableHeight = panelPlacement === 'bottom' ? below : above;
    if (availableHeight < 80) { closeFilterPanel(); return; }
    panel.style.maxHeight = Math.min(heightLimit, availableHeight) + 'px';
    const bounds = panel.getBoundingClientRect();
    const preferredLeft = rect.left + bounds.width <= safeRight ? rect.left : rect.right - bounds.width;
    panel.style.left = Math.round(Math.max(safeLeft, Math.min(preferredLeft, safeRight - bounds.width))) + 'px';
    panel.style.top = (panelPlacement === 'bottom' ? rect.bottom + 8 : rect.top - bounds.height - 8) + 'px';
    panel.dataset.placement = panelPlacement;
  }

  function scheduleFilterPanelPosition() {
    if (!openPanelKind || panelPositionFrame !== null) return;
    panelPositionFrame = requestAnimationFrame(() => {
      panelPositionFrame = null;
      positionFilterPanel();
    });
  }

  function renderPageSizePanel(panel) {
    panel.innerHTML = `<div class="filter-panel-head">Rows per page</div><div class="filter-panel-list" role="group" aria-label="Rows per page">${PAGE_SIZES.map(n => `<button class="filter-check" data-size="${n}" aria-pressed="${pageSize === n}"><span class="lbl">${n} rows</span>${pageSize === n ? '✓' : ''}</button>`).join('')}</div>`;
    panel.querySelectorAll('[data-size]').forEach(btn => btn.addEventListener('click', () => {
      pageSize = Number(btn.dataset.size);
      currentPage = 1;
      closeFilterPanel(true);
      renderView();
    }));
  }

  function renderFilterMenu(panel) {
    const fields = [['date', 'Date range'], ['action', 'Action'], ['package', 'Dependency'], ['change', 'Version change'], ['type', 'Source'], ['manifest', 'Manifest'], ['author', 'Author'], ['commit', 'Commit']];
    panel.innerHTML = `<div class="filter-panel-head">Filter history</div><div class="filter-panel-list">${fields.map(([kind, label]) => `<button class="filter-check" data-field="${kind}"><span class="lbl">${label}</span><svg class="menu-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg></button>`).join('')}</div>`;
    panel.querySelectorAll('[data-field]').forEach(btn => btn.addEventListener('click', () => openFilterPanel(btn.dataset.field, panelAnchor)));
  }

  function renderDatePanel(panel) {
    let from = colFilters.dateFrom;
    let to = colFilters.dateTo;
    let preset = colFilters.datePreset;
    let selecting = 'from';
    let month = new Date((from || eventDateKey(getSortedEvents()[0] || {}) || isoDay(new Date())) + 'T12:00:00');
    month.setDate(1);
    const presets = datePresets();
    panel.innerHTML = `
      <div class="filter-panel-head">Date range</div>
      <div class="filter-presets">
        ${presets.map(p => `<button class="filter-preset" data-preset="${p.name}">${p.name}</button>`).join('')}
      </div>
      <div class="filter-range">
        <label>From<input type="text" id="filter-date-from" placeholder="YYYY-MM-DD" autocomplete="off" value="${escapeHtml(from)}" aria-label="From date" aria-describedby="date-error"></label>
        <span>–</span>
        <label>To<input type="text" id="filter-date-to" placeholder="YYYY-MM-DD" autocomplete="off" value="${escapeHtml(to)}" aria-label="To date" aria-describedby="date-error"></label>
      </div>
      <div class="date-calendar">
        <div class="date-calendar-nav"><button class="pager-btn" data-month="-1" aria-label="Previous month">‹</button><strong id="date-month-label" aria-live="polite"></strong><button class="pager-btn" data-month="1" aria-label="Next month">›</button></div>
        <div class="date-weekdays" aria-hidden="true">${['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(d => `<span>${d}</span>`).join('')}</div>
        <div class="date-grid" role="group" aria-label="Choose dates"></div>
        <div class="date-hint">Choose a start date, then an end date. Dates use your local timezone.</div>
        <div id="date-error" class="date-error" role="alert"></div>
      </div>
      <div class="filter-panel-foot">
        <button class="pager-btn" data-panel-act="clear">Clear</button>
        <button class="pager-btn apply" data-panel-act="apply">Apply</button>
      </div>`;
    const startInput = panel.querySelector('#filter-date-from');
    const endInput = panel.querySelector('#filter-date-to');
    const error = panel.querySelector('#date-error');
    const grid = panel.querySelector('.date-grid');
    const validDay = value => {
      if (!value) return true;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const d = new Date(value + 'T12:00:00');
      return !isNaN(d.getTime()) && isoDay(d) === value;
    };
    const draw = (focusDay) => {
      panel.querySelector('#date-month-label').textContent = `${MONTHS[month.getMonth()]} ${month.getFullYear()}`;
      const first = new Date(month.getFullYear(), month.getMonth(), 1);
      const offset = first.getDay();
      const focusKey = focusDay || (validDay(from) && from ? from : isoDay(first));
      grid.innerHTML = Array.from({length: 42}, (_, i) => {
        const day = new Date(month.getFullYear(), month.getMonth(), i - offset + 1, 12);
        const key = isoDay(day);
        const outside = day.getMonth() !== month.getMonth();
        const selected = key === from || key === to;
        const inRange = from && to && key > from && key < to;
        return `<button class="date-day${outside ? ' outside' : ''}${selected ? ' selected' : ''}${inRange ? ' in-range' : ''}" data-date="${key}" tabindex="${key === focusKey ? 0 : -1}" aria-label="${day.toLocaleDateString([], {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'})}" aria-pressed="${!!selected}"${key === isoDay(new Date()) ? ' aria-current="date"' : ''}>${day.getDate()}</button>`;
      }).join('');
      // When the selected date is outside the visible month, retain a tab stop.
      if (!grid.querySelector('[tabindex="0"]')) grid.querySelector(`[data-date="${isoDay(first)}"]`).tabIndex = 0;
      panel.querySelectorAll('[data-preset]').forEach(b => b.classList.toggle('current', b.dataset.preset === preset));
      if (focusDay) grid.querySelector(`[data-date="${focusDay}"]`)?.focus();
    };
    const choose = key => {
      error.textContent = '';
      preset = 'custom';
      if (selecting === 'from') { from = key; to = ''; selecting = 'to'; }
      else {
        to = key;
        if (from && to < from) [from, to] = [to, from];
        selecting = 'from';
      }
      startInput.value = from;
      endInput.value = to;
      draw(key);
    };
    grid.addEventListener('click', e => {
      const day = e.target.closest('[data-date]');
      if (day) choose(day.dataset.date);
    });
    grid.addEventListener('keydown', e => {
      const button = e.target.closest('[data-date]');
      if (!button) return;
      const d = new Date(button.dataset.date + 'T12:00:00');
      const delta = {ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7}[e.key];
      if (delta !== undefined) d.setDate(d.getDate() + delta);
      else if (e.key === 'Home') d.setDate(d.getDate() - d.getDay());
      else if (e.key === 'End') d.setDate(d.getDate() + 6 - d.getDay());
      else if (e.key === 'PageUp' || e.key === 'PageDown') {
        const day = d.getDate();
        d.setDate(1);
        d.setMonth(d.getMonth() + (e.key === 'PageUp' ? -1 : 1));
        d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
      } else return;
      e.preventDefault();
      month = new Date(d.getFullYear(), d.getMonth(), 1);
      draw(isoDay(d));
    });

    panel.querySelectorAll('[data-month]').forEach(btn => btn.addEventListener('click', () => {
      month.setMonth(month.getMonth() + Number(btn.dataset.month));
      draw();
    }));
    panel.querySelectorAll('[data-preset]').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = presets.find(x => x.name === btn.dataset.preset);
        if (!p) return;
        from = p.from; to = p.to; preset = p.name; selecting = 'from';
        startInput.value = from; endInput.value = to;
        month = new Date(from + 'T12:00:00'); month.setDate(1);
        draw();
      });
    });
    [startInput, endInput].forEach((input, i) => {
      input.addEventListener('focus', () => { selecting = i === 0 ? 'from' : 'to'; });
      input.addEventListener('input', () => {
        from = startInput.value.trim(); to = endInput.value.trim(); preset = 'custom';
        if (validDay(input.value) && input.value) { month = new Date(input.value + 'T12:00:00'); month.setDate(1); }
        error.textContent = ''; draw();
      });
    });
    panel.querySelector('[data-panel-act="clear"]').addEventListener('click', () => {
      colFilters.dateFrom = '';
      colFilters.dateTo = '';
      colFilters.datePreset = '';
      currentPage = 1;
      refreshColFilterState();
      closeFilterPanel(true);
      renderView();
    });
    panel.querySelector('[data-panel-act="apply"]').addEventListener('click', () => {
      from = startInput.value.trim(); to = endInput.value.trim();
      const invalid = !validDay(from) ? startInput : !validDay(to) ? endInput : null;
      if (invalid) { error.textContent = 'Enter a valid date as YYYY-MM-DD.'; invalid.focus(); return; }
      if (from && to && from > to) { error.textContent = 'End date must be on or after start date.'; endInput.focus(); return; }
      colFilters.dateFrom = from;
      colFilters.dateTo = to;
      colFilters.datePreset = from || to ? preset : '';
      currentPage = 1;
      refreshColFilterState();
      closeFilterPanel(true);
      renderView();
    });
    draw();
  }

  // A manifest is an exact path selection; typing only searches the list.
  function renderManifestPanel(panel) {
    const items = facetValues('manifest');
    panel.innerHTML = `<div class="filter-panel-head">Manifests (${items.length})</div>
      <input class="filter-panel-search" type="text" placeholder="Search manifest paths…" aria-label="Search manifests">
      <div class="filter-panel-list" role="group" aria-label="Manifests"></div>`;
    const list = panel.querySelector('.filter-panel-list');
    const search = panel.querySelector('input');
    const draw = () => {
      const query = search.value.trim().toLowerCase();
      const shown = items.filter(([path]) => path.toLowerCase().includes(query));
      const row = (path, label, count) => `<button class="filter-check" data-manifest="${escapeHtml(path)}" aria-pressed="${colFilters.manifest === path}"><span class="box">✓</span><span class="lbl" title="${escapeHtml(label)}">${escapeHtml(label)}</span><span class="cnt">${count}</span></button>`;
      list.innerHTML = row('', 'All manifests', allEvents.length) + shown.slice(0, 200).map(([path, count]) => row(path, path, count)).join('') +
        (shown.length > 200 ? '<div class="filter-panel-empty">Showing 200 paths. Refine your search.</div>' : shown.length ? '' : '<div class="filter-panel-empty">No matching manifests.</div>');
    };
    search.addEventListener('input', draw);
    list.addEventListener('click', e => {
      const row = e.target.closest('[data-manifest]');
      if (!row) return;
      setColFilter('manifest', row.dataset.manifest);
      closeFilterPanel(true);
      renderView();
    });
    draw();
  }

  // Single-value text panel for commit SHA/prefix.
  function renderTextPanel(panel, kind) {
    const titles = { commit: 'Commit SHA' };
    const current = colFilters[kind] || '';
    panel.innerHTML = `
      <div class="filter-panel-head">${titles[kind]}</div>
      <div style="padding: 0 12px 8px;"><input type="text" class="filter-panel-search" style="margin:0; width:100%;" value="${escapeHtml(current)}" placeholder="Type to filter…" aria-label="${titles[kind]} filter"></div>
      <div class="filter-panel-foot">
        <button class="pager-btn" data-panel-act="clear">Clear</button>
        <button class="pager-btn apply" data-panel-act="apply">Apply</button>
      </div>`;
    const input = panel.querySelector('.filter-panel-search');
    const apply = () => {
      setColFilter(kind, input.value.trim().toLowerCase());
      refreshColFilterState();
      closeFilterPanel(true);
      renderView();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') apply();
      // Escape bubbles to the shared popover handler.
    });
    panel.querySelector('[data-panel-act="clear"]').addEventListener('click', () => {
      setColFilter(kind, '');
      refreshColFilterState();
      closeFilterPanel(true);
      renderView();
    });
    panel.querySelector('[data-panel-act="apply"]').addEventListener('click', apply);
  }

  // Single-choice option panel (action, type). Applies immediately.
  function renderOptionsPanel(panel, kind) {
    const titles = { action: 'Action', type: 'Source' };
    const options = kind === 'action'
      ? [['all', 'All actions'], ['added', '+ Added'], ['updated', '↑ Updated'], ['removed', '− Removed']]
      : [['all', 'All sources'], ['declared', 'Declared · package.json'], ['resolved', 'Resolved · lockfile']];
    let current = kind === 'action' ? currentFilter : colFilters[kind];
    panel.innerHTML = `
      <div class="filter-panel-head">${titles[kind]}</div>
      <div class="filter-panel-list" role="radiogroup" aria-label="${titles[kind]}">
        ${options.map(([value, label]) => `
          <button class="filter-check" data-value="${value}" role="radio" aria-checked="${current === value}">
            <span class="box">${current === value ? '●' : ''}</span>
            <span class="lbl">${label}</span>
          </button>`).join('')}
      </div><div class="filter-panel-foot"><button class="pager-btn" data-panel-act="clear">Clear</button><button class="pager-btn apply" data-panel-act="apply">Apply</button></div>`;
    panel.querySelector('.filter-panel-list').addEventListener('click', (e) => {
      const row = e.target.closest('[data-value]');
      if (!row) return;
      current = row.getAttribute('data-value') || 'all';
      panel.querySelectorAll('[data-value]').forEach(b => {
        const selected = b.dataset.value === current;
        b.setAttribute('aria-checked', String(selected));
        b.querySelector('.box').textContent = selected ? '●' : '';
      });
    });
    const apply = value => {
      if (kind === 'action') setFilter(value);
      else colFilters[kind] = value;
      currentPage = 1;
      refreshColFilterState();
      closeFilterPanel(true);
      renderView();
    };
    panel.querySelector('[data-panel-act="clear"]').addEventListener('click', () => apply('all'));
    panel.querySelector('[data-panel-act="apply"]').addEventListener('click', () => apply(current));
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
      list.innerHTML = shown.slice(0, 200).map(([name, count]) => `
        <button class="filter-check" data-name="${escapeHtml(name)}" aria-checked="${selected.has(name)}" role="checkbox">
          <span class="box">✓</span>
          <span class="lbl" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
          <span class="cnt">${count}</span>
        </button>`).join('') + (shown.length > 200 ? '<div class="filter-panel-empty">Showing 200 results. Refine your search to find more.</div>' : '');
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
      colFilters[stateKey] = [];
      currentPage = 1;
      closeFilterPanel(true);
      renderView();
    });
    panel.querySelector('[data-panel-act="apply"]').addEventListener('click', () => {
      colFilters[stateKey] = selected.size === items.length ? [] : Array.from(selected);
      currentPage = 1;
      refreshColFilterState();
      closeFilterPanel(true);
      renderView();
    });
  }

  function getSortedEvents() {
    const key = JSON.stringify([currentFilter, currentSearch, colFilters, sortField, sortAsc]);
    if (sortedCache?.key === key && sortedCache.source === allEvents) return sortedCache.events;
    const events = getFilteredEvents();
    events.sort((a, b) => {
    let valA = a[sortField] || '';
    let valB = b[sortField] || '';
    if (sortField === 'date') {
      valA = eventTime(a);
      valB = eventTime(b);
    }
    if (valA < valB) return sortAsc ? -1 : 1;
    if (valA > valB) return sortAsc ? 1 : -1;
    return 0;
    });
    sortedCache = {key, source: allEvents, events};
    return events;
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
    renderView();
  }

  function emptyHistoryMarkup() {
    const emptyRepo = allEvents.length === 0;
    return `<svg class="empty-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.35-4.35"></path></svg>
      <div class="empty-title">${emptyRepo ? 'This repository has no dependency events yet' : 'No events matching your filter or search query'}</div>
      <div class="empty-subtitle">${emptyRepo ? 'Commit a package.json change and rescan to start the timeline.' : 'Try adjusting your filters or clearing your search query.'}</div>
      ${emptyRepo ? '' : '<button class="btn-action" data-action="reset-filters">Reset filters</button>'}`;
  }

  function renderView() {
    refreshColFilterState();
    const ready = historyState === 'ready';
    document.querySelector('.content-card').setAttribute('aria-busy', String(historyState === 'loading'));
    document.getElementById('calendar-filters-btn').hidden = currentView !== 'calendar';
    document.getElementById('history-status').hidden = ready;
    document.getElementById('scan-progress-box').hidden = historyState !== 'loading';
    document.getElementById('history-load-error').hidden = historyState !== 'error';
    document.getElementById('history-error-message').textContent = historyError;
    document.getElementById('timeline-view').style.display = ready && currentView === 'timeline' ? 'block' : 'none';
    document.getElementById('calendar-view').classList.toggle('active', ready && currentView === 'calendar');
    document.getElementById('pager').hidden = !ready || currentView !== 'timeline';
    if (!ready) return;
    if (currentView === 'timeline') renderTable();
    else renderCalendar();
  }

  function renderTable() {
    if (historyState !== 'ready') { renderView(); return; }
    const tbody = document.getElementById('events-tbody');
    const filtered = getSortedEvents();

    if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">${emptyHistoryMarkup()}</td></tr>`;
    renderPager(0, 0, 0);
    return;
    }

    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * pageSize;
    const page = filtered.slice(start, start + pageSize);

    tbody.innerHTML = page.map(ev => {
    const dateStr = eventDateKey(ev);
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

    const authorInfo = getAuthorDetails(ev.author, ev.commitFull);
    const authorInitial = (authorInfo.name || 'U')[0].toUpperCase();
    const isResolved = ev.source === 'lockfile';
    const typeBadge = '<span class="dep-type-tag' + (isResolved ? '' : ' direct') + '" title="' + escapeHtml((ev.depTypeFrom ? ev.depTypeFrom + ' → ' : '') + (ev.depType || '') + (ev.lockfile ? ' · ' + ev.lockfile : '')) + '">' + (isResolved ? 'resolved' : 'declared') + '</span>';

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
        <div class="author-cell-link" data-author-entry title="Git author: ${escapeHtml(authorInfo.name)}">
        <div class="author-avatar-wrapper" data-author-commit="${escapeHtml(ev.commitFull || ev.commit)}">
          <div class="author-avatar-fallback" style="display: flex;">${escapeHtml(authorInitial)}</div>
        </div>
        <div class="author-meta">
          ${renderAuthorName(ev.author, ev.commitFull || ev.commit)}

        </div>
        </div>
      </td>
      <td>
        <button class="commit-tag" data-commit="${escapeHtml(ev.commit)}" data-full="${escapeHtml(ev.commitFull || ev.commit)}" title="${escapeHtml(ev.message || '')} (${remoteUrl ? 'open in repository' : 'click to copy'})">
        ${escapeHtml(ev.commit)}
        </button>
      </td>
      </tr>
    `;
    }).join('');
    renderPager(filtered.length, start, totalPages);
    hydrateAuthors();
    document.getElementById('timeline-view').scrollTop = 0;
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
    if (sizeSel) sizeSel.innerHTML = '<span>' + pageSize + '</span>' + DOWN_CHEVRON;
    if (total <= pageSize) {
      pager.hidden = currentView !== 'timeline' || total === 0;
      if (info) info.textContent = total === 0 ? 'Showing 0 events' : `Showing all ${total} events`;
      if (numbers) numbers.innerHTML = '';
      if (first) first.disabled = true;
      if (prev) prev.disabled = true;
      if (next) next.disabled = true;
      if (last) last.disabled = true;
      return;
    }
    pager.hidden = currentView !== 'timeline';
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
        const link = commitUrl(full);
        if (link) window.open(link, '_blank', 'noopener,noreferrer');
        else copyText(full, 'Commit SHA copied!');
        return;
      }
      const action = e.target.closest('[data-action="reset-filters"]');
      if (action && tbody.contains(action)) resetFilters();
    });
  }

  let calendarYear = new Date().getFullYear();
  let calendarMonth = new Date().getMonth();
  let calendarInitialized = false;
  let calendarCache = null;

  // Build month/day buckets once for each filtered result, then reuse them
  // while navigating. No full-history scan on each previous/next click.
  function calendarActivity() {
    const events = getSortedEvents();
    if (calendarCache?.source === events) return calendarCache;
    const buckets = new Map();
    for (const ev of events) {
      const dayKey = eventDateKey(ev);
      if (!dayKey) continue;
      const key = dayKey.slice(0, 7);
      if (!buckets.has(key)) buckets.set(key, {days: new Map(), count: 0, added: 0, updated: 0, removed: 0});
      const bucket = buckets.get(key), day = Number(dayKey.slice(8));
      if (!bucket.days.has(day)) bucket.days.set(day, []);
      bucket.days.get(day).push(ev);
      bucket.count++;
      bucket[ev.type] = (bucket[ev.type] || 0) + 1;
    }
    calendarCache = {source: events, buckets, months: [...buckets.keys()].sort()};
    return calendarCache;
  }

  function calendarKey() { return calendarYear + '-' + String(calendarMonth + 1).padStart(2, '0'); }
  function monthLabel(key) { return MONTHS[Number(key.slice(5)) - 1] + ' ' + key.slice(0, 4); }
  function selectCalendarMonth(key) {
    calendarYear = Number(key.slice(0,4)); calendarMonth = Number(key.slice(5)) - 1;
    calendarInitialized = true;
    renderCalendar();
  }
  function moveCalendar(offset) {
    if (historyState !== 'ready') return;
    const months = calendarActivity().months;
    const next = months[months.indexOf(calendarKey()) + offset];
    if (next) selectCalendarMonth(next);
  }
  function renderCalendarMonthPanel(panel) {
    const activity = calendarActivity();
    const months = [...activity.months].reverse();
    panel.innerHTML = '<div class="filter-panel-head">Months with changes</div><input class="filter-panel-search" type="text" aria-label="Search months" placeholder="Search month or year…"><div class="filter-panel-list" role="group" aria-label="Months with changes"></div>';
    const input = panel.querySelector('input'), list = panel.querySelector('.filter-panel-list');
    const draw = () => {
      const query = input.value.trim().toLowerCase();
      const shown = months.filter(key => (monthLabel(key) + ' ' + key).toLowerCase().includes(query));
      list.innerHTML = shown.slice(0,200).map(key => `<button class="filter-check" data-calendar-month="${key}" aria-pressed="${key === calendarKey()}"><span class="box">✓</span><span class="lbl">${monthLabel(key)}</span><span class="cnt">${activity.buckets.get(key).count}</span></button>`).join('') +
        (shown.length > 200 ? '<div class="filter-panel-empty">Showing 200 months. Refine your search.</div>' : shown.length ? '' : '<div class="filter-panel-empty">No matching months.</div>');
    };
    input.addEventListener('input', draw);
    list.addEventListener('click', e => {
      const row = e.target.closest('[data-calendar-month]');
      if (!row) return;
      closeFilterPanel(true);
      selectCalendarMonth(row.dataset.calendarMonth);
    });
    draw();
  }

  function renderCalendar() {
    if (historyState !== 'ready') { renderView(); return; }
    const grid = document.getElementById('calendar-days-grid');
    const titleElem = document.getElementById('calendar-month-title');
    const statsElem = document.getElementById('calendar-month-stats');
    const activity = calendarActivity();
    const empty = activity.months.length === 0;
    document.querySelector('.calendar-topbar').hidden = empty;
    document.querySelector('.calendar-frame').hidden = empty;
    document.getElementById('calendar-empty').hidden = !empty;
    if (empty) {
      grid.innerHTML = '';
      document.getElementById('calendar-empty').innerHTML = emptyHistoryMarkup();
      return;
    }
    if (!calendarInitialized || !activity.buckets.has(calendarKey())) {
      const latest = activity.months.at(-1);
      calendarYear = Number(latest.slice(0,4)); calendarMonth = Number(latest.slice(5)) - 1;
      calendarInitialized = true;
    }
    const ymPrefix = calendarKey();
    titleElem.textContent = monthLabel(ymPrefix);
    const index = activity.months.indexOf(ymPrefix);
    const prev = document.getElementById('cal-prev-btn'), next = document.getElementById('cal-next-btn');
    prev.disabled = index === 0; next.disabled = index === activity.months.length - 1;
    prev.title = prev.disabled ? 'No earlier changes' : 'Previous changes: ' + monthLabel(activity.months[index - 1]);
    next.title = next.disabled ? 'No later changes' : 'Next changes: ' + monthLabel(activity.months[index + 1]);
    document.getElementById('cal-today-btn').disabled = next.disabled;
    const bucket = activity.buckets.get(ymPrefix), dayEventMap = bucket.days;
    statsElem.textContent = bucket.count + (bucket.count === 1 ? ' change · ' : ' changes · ') + bucket.added + ' added, ' + bucket.updated + ' updated, ' + bucket.removed + ' removed';

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
      <div class="calendar-day-box ${isToday ? 'today' : ''} ${dayEvents.length > 0 ? 'has-events' : ''}" data-day="${dayStr}" title="${d} ${MONTHS[calendarMonth]}: ${dayEvents.length} change(s). Click to view day timeline.">
      <button class="day-box-header day-open-btn" ${dayEvents.length ? '' : 'disabled'} aria-label="${d} ${MONTHS[calendarMonth]} ${calendarYear}: ${dayEvents.length} changes. View day history.">
        <span class="day-number">${d}</span>
        ${countBadge}
      </button>
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
      if (day && day.classList.contains('has-events') && grid.contains(day)) filterByDay(day.getAttribute('data-day') || '');
    });

  }

  function filterByDay(dayStr) {
    colFilters.dateFrom = dayStr;
    colFilters.dateTo = dayStr;
    colFilters.datePreset = 'custom';
    currentPage = 1;
    refreshColFilterState();
    switchToTimeline();
  }

  function resetFilters() {
    clearTimeout(searchTimer);
    currentFilter = 'all';
    currentSearch = '';
    closeFilterPanel();
    clearColFilters();
    currentPage = 1;
    document.getElementById('search-input').value = '';
    document.getElementById('search-clear').style.display = 'none';

    document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === 'all');
    });
    renderView();
  }

  // Archaeology Drawer
  // Groups one package's events into per-commit lifecycle nodes (same
  // semantics as the CLI renderer): a rollout in ten workspaces is one
  // lifecycle step, not twenty rows. Render-only; allEvents stays complete.
  function groupLifecycleNodes(pkgEvents) {
    const nodes = [], byCommit = new Map();
    const keyOf = ch => JSON.stringify([ch.type, ch.from, ch.to, ch.depType, ch.depTypeFrom, ch.changeOrigin]);
    for (const ev of pkgEvents) {
      const key = ev.commitFull || ev.commit;
      let node = byCommit.get(key);
      if (!node) {
        node = { commit: ev.commit, commitFull: ev.commitFull, date: ev.date, author: ev.author, message: ev.message, manifests: [], files: [], declared: [], resolved: [], headline: ev.type, isMerge: false, metadataKnown: false };
        byCommit.set(key, node);
        nodes.push(node);
      }
      node.isMerge ||= (ev.commitParents?.length || 0) > 1 || ev.changeOrigin === 'merge-integration' || ev.changeOrigin === 'merge-change';
      node.metadataKnown ||= Array.isArray(ev.commitParents) || !!ev.changeOrigin;
      const file = ev.lockfile || ev.manifest;
      if (file && !node.files.includes(file)) node.files.push(file);
      if (ev.manifest && !node.manifests.includes(ev.manifest)) node.manifests.push(ev.manifest);
      const list = ev.source === 'lockfile' ? node.resolved : node.declared;
      const k = keyOf(ev);
      let ch = list.find(c => c.k === k);
      if (!ch) {
        ch = { k, type: ev.type, from: ev.from, to: ev.to, depType: ev.depType, depTypeFrom: ev.depTypeFrom, changeOrigin: ev.changeOrigin, manifests: [] };
        list.push(ch);
      }
      if (ev.manifest && !ch.manifests.includes(ev.manifest)) ch.manifests.push(ev.manifest);
    }
    for (const node of nodes) {
      const types = new Set([...node.declared, ...node.resolved].map(ch => ch.type));
      node.headline = types.size === 1 ? [...types][0] : 'mixed';
      const changes = [...node.declared, ...node.resolved];
      node.changeOrigin = node.isMerge
        ? (changes.every(ch => ch.changeOrigin === 'merge-integration') ? 'merge-integration' : 'merge-change')
        : (node.metadataKnown ? 'direct' : undefined);
    }
    return nodes.sort((a, b) => { const diff = Date.parse(a.date) - Date.parse(b.date); return Number.isFinite(diff) ? diff : 0; });
  }

  function lifecycleNodeTitle(node) {
    if (node.isMerge) {
      if (node.changeOrigin !== 'merge-integration') return 'Merge dependency changes';
      return node.headline === 'added' ? 'Merged existing dependency'
        : node.headline === 'updated' ? 'Merged dependency update'
        : node.headline === 'removed' ? 'Merged dependency removal' : 'Merged dependency changes';
    }
    return node.headline === 'added' ? 'Added dependency' : node.headline === 'updated' ? 'Updated dependency'
      : node.headline === 'removed' ? 'Removed dependency' : 'Dependency changes';
  }

  function lifecycleAction(ch) {
    if (ch.changeOrigin === 'merge-integration') return ch.type === 'added' ? 'Merged existing version'
      : ch.type === 'updated' ? 'Merged update' : 'Merged removal';
    return ch.type === 'added' ? 'Added version' : ch.type === 'updated' ? 'Updated' : 'Removed dependency';
  }

  function openArchaeology(pkgName) {
    drawerReturnFocus = document.activeElement;
    selectedPkgName = pkgName;
    const pkgEvents = allEvents.filter(e => e.package === pkgName);
    if (pkgEvents.length === 0) return;
    const lifecycleNodes = groupLifecycleNodes(pkgEvents);

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
      const targetUrl = pkgRelDir ? treeUrl(currentBranch || 'main', pkgRelDir) : cleanRemote;
      pkgLink.href = targetUrl;
      pkgLink.title = `View package directory (${pkgRelDir || 'root'}) on ${hosting.label}`;
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
    } else {
    statusBadge.className = 'drawer-status-pill removed';
    if (statusText) statusText.textContent = headStateComplete ? 'Not declared at HEAD' : 'HEAD status unknown · unreadable manifest';
    }

    // Deptype badge
    const depTypeElem = document.getElementById('drawer-deptype');
    if (depTypeElem) {
    depTypeElem.textContent = headEntries.length ? [...new Set(headEntries.map(h => h.depType))].join(', ') : latest.depType || 'dependencies';
    }

    // Manifest summary
    const manifestElem = document.getElementById('drawer-manifest-summary');
    if (manifestElem) {
    const files = [...new Set(pkgEvents.map(e => e.lockfile || e.manifest).filter(Boolean))];
    manifestElem.textContent = `${files.length} evidence ${files.length === 1 ? 'file' : 'files'}`;
    manifestElem.title = files.join(', ');
    }

    // Stats strip
    const changesCountElem = document.getElementById('drawer-changes-count');
    if (changesCountElem) {
    changesCountElem.textContent = `${lifecycleNodes.length} ${lifecycleNodes.length === 1 ? 'commit' : 'commits'}`;
    document.getElementById('drawer-evidence-count').textContent = `${pkgEvents.length} file ${pkgEvents.length === 1 ? 'event' : 'events'}`;
    }
    const direct = lifecycleNodes.filter(n => n.changeOrigin === 'direct').length;
    const unknown = lifecycleNodes.filter(n => !n.metadataKnown).length;
    const integrations = lifecycleNodes.filter(n => n.changeOrigin === 'merge-integration').length;
    const otherMerges = lifecycleNodes.length - direct - integrations - unknown;
    document.getElementById('drawer-history-summary').textContent = [
      direct ? `${direct} direct ${direct === 1 ? 'change' : 'changes'}` : '',
      integrations ? `${integrations} merge ${integrations === 1 ? 'integration' : 'integrations'}` : '',
      otherMerges ? `${otherMerges} other merge ${otherMerges === 1 ? 'change' : 'changes'}` : '',
      unknown ? `${unknown} ${unknown === 1 ? 'commit' : 'commits'} without merge metadata` : ''
    ].filter(Boolean).join(' · ');
    const note = document.getElementById('drawer-history-note');
    const hasMerges = integrations + otherMerges > 0;
    note.hidden = !hasMerges && !historyTruncated && !historyWarnings.length;
    note.textContent = [hasMerges ? 'Includes merged branches. Integration entries show existing changes brought into the receiving history.' : '',
      historyTruncated || historyWarnings.length ? 'Scan warnings may affect the first recorded date.' : ''].filter(Boolean).join(' ');

    const firstDateElem = document.getElementById('drawer-first-date');
    if (firstDateElem) {
    firstDateElem.textContent = eventDateKey(lifecycleNodes[0]);
    document.getElementById('drawer-first-author').textContent = `${lifecycleNodes[0].isMerge ? 'Merge author' : 'Commit author'}: ${lifecycleNodes[0].author || 'Unknown'}`;
    }

    const authorsCountElem = document.getElementById('drawer-authors-count');
    if (authorsCountElem) {
    const authors = new Set(lifecycleNodes.map(e => e.author).filter(Boolean));
    authorsCountElem.textContent = `${authors.size} ${authors.size === 1 ? 'author' : 'authors'}`;
    }

    const timeline = document.getElementById('drawer-timeline');
    const changeHtml = ch => {
      const action = lifecycleAction(ch);
      const v = ch.type === 'added' ? `${action} <span style="color: var(--color-added)">${escapeHtml(ch.to || '')}</span>`
        : ch.type === 'removed' ? `${action} (was ${escapeHtml(ch.from || '')})`
        : `${action} ${escapeHtml(ch.from || '')} &rarr; <span style="color: var(--color-updated)">${escapeHtml(ch.to || '')}</span>`;
      const move = ch.depTypeFrom && ch.depTypeFrom !== ch.depType ? ` · ${escapeHtml(ch.depTypeFrom)} → ${escapeHtml(ch.depType)}` : '';
      const section = ch.depType && ch.depType !== 'dependencies' ? ` <span style="color: var(--color-text-secondary)">(${escapeHtml(ch.depType)})</span>` : '';
      return `${v}${move}${section}`;
    };
    const groupHtml = (label, changes) => changes.length ? changes.map(ch =>
      `<div class="node-version"><span style="color: var(--color-text-secondary)">${label}:</span> ${changeHtml(ch)} <span style="font-family: var(--font-mono); color: var(--color-text-secondary)">[${ch.manifests.map(escapeHtml).join(', ')}]</span></div>`
    ).join('') : '';
    timeline.innerHTML = lifecycleNodes.map(node => {
    const symbol = node.headline === 'added' ? '+' : node.headline === 'removed' ? '–' : node.headline === 'mixed' ? '±' : '↑';
    const authorInfo = getAuthorDetails(node.author, node.commitFull);
    const authorInitial = (authorInfo.name || 'U')[0].toUpperCase();
    const sources = [node.declared.length ? 'Declared' : '', node.resolved.length ? 'Resolved' : ''].filter(Boolean).join(' + ') || 'Recorded';

    return `
      <div class="timeline-node ${node.isMerge ? 'merge' : node.headline}">
      <div class="node-icon" aria-hidden="true">${node.isMerge ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="5" r="3"/><circle cx="18" cy="5" r="3"/><circle cx="6" cy="19" r="3"/><path d="M6 8v8M18 8a8 8 0 0 1-8 8H6"/></svg>' : symbol}</div>
      <div class="node-card">
        <div class="node-meta">
        <span>${eventDateKey(node)}</span>
        <button class="commit-tag" data-commit="${escapeHtml(node.commit)}" data-full="${escapeHtml(node.commitFull || node.commit)}" title="${escapeHtml(node.message || '')} (${remoteUrl ? 'open in repository' : 'click to copy'})">${escapeHtml(node.commit)}</button>
        </div>
        <div class="node-heading">${lifecycleNodeTitle(node)}</div>
        ${groupHtml('Declared', node.declared)}${groupHtml('Resolved', node.resolved)}
        <div class="node-msg">${escapeHtml(node.message || 'No commit message')}</div>
        <div data-author-entry class="node-author">
        <div class="author-avatar-wrapper" data-author-commit="${escapeHtml(node.commitFull || node.commit)}" style="width: 18px; height: 18px;">
          <div class="author-avatar-fallback" style="font-size: 9px; display: flex;">${escapeHtml(authorInitial)}</div>
        </div>
        <span>${node.isMerge ? 'Merged by' : 'Commit by'} ${renderAuthorName(node.author, node.commitFull || node.commit)} <span class="node-evidence">· ${sources} · ${node.files.length} evidence ${node.files.length === 1 ? 'file' : 'files'}</span></span>
        </div>
      </div>
      </div>
    `;
    }).join('');

    document.getElementById('drawer-overlay').classList.add('active');
    initTimelineDelegation();
    hydrateAuthors();
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
        const link = commitUrl(full);
        if (link) window.open(link, '_blank', 'noopener,noreferrer');
        else copyText(full, 'Commit SHA copied!');
      }
    });
  }

  function closeArchaeology() {
    document.getElementById('drawer-overlay').classList.remove('active');
    selectedPkgName = null;
    if (drawerReturnFocus?.isConnected) drawerReturnFocus.focus({preventScroll: true});
    drawerReturnFocus = null;
  }

  function copyText(text, msg = 'Copied to clipboard!') {
    if (!navigator.clipboard) { showToast('Clipboard is unavailable in this browser'); return; }
    navigator.clipboard.writeText(text).then(() => {
    showToast(msg);
    }).catch(() => showToast('Clipboard permission was denied'));
  }

  function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  }

  function safeExternalUrl(value) {
    if (!value) return '';
    try {
      const u = new URL(value);
      return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href.replace(/\/$/, '') : '';
    } catch { return ''; }
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
  const eventTimes = new WeakMap();
  function eventTime(ev) {
    if (!eventTimes.has(ev)) eventTimes.set(ev, Date.parse(ev.date) || 0);
    return eventTimes.get(ev);
  }
  function latestEvent(events) {
    let latest = null;
    for (const ev of events) if (!latest || eventTime(ev) > eventTime(latest)) latest = ev;
    return latest;
  }

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
    closeFilterPanel();
    currentView = 'timeline';
    document.getElementById('view-timeline-btn').setAttribute('aria-pressed', 'true');
    document.getElementById('view-calendar-btn').setAttribute('aria-pressed', 'false');
    document.getElementById('view-timeline-btn').classList.add('active');
    document.getElementById('view-calendar-btn').classList.remove('active');
    document.getElementById('timeline-view').style.display = 'block';
    document.getElementById('calendar-view').classList.remove('active');
    renderView();
  }

  function switchToCalendar() {
    if (currentView === 'calendar') return;
    closeFilterPanel();
    document.getElementById('pager').hidden = true;
    currentView = 'calendar';
    document.getElementById('view-calendar-btn').setAttribute('aria-pressed', 'true');
    document.getElementById('view-timeline-btn').setAttribute('aria-pressed', 'false');
    document.getElementById('view-calendar-btn').classList.add('active');
    document.getElementById('view-timeline-btn').classList.remove('active');
    document.getElementById('timeline-view').style.display = 'none';
    document.getElementById('calendar-view').classList.add('active');
    renderView();
  }

  // View toggles
  document.getElementById('view-timeline-btn').addEventListener('click', switchToTimeline);
  document.getElementById('view-calendar-btn').addEventListener('click', switchToCalendar);

  // Skip months without matching events; the month picker jumps directly.
  document.getElementById('cal-prev-btn').addEventListener('click', () => moveCalendar(-1));
  document.getElementById('cal-next-btn').addEventListener('click', () => moveCalendar(1));
  document.getElementById('cal-today-btn').addEventListener('click', () => {
    const latest = calendarActivity().months.at(-1);
    if (latest) selectCalendarMonth(latest);
  });
  document.querySelector('.calendar-nav-group').addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault(); moveCalendar(e.key === 'ArrowLeft' ? -1 : 1);
    }
  });
  document.getElementById('calendar-empty').addEventListener('click', e => {
    if (e.target.closest('[data-action="reset-filters"]')) resetFilters();
  });

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

  // Pager: full controls — first/prev/numbered/next/last + page size.
  // The footer is fixed below the rows-only scroll region.
  function pagerTotalPages() {
    const total = getSortedEvents().length;
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
  if (pagerSize) pagerSize.addEventListener('click', () => openFilterPanel('page-size', pagerSize));

  // Per-column datatable filters (debounced text, immediate selects).
  // Date/package/change/author columns open rich floating panels instead.
  document.querySelectorAll('button[data-panel]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openFilterPanel(btn.dataset.panel, btn);
    });
  });
  // Re-rendering a calendar/menu can detach the clicked node before the document handler runs.
  document.getElementById('filter-panel').addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', (e) => {
    const panel = document.getElementById('filter-panel');
    if (panel && !panel.hidden && !panel.contains(e.target) && !e.target.closest('button[data-panel], #pager-size')) {
      closeFilterPanel();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openPanelKind) { e.preventDefault(); closeFilterPanel(true); }
    if (e.key === 'Tab' && openPanelKind) {
      const panel = document.getElementById('filter-panel');
      const items = [...panel.querySelectorAll('button:not([disabled]), input')].filter(el => el.tabIndex >= 0);
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  });
  window.addEventListener('resize', scheduleFilterPanelPosition, {passive: true});
  window.addEventListener('scroll', scheduleFilterPanelPosition, {passive: true});
  window.visualViewport?.addEventListener('resize', scheduleFilterPanelPosition, {passive: true});
  window.visualViewport?.addEventListener('scroll', scheduleFilterPanelPosition, {passive: true});
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(scheduleFilterPanelPosition).observe(document.getElementById('filter-panel'));
  }
  const tableScroll = document.querySelector('.table-responsive');
  if (tableScroll) tableScroll.addEventListener('scroll', scheduleFilterPanelPosition, {passive: true});
  const colClearBtn = document.getElementById('col-filter-clear');
  if (colClearBtn) colClearBtn.addEventListener('click', () => {
    clearColFilters();
    refreshColFilterState();
    renderView();
    document.getElementById(currentView === 'calendar' ? 'calendar-filters-btn' : 'manifest-dropdown-btn').focus({preventScroll: true});
  });

  document.getElementById('active-filters').addEventListener('click', e => {
    const key = e.target.closest('[data-clear-filter]')?.dataset.clearFilter;
    if (!key) return;
    if (key === 'action') { currentFilter = 'all'; colFilters.action = 'all'; }
    else if (key === 'date') { colFilters.dateFrom = ''; colFilters.dateTo = ''; colFilters.datePreset = ''; }
    else colFilters[key] = Array.isArray(colFilters[key]) ? [] : key === 'type' ? 'all' : '';
    document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === currentFilter));
    currentPage = 1;
    renderView();
    (document.querySelector('#active-filters button') || document.getElementById(currentView === 'calendar' ? 'calendar-filters-btn' : 'manifest-dropdown-btn')).focus({preventScroll: true});
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
    clearTimeout(searchTimer);
    currentPage = 1;
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
    if (openPanelKind || e.defaultPrevented) return;
    const noticesOverlay = document.getElementById('notices-overlay');
    if (noticesOverlay && !noticesOverlay.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeNotices(); }
      return;
    }
    if (document.getElementById('drawer-overlay').classList.contains('active')) {
      if (e.key === 'Escape') { e.preventDefault(); closeArchaeology(); }
      if (e.key === 'Tab') {
        const items = [...document.querySelectorAll('.drawer button:not([disabled]), .drawer a[href]')].filter(el => el.getClientRects().length && el.tabIndex >= 0);
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
      return;
    }
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

  // Notices modal events
  document.getElementById('notices-btn').addEventListener('click', openNotices);
  document.getElementById('notices-close').addEventListener('click', () => closeNotices());
  document.getElementById('notices-overlay').addEventListener('click', (e) => {
    if (e.target && e.target.id === 'notices-overlay') closeNotices();
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
    clearTimeout(searchTimer);
    currentPage = 1;
    colFilters.packages = [pkg];
    currentSearch = '';
    searchInput.value = '';
    document.getElementById('search-clear').style.display = 'none';
    switchToTimeline();
    renderView();
    showToast(`Filtered table by "${pkg}"`);
  });

  // Copy Markdown Summary for drawer
  document.getElementById('drawer-copy-md').addEventListener('click', () => {
    if (!selectedPkgName) return;
    const pkgEvents = allEvents.filter(e => e.package === selectedPkgName);
    const mdCell = value => String(value ?? '-').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/`/g, '\\`');
    let md = `### Dependency history: ${mdCell(selectedPkgName)}\n\n`;
    if (historyTruncated || historyWarnings.length) md += 'History contains scan warnings; consult the JSON export for details.\n\n';
    const nodes = groupLifecycleNodes(pkgEvents);
    md += `${nodes.length} commits · ${pkgEvents.length} file events · ${nodes.filter(n => n.isMerge).length} merge commits. Dates include changes from merged branches.\n\n`;
    md += `| Date | Action | Context | Source | Manifest | From | To | Commit | Author role | Commit author |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
    // One row per commit per distinct change (manifests joined): the same
    // grouping as the drawer timeline, so a ten-workspace rollout is two
    // rows (declared + resolved), not twenty. Full fidelity stays in JSON.
    for (const node of nodes) {
    const d = eventDateKey(node);
    for (const [source, changes] of [['manifest', node.declared], ['lockfile', node.resolved]]) {
      for (const ch of changes) {
        const context = ch.changeOrigin === 'merge-integration' ? 'Merge integration' : node.isMerge ? 'Merge change' : node.metadataKnown ? 'Direct commit' : 'Merge status unknown';
        md += `| ${[d, ch.type, context, source, ch.manifests.join(', '), ch.from, ch.to, node.commitFull || node.commit, node.isMerge ? 'Merge author' : 'Commit author', node.author].map(mdCell).join(' | ')} |\n`;
      }
    }
    }
    copyText(md, `Copied ${selectedPkgName} markdown changelog!`);
  });

  // Export JSON
  document.getElementById('export-json-btn').addEventListener('click', () => {
    const dataStr = URL.createObjectURL(new Blob([JSON.stringify({schemaVersion: 1, repository: currentRepo, branch: currentBranch, headStateComplete, warnings: historyWarnings, truncated: historyTruncated, events: getSortedEvents()}, null, 2)], {type: 'application/json'}));
    const a = document.createElement('a');
    a.setAttribute('href', dataStr);
    a.setAttribute('download', `dep-blame-${document.getElementById('repo-name').textContent || 'export'}.json`);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(dataStr), 1000);
    showToast('Exported matching history as JSON');
  });

  // Sync button
  document.getElementById('refresh-btn').addEventListener('click', async () => {
    if (await loadData()) showToast('History synced with git repository');
  });

  initTheme();
  initTableDelegation();
  initCalendarDelegation();
  loadData();
