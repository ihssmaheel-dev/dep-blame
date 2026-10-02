/**
 * Probes whether the optional `yaml` dependency is installed.
 *
 * Mirrors the resolution of the lazy `await import('yaml')` in the
 * pnpm/yarn lockfile parsers, so tests can branch between full parsing
 * assertions and the documented `--omit=optional` fallback contract
 * (null parser result → low-fidelity `(lockfile)` event + install hint).
 * Used by the CI `json-fallback` job, which runs the suite without
 * optional dependencies.
 */
export async function isYamlAvailable() {
  try {
    await import('yaml');
    return true;
  } catch {
    return false;
  }
}
