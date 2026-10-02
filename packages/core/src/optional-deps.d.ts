/**
 * Ambient types for the OPTIONAL `yaml` dependency (see `optionalDependencies`
 * in packages/core/package.json).
 *
 * The pnpm/yarn lockfile parsers load it lazily via `await import('yaml')`
 * and degrade to low-fidelity events when it is absent
 * (`npm install --omit=optional`). This declaration lets `tsc` compile
 * without the package on disk — including the CI `json-fallback` job,
 * which builds before testing the fallback. It is fallback-only: when
 * `yaml` IS installed, its real bundled types resolve first.
 *
 * Keep this surface minimal and in sync with actual usage
 * (`yaml.parse(content)` in manifest/lockfiles/pnpm.ts and yarn.ts).
 */
declare module 'yaml' {
  export function parse(text: string): any;
  const yaml: { parse(text: string): any };
  export default yaml;
}
