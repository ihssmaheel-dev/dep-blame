import { c } from './ansi.js';
const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];
function groupEventsByMonth(events) {
    const map = new Map();
    for (const ev of events) {
        if (!ev.date)
            continue;
        const key = ev.date.slice(0, 7); // "YYYY-MM"
        if (!map.has(key)) {
            map.set(key, []);
        }
        map.get(key).push(ev);
    }
    return map;
}
function renderMonthGrid(year, month, monthEvents) {
    const dayMap = new Map();
    for (const ev of monthEvents) {
        const day = parseInt(ev.date.slice(8, 10), 10);
        if (!dayMap.has(day)) {
            dayMap.set(day, []);
        }
        dayMap.get(day).push(ev);
    }
    const title = `${MONTH_NAMES[month]} ${year}`;
    const header = ' Su Mo Tu We Th Fr Sa';
    const lines = [
        c.bold(title),
        c.dim('─────────────────────'),
        c.bold(header)
    ];
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    let currentLine = ' '.repeat(firstDay * 3);
    let dayOfWeek = firstDay;
    for (let d = 1; d <= daysInMonth; d++) {
        const hasEvents = dayMap.has(d);
        const dayStr = String(d).padStart(2);
        if (hasEvents) {
            currentLine += ' ' + c.bold(c.green(dayStr));
        }
        else {
            currentLine += ' ' + c.dim(dayStr);
        }
        dayOfWeek++;
        if (dayOfWeek === 7) {
            lines.push(currentLine);
            currentLine = '';
            dayOfWeek = 0;
        }
    }
    if (currentLine.length > 0) {
        lines.push(currentLine);
    }
    // Legend of activity for the month
    if (dayMap.size > 0) {
        lines.push('');
        lines.push(c.dim('Activity:'));
        const sortedDays = Array.from(dayMap.keys()).sort((a, b) => a - b);
        for (const d of sortedDays) {
            const evs = dayMap.get(d);
            const pkgSummary = evs
                .map((e) => {
                const sign = e.type === 'added' ? '+' : e.type === 'removed' ? '-' : '↑';
                return `${sign}${e.package}`;
            })
                .slice(0, 4)
                .join(', ');
            const overflow = evs.length > 4 ? ` (+${evs.length - 4} more)` : '';
            lines.push(`  ${c.green('●')} ${c.bold(String(d).padStart(2))}th: ${evs.length} event(s) — ${c.dim(pkgSummary + overflow)}`);
        }
    }
    return lines.join('\n');
}
/**
 * Renders the terminal calendar visualization grid.
 */
export function renderCalendarView(events) {
    if (!events || events.length === 0) {
        return c.dim('No dependency events to display on calendar.');
    }
    const grouped = groupEventsByMonth(events);
    const months = Array.from(grouped.keys()).sort();
    const output = [];
    output.push(c.bold('Dependency Change Calendar'));
    output.push(c.dim(`Found ${events.length} event(s) across ${months.length} active month(s)\n`));
    // Render recent active months
    const recentMonths = months.slice(-6);
    for (const ym of recentMonths) {
        const [yearStr, monthStr] = ym.split('-');
        const year = parseInt(yearStr, 10);
        const month = parseInt(monthStr, 10) - 1;
        const monthEvents = grouped.get(ym) || [];
        output.push(renderMonthGrid(year, month, monthEvents));
        output.push('\n' + c.dim('· · · · · · · · · · · · · · · · · · · ·') + '\n');
    }
    return output.join('\n');
}
//# sourceMappingURL=calendar.js.map