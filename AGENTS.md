# nekcode Development

This file contains shared repository guidance, not a user's personal agent configuration.

## Project

- nekcode is a TypeScript monorepo for the `nek` terminal coding agent.
- Application code is in `packages/coding-agent/`; terminal interfaces are in `packages/tui/` and `packages/opentui/`.
- The Chinese user manual is in `site/docs/`.

## Changes

- Read the affected code before editing and keep changes scoped to the requested task.
- Follow surrounding conventions, use top-level imports, and keep TypeScript compatible with Node's strip-only mode.
- Add or update focused regression tests when behavior changes.
- Do not modify generated model files directly; update their generator instead.

## Verification

- Install dependencies with `npm ci --ignore-scripts`.
- Run `npm run check` after code changes.
- Run focused tests from their package directory; use `./test.sh` for non-e2e tests.
- Do not call real provider APIs from tests.

## Privacy and Git

- Keep credentials, personal settings, local instructions, and custom subagent presets outside version control.
- Store personal configuration in `~/.nek/agent/`. Use an ignored `AGENTS.override.md` for local repository instructions.
- Public examples must use placeholders or application defaults, not private providers, endpoints, or machine paths.
- Preserve unrelated changes. Stage explicit paths and never force-push.
- Commit or push only when requested.
