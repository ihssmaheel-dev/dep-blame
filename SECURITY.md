# Security Policy

`dep-blame` is a local history-analysis tool. Its threat model centers on **untrusted repository content** (commit messages, author names, paths, versions) rendered in terminals and browsers, and on a **loopback dashboard** that must never become a network attack surface.

## Supported versions

| Version | Supported |
|---|---|
| `dep-blame` / `@dep-blame/ui` latest `0.1.x` | Yes |
| Older releases | No — please upgrade; pre-1.0 APIs and cache schemas change between minors |

Cache schema is currently **v4**. Older caches are migrated (cleared and rescanned), never served as if current.

## Reporting a vulnerability

**Do not open a public issue for security reports.**

- Report privately: open a [GitHub Security Advisory](https://github.com/ihssmaheel-dev/dep-blame/security/advisories/new) (preferred), or contact the maintainers through the repository's listed contact.
- Include: affected package and version, environment (OS, Node version), a minimal reproduction (fixture repo or request sequence), and the impact you see.
- You will receive an acknowledgment within **3 business days** and a fix-or-mitigation plan once triaged. Please allow **90 days** for coordinated disclosure before publishing details.

## Scope and guarantees

What the project commits to:

- **Terminal output** neutralizes control sequences and spreadsheet formulas; untrusted fields never execute.
- **Dashboard** binds loopback by default (LAN binds require `DEP_BLAME_ALLOW_LAN=1`), rejects spoofed `Host` / cross-site `Origin` / `Sec-Fetch-Site: cross-site`, serves a CSP with no inline-script allowance and no inline event handlers, and keeps emails and tokens out of browser payloads.
- **Avatar/forge enrichment** is server-side only, DNS-pinned, HTTPS-only for tokens, redirect-limited, size-capped (1 MiB responses / 512 KiB images), with private-network origins requiring explicit opt-in. SVG avatars are rejected.
- **Dependencies:** `npm audit` is run during reviews (0 known vulns at last audit, including dev dependencies). The core CLI keeps zero required runtime dependencies to minimize supply-chain surface.

What this policy does **not** cover:

- Vulnerabilities in users' own repositories surfaced *through* history analysis (that is the tool's job, not a defect).
- Misconfigured LAN exposure (`DEP_BLAME_ALLOW_LAN=1` on untrusted networks, leaked forge tokens) — the dashboard serves repository history with no authentication by design and must stay on trusted interfaces.
- Custom CAs / private forge TLS: configure trust via Node's `NODE_EXTRA_CA_CERTS`; never disable certificate verification.

## Out of scope

- Social engineering, physical access, or compromised user machines.
- Denial of service via intentionally pathological multi-gigabyte repositories (size caps return errors; resource-exhaustion tuning is ongoing work, tracked as bounded-query milestones).
- Third-party hosting APIs (GitHub, GitLab, Gitea/Forgejo, Bitbucket) themselves — report those to the respective vendor.

## Hardening history

The `dep-blame.md` audit log (§12) records the security fixes already shipped: output sanitization, CSV formula neutralization, strict Host/Origin validation, SSRF pinning, avatar proxying, and tarball hygiene. New security-relevant changes should extend the test net in `test/ui.test.js`, `test/forge.test.js`, and `test/review.test.js` rather than relying on manual checks.
