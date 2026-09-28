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
