function shouldDisableColor(): boolean {
  if (typeof process === 'undefined') return false;
  if (process.env.NO_COLOR && process.env.NO_COLOR !== '0' && process.env.NO_COLOR !== '') return true;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0' && process.env.FORCE_COLOR !== '') return false;
  // Check TTY dynamically: piped output, CI, and test runners disable color.
  try {
    if (process.env.CI === 'true' && !process.env.FORCE_COLOR) return true;
    if (!process.stdout || !process.stdout.isTTY) return true;
  } catch {
    return true;
  }
  return false;
}

// Evaluated per call (not cached at import) so NO_COLOR / piping changes
// after import are respected, and tests stay deterministic.
const wrap = (open: number, close: number) => (s: string | number) =>
  shouldDisableColor() ? String(s) : `\x1b[${open}m${s}\x1b[${close}m`;

export const c = {
  green: wrap(32, 39),
  red: wrap(31, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
  magenta: wrap(35, 39),
  dim: wrap(2, 22),
  bold: wrap(1, 22),
  strip: (s: string | number) => String(s).replace(/\x1b\[[0-9;]*m/g, '')
};

/**
 * Strips terminal control characters (CSI/OSC/bells, ASCII controls)
 * from untrusted git/manifest data so a hostile commit message or
 * version string can't manipulate terminal output. Newlines and tabs
 * are collapsed to spaces since table cells are single-line.
 */
export function stripControl(s: string | number | undefined | null): string {
  if (s === undefined || s === null) return '';
  return String(s)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/[\r\n\t]+/g, ' ');
}
