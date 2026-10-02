#!/usr/bin/env node

// `dep-blame-ui` is a convenience alias for `dep-blame ui`, shipped in the
// same single `dep-blame` package (no separate download). It prepends the
// `ui` subcommand and delegates to the main CLI so flags stay identical:
// `dep-blame-ui --port 4321` === `dep-blame ui --port 4321`.
process.argv.splice(2, 0, 'ui');

await import('./cli.js');
