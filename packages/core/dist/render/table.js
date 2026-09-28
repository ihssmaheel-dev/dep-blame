import { c } from './ansi.js';
function formatDate(isoString) {
    if (!isoString)
        return '';
    return isoString.split('T')[0] || isoString.slice(0, 10);
}
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
 */
export function renderEventTable(events, options = {}) {
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
        if (pkg.length > maxPkg)
            maxPkg = pkg.length;
        if (change.length > maxChange)
            maxChange = change.length;
        if (author.length > maxAuthor)
            maxAuthor = author.length;
    }
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
    // Group by commit for collapsing bulk updates
    const commitGroups = [];
    let currentGroup = [];
    let currentCommit = null;
    for (const ev of events) {
        if (ev.commit !== currentCommit) {
            if (currentGroup.length > 0) {
                commitGroups.push(currentGroup);
            }
            currentGroup = [ev];
            currentCommit = ev.commit;
        }
        else {
            currentGroup.push(ev);
        }
    }
    if (currentGroup.length > 0) {
        commitGroups.push(currentGroup);
    }
    const renderSingleRow = (ev) => {
        const date = formatDate(ev.date);
        const type = formatType(ev.type);
        const pkg = ev.package;
        const change = formatChange(ev);
        const author = ev.author || '';
        const commit = ev.commit || '';
        const message = ev.message || '';
        const pkgTruncated = pkg.length > maxPkg ? pkg.slice(0, maxPkg - 1) + '…' : pkg;
        const changeTruncated = change.length > maxChange ? change.slice(0, maxChange - 1) + '…' : change;
        const authorTruncated = author.length > maxAuthor ? author.slice(0, maxAuthor - 1) + '…' : author;
        return [
            c.dim(date.padEnd(10)),
            type,
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
            const commit = first.commit;
            const count = group.length;
            const distinctManifests = new Set(group.map((e) => e.manifest)).size;
            const summaryMsg = `${count} packages updated across ${distinctManifests} manifest(s) [use --verbose to expand]`;
            const collapsedLine = [
                c.dim(date.padEnd(10)),
                c.yellow('⚡ collapsed'),
                c.bold(summaryMsg.padEnd(maxPkg + maxChange + 2)),
                c.dim((first.author || '').slice(0, maxAuthor).padEnd(maxAuthor)),
                c.cyan(commit.padEnd(7)),
                c.dim(first.message || '')
            ].join('  ');
            lines.push(collapsedLine);
        }
        else {
            for (const ev of group) {
                lines.push(renderSingleRow(ev));
            }
        }
    }
    lines.push('');
    lines.push(c.dim(`Total events: ${events.length}`));
    return lines.join('\n');
}
//# sourceMappingURL=table.js.map