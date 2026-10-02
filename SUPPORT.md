# Support

## Where to ask

- **Bugs and feature requests:** [GitHub Issues](https://github.com/ihssmaheel-dev/dep-blame/issues) — use the Bug report / Feature request templates.
- **Questions and ideas:** open an issue with the `question` label.
- **Security issues:** private report only — see [SECURITY.md](./SECURITY.md).

Response times are best-effort; maintainers acknowledge new issues as capacity allows. Well-scoped reports with reproductions get attention first.

## Before opening an issue

1. Update to the latest `dep-blame` and retry.
2. Search existing issues for duplicates.
3. For empty or wrong results, check [Troubleshooting](./README.md#troubleshooting) first — shallow clones (`fetch-depth: 1`) are the most common cause.

## What to include

**CLI / engine reports:**

```text
- OS + Node version (`node --version`, `git --version`)
- Package manager + lockfile(s) present
- Exact command and flags
- Full terminal output (warnings included)
- `npx dep-blame list --json` excerpt showing the problem
- Minimal reproduction: smallest commit sequence or fixture repo that triggers it
```

**Dashboard / server reports:**

```text
- OS + Node version + browser + viewport size
- How the server was started (flags, env vars like DEP_BLAME_FORGE_*)
- Failing endpoint + status code (e.g. GET /api/events/paged → 500)
- Server console output and browser console errors
- Whether DEP_BLAME_AVATARS=0 changes the behavior
```

## What is not supported

- Private repository contents — please reduce to a minimal public or synthetic fixture before sharing.
- Registry, vulnerability, or upgrade advice — `dep-blame` reads history; it is not an updater or scanner.
- Third-party hosting APIs themselves — report GitHub/GitLab/forge outages to the vendor.

## Commercial / SLA support

There is no paid support tier. Production users should pin versions, keep the incremental cache on persistent storage, and monitor the [Changelog](./CHANGELOG.md) for cache-schema migrations (currently v4).
