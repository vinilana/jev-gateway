---
name: jev-gateway-conventions
description: Conventions and style of the jev-gateway repository. Use before writing or reviewing anything here - code in src/, bin/ or test/, a commit message, a pull request title or description, README / CHANGELOG / docs prose, a workflow, or a release. Covers Conventional Commits and how they drive release-please, the invariants a change must not break, TypeScript and test idioms, comment style, and the voice of the documentation.
---

# jev-gateway conventions

jev-gateway is a local gateway between a coding agent and its LLM provider. It handles the user's
credentials and conversations, so the rules below are stricter about safety than about taste.
Procedures live in `CONTRIBUTING.md` and `docs/releasing.md`; this file is the short version of
how things are done, to apply while working. When one of those documents and this file disagree,
the document wins, and this file should be fixed.

There is no formatter and no linter. The style is kept by reading the code around an edit and
matching it. Do that first, every time.

## Invariants: never break these

1. **Fail open.** Jev slow, down, unsure, or a request the gateway does not understand: forward it
   untouched as `passthrough` with a `reason`. The gateway may make an agent cheaper; it must never
   make one fail. New code paths that can throw while handling a request need a passthrough
   fallback. Throwing is for startup (`loadConfig`), where a bad setting should stop the process.
2. **Credentials and conversations stay put.** Listen on loopback by default. Never write a
   forwarded credential anywhere; the only stored secret is the user's own Jev key, written by
   `bin/setup.mjs` to a file only they can read. Prompts reach disk only through opt-in debug
   dumps, which redact headers loosely on purpose. Nothing but request metadata reaches the
   dashboard: build what the browser sees field by field (`events.ts`), never by spreading a log
   entry.
3. **Never write the client's own configuration.** Launchers point a client at the gateway with
   arguments and environment for that one process. Nothing under `~/.codex`, `~/.claude`,
   `~/.config/opencode`, `~/.kiro` is modified.
4. **Keep prompt caches valid.** If rewriting a request would invalidate a cached prefix, add a
   hint after the client's last block instead (`hint` mode).
5. **Few dependencies.** The runtime dependencies fit on one line of `package.json`. Prefer twenty
   lines of code to another.
6. **Tests need no keys and no network.** Everything external is injected (`askJev`, `fetch`).

## Commits and pull request titles

Conventional Commits, because release-please derives the version and `CHANGELOG.md` from them.
The pull request title always reaches the changelog: as the commit when squashed (preferred), or
through the merge commit's body. A merge commit also brings the branch's own commits onto `main`,
and each conventional one gets a changelog line too, so they need the same care as the title.

```
<type>[(scope)][!]: <what changes for the user, imperative, lower case, no full stop>
```

- `feat` = users can do something new or must do something differently: minor bump, "Added".
- `fix` = something wrong is now right: patch bump, "Fixed".
- `perf` = same behaviour, cheaper: patch bump, "Changed".
- `docs`, `test`, `refactor`, `build`, `ci`, `chore`, `style` = no release, not in the changelog.
- `!` (`feat!:`) when users must change something to keep working. While `0.x` that is a minor bump.
- Scope is optional and names the part: `brew`, `opencode`, `gemini`, `kiro`, `dashboard`, `readme`.

The subject becomes a changelog line, so write it for a user of the gateway, not a reader of the
diff: `fix: read token usage from streams that send no content-type`, not
`fix: handle missing header in readUsage`. The body says why, when the diff does not.

Pick the type by what the user notices, not by which files changed: a README-only change is
`docs`, a refactor that also fixes a bug is `fix`. A commit with no type is invisible to the
release.

Never hand-edit `version` in `package.json`, `.release-please-manifest.json`, or add a section to
`CHANGELOG.md` in an ordinary change. No tool or AI attribution in commits or pull requests: no
`Co-Authored-By` trailers, no "Generated with" lines.

## Releases

Merging the `chore(main): release X.Y.Z` pull request that release-please maintains is the whole
release: tag, GitHub release, npm through trusted publishing, Homebrew. Do not push tags by hand.
Details and recovery steps: `docs/releasing.md`.

Two constraints on `.github/workflows/`:

- `npm publish` stays in `release.yml`, in that file, under that name. npm's trusted publisher
  matches the workflow file name, and release-please lives in the same file because a tag created
  with `GITHUB_TOKEN` starts no other workflow.
- Actions are pinned to a full commit hash with the version in a trailing comment
  (`uses: actions/checkout@3d3c42e... # v7.0.1`). Workflows get `permissions: contents: read` at
  the top and ask for more per job. Untrusted values reach `run:` scripts through `env:`, never
  through `${{ }}` inside the script.

## Code

**Layout.** TypeScript in `src/` and `test/`. Plain ES modules (`.mjs`, JSDoc types) in `bin/` and
`scripts/`, so launchers run from a checkout or an install without a build. One wire format per
file in `src/adapters/`, all implementing `Adapter`. The gateway reads its environment in
`src/config.ts` and nowhere else in `src/`, and every setting is listed in `.env.example`.
Launcher-only settings (ports, per-client upstreams) are read in `bin/`.

**TypeScript.**
- `strict` and `noUncheckedIndexedAccess` are on. No `any` in `src/` (tests may use it for wire
  bodies). Narrow `unknown` and index access instead of asserting.
- Relative imports carry the `.js` extension. Types come in with `import type` or inline
  `type` specifiers. Node built-ins use the `node:` prefix.
- Named exports only. No default exports, no classes, no enums: functions, interfaces, and
  discriminated unions on a literal field (`Decision` is a union on `mode`).
- `function` declarations for the named steps of a module, arrow functions for small helpers and
  callbacks. Early returns over nesting; a run of one-line guards is the house style:
  `if (input.tools.length === 0) return "no_tools";`
- Reasons and modes are `snake_case` string literals (`"no_tools"`, `"upstream_rejected_forced"`)
  because they end up in logs and headers. Everything else is `camelCase`; module-level constants
  are `UPPER_SNAKE`.
- Absence is `undefined`, and "nothing to report" is `undefined`, not zeros. `null` appears only
  where a provider's wire format requires it.
- An empty `catch {}` is acceptable only where failing open is the point, and then it is obvious
  from context or says so in a comment.
- Formatting: two spaces, double quotes, semicolons, trailing commas in multi-line literals, lines
  up to about 140 columns. Numeric separators for large numbers (`60_000`).

**Comments** say why, never what. They are full sentences, often stating the constraint or the
incident behind the code: "Hop-by-hop and length/encoding headers must not cross the proxy: fetch
re-frames bodies, so the originals would be wrong." Exported things and non-obvious fields get a
`/** */` line; reasoning inside a body uses `//`. No commented-out code, no `TODO` without a
reason, no banner comments. If a comment would restate the next line, leave it out.

**Errors the user sees** name the setting and the value: `JEV_ON_NONE must be "force_none" or
"passthrough", got "x"`.

## Tests

vitest, in `test/<area>.test.ts`. Build the app with `createApp({ config, askJev, fetch })` and
drive it with `app.request(...)`; no ports, no timers beyond `settled()`. Use `fakeJev`,
`fakeUpstream` and `testConfig` from `test/helpers.ts`. `fakeJev` throws on a question it has no
canned answer for, which is how a test pins down what Jev is asked.

Test names are sentences about behaviour, not method names: `it("reports nothing rather than
zeros when the reply never said")`. A fix comes with a test that fails without it. A feature
covers each mode it touches, and streaming when the format streams.

## Prose: README, CHANGELOG, docs, pull requests

- Plain, short, declarative sentences, for someone who uses the gateway. Say what happens and what
  to do about it. Lead with the point: "Merging the release pull request publishes it."
- Be exact about limits and about what was not verified: "Unit-tested, not yet run against the
  real API." "Five runs per cell is a small sample." Never round a caveat away.
- No emoji, no exclamation marks, no marketing adjectives (powerful, seamless, blazing), no
  "simply" or "just".
- Give the reason with the rule. Most sections in `docs/` end by explaining why it is built that
  way.
- Tables for anything with a symptom/cause/fix or option/meaning shape. Commands in fenced `bash`
  blocks, runnable as written. Identifiers, flags, paths and env vars in backticks.
- Bold sparingly, for the one phrase a skimming reader must not miss.
- Sentence-case headings. Wrap prose near 100 columns; tables and URLs may run long.
- Changelog entries describe the change from the user's side and what they must do, and credit
  outside contributors: `Thanks to @someone (#12).`

When behaviour, a flag or a setting changes, the same change updates the README, and
`.env.example` for settings. Documentation that is true only after something else happens says so.

## Before calling a change done

```bash
pnpm typecheck && pnpm test && pnpm build
npm pack --dry-run      # when files were added that must ship: check `files` in package.json
```

All four run in CI on Node 22.15 and 24. After editing gateway code, a launcher keeps serving the
old code until `pnpm <client> --stop`.
