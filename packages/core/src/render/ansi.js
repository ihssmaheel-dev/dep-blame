/**
 * Zero-dependency ANSI color helpers respecting NO_COLOR and TTY status.
 */
function shouldDisableColor() {
  if (typeof process === 'undefined') return false;
  if (process.env.NO_COLOR && process.env.NO_COLOR !== '0') return true;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return false;
  return !process.stdout || !process.stdout.isTTY;
}

const isColorDisabled = shouldDisableColor();

const wrap = (open, close) => (s) => (isColorDisabled ? String(s) : `\x1b[${open}m${s}\x1b[${close}m`);

export const c = {
  green: wrap(32, 39),
  red: wrap(31, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
  dim: wrap(2, 22),
  bold: wrap(1, 22),
  strip: (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '')
};
