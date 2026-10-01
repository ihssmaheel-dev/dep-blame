## What changed and why

<!-- Focused description. Link issues: Fixes #123 -->

## How it was tested

- [ ] `npm run build` clean
- [ ] New/updated fixture tests (real git repos, not mocked `git log`)
- [ ] `npm test` green locally (or relevant subset noted below)

```text
# paste relevant test output
```

## Docs updated

- [ ] `README.md` / package READMEs (behavior, flags, endpoints, limits)
- [ ] `CHANGELOG.md` under Unreleased
- [ ] `dep-blame.md` audit notes (contracts, guarantees, deferred work)

## Reviewer checklist

- [ ] Zero required runtime dependencies preserved in `packages/core`
- [ ] Relative ESM imports use explicit `.js` extensions
- [ ] Corrupt/missing input warns (never invents events); dates compare by instant
- [ ] Terminal/CSV/HTML output sanitized; no inline handlers; Host/Origin checks intact
- [ ] No secrets, tokens, or private emails in the diff
