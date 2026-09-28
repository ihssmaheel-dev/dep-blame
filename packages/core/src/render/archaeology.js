import { c } from './ansi.js';

/**
 * Formats a date string to YYYY-MM-DD.
 */
function formatDate(isoString) {
  if (!isoString) return '';
  return isoString.split('T')[0] || isoString.slice(0, 10);
}

/**
 * Renders the package archaeology lifecycle view.
 *
 * @param {string} packageName
 * @param {import('../diff/snapshot-diff.js').DependencyEvent[]} events
 * @returns {string}
 */
export function renderArchaeologyView(packageName, events) {
  const pkgEvents = events.filter((e) => e.package === packageName);

  if (pkgEvents.length === 0) {
    return [
      c.bold(`Archaeology for `) + c.cyan(packageName),
      c.dim(`No change events found for package "${packageName}".`)
    ].join('\n\n');
  }

  const latestEvent = pkgEvents[pkgEvents.length - 1];
  let statusBanner = '';

  if (latestEvent.type === 'removed') {
    statusBanner = c.red(`● Currently removed`) + c.dim(` (last active in ${latestEvent.commit})`);
  } else {
    statusBanner =
      c.green(`● Active`) +
      c.bold(` ${latestEvent.to || ''}`) +
      c.dim(` (${latestEvent.depType || 'dependencies'} in ${latestEvent.manifest})`);
  }

  const lines = [
    c.bold(`Archaeology for `) + c.bold(c.cyan(packageName)),
    `Status: ${statusBanner}`,
    `Total modifications: ${c.bold(pkgEvents.length)}`,
    '',
    c.dim('Timeline (chronological order):'),
    c.dim('──────────────────────────────────────────────────────────────────')
  ];

  for (let i = 0; i < pkgEvents.length; i++) {
    const ev = pkgEvents[i];
    const isLast = i === pkgEvents.length - 1;
    const date = formatDate(ev.date);

    let typeStr = '';
    let changeStr = '';

    if (ev.type === 'added') {
      typeStr = c.green('+ added  ');
      changeStr = c.bold(ev.to || '');
    } else if (ev.type === 'updated') {
      typeStr = c.yellow('↑ updated');
      changeStr = `${ev.from || '?'} -> ${c.bold(ev.to || '?')}`;
    } else if (ev.type === 'removed') {
      typeStr = c.red('- removed');
      changeStr = c.dim(`was ${ev.from || 'installed'}`);
    }

    const nodeSymbol = ev.type === 'added' ? c.green('●') : ev.type === 'removed' ? c.red('●') : c.yellow('●');

    lines.push(
      `${nodeSymbol}  ${c.dim(date)}  ${typeStr}  ${changeStr.padEnd(24)}  ${c.cyan(ev.commit)}  ${c.dim(ev.author)}`
    );
    lines.push(`   ${c.dim('↳ ' + (ev.message || 'no commit message'))}`);

    if (!isLast) {
      lines.push(c.dim('│'));
    }
  }

  return lines.join('\n');
}
