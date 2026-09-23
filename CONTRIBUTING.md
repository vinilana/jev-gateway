# Contributing to jev-gateway

Bug reports, fixes, new clients and new wire formats are all welcome. OpenCode support, the Gemini
adapter and the Homebrew automation each arrived as a pull request from outside.

For what the gateway does and why, read [How it works](README.md#how-it-works) first. This guide
covers how to work on it.

## Setup

You need Node.js 22.15 or newer and [pnpm](https://pnpm.io) (the exact version is pinned in
`package.json`; `corepack enable` picks it up).

```bash
git clone https://github.com/vinilana/jev-gateway.git
cd jev-gateway
pnpm install
pnpm test         # no keys and no network needed
```

## The checks

CI runs these on every pull request and every push to `main`, on Node 22.15 (the oldest supported)
and Node 24 (what releases are built with). Run them before you push:

```bash
pnpm typecheck    # tsc, strict, with noUncheckedIndexedAccess
pnpm test         # vitest
pnpm build        # compiles src/ to dist/ and copies dashboard.html beside it
npm pack --dry-run   # lists the files that would be published
```

`npm pack --dry-run` matters when you add a file that must ship: only what `files` in
`package.json` names reaches users.

## Running your changes

**As a server.** `pnpm dev` runs `src/index.ts` with reload on save, on http://localhost:8787. It
reads `.env` from the checkout: `cp .env.example .env` and set a key for Jev (`TYPESAFE_API_KEY`,
or another provider's: see [Where Jev runs](README.md#where-jev-runs)).
[`POST /router/decide`](README.md#try-a-decision-without-calling-any-llm) shows what Jev decides
for a request without calling any LLM.

**Through a launcher.** `pnpm codex`, `pnpm claude`, `pnpm opencode`, `pnpm gemini` and `pnpm kiro` run the
launchers in `bin/`. In a checkout they start the gateway from the TypeScript sources, so there
is no build step. With no key for Jev configured, the first run asks for one, exactly as an
installed launcher does. The gateway keeps running in the background between sessions, which
means it also keeps running your old code: after an edit, restart it.

```bash
pnpm codex --stop       # the next launch starts a gateway with your changes
pnpm codex --logs       # follow routing decisions, in a second terminal
```

**Without a TypeSafe key.** `scripts/mock-jev.mjs` stands in for Jev, so a real agent can be
driven end to end against a real provider:

```bash
MOCK_JEV_SCRIPT=exec_command,no_tool_needed node scripts/mock-jev.mjs &
TYPESAFE_BASE_URL=http://127.0.0.1:8799 TYPESAFE_API_KEY=mock pnpm codex exec "list the files here"
```

`MOCK_JEV_SCRIPT` is the tool to pick on each successive request (the last one repeats).
`MOCK_JEV_CONFIDENCE` and `MOCK_JEV_ARG_CERTAINTY` move the answers above or below the gateway's
thresholds, to reach `passthrough` or `direct` mode on purpose.

**To see what a client really sends.** Set `JEV_DEBUG_DUMP_DIR` to a folder and every routed
request is written there, with credentials redacted. For undocumented backends this is the only
reliable specification. Dumps hold whole conversations: keep them out of commits and issues.

## Where things live

```
src/index.ts          entry point: config, the Jev transport, the HTTP server
src/app.ts            routes, auth, headers, and the resend-on-rejection fallback
src/adapters/         one file per wire format: chat.ts, responses.ts (Codex),
                      messages.ts (Claude Code), gemini.ts, kiro.ts; adapter.ts is the interface
src/state.ts          turns a conversation into Jev state
src/questions.ts      turns tools into Jev questions and finds closed-set arguments
src/decide.ts         the mode decision
src/jev.ts            the call to Jev, for TypeSafe, OpenRouter or Vercel
src/providers.json    the provider table, shared by jev.ts and the launchers' setup
src/upstream.ts       streaming reverse proxy
src/usage.ts          token usage read from a reply, normalised across providers
src/events.ts         recent request metadata kept in memory and restored from the log
src/dashboard.ts      serves /dashboard (dashboard.html is the whole page, no build step)
src/config.ts         every environment variable, with its default
bin/                  launchers: launcher.mjs is shared, clients.mjs describes each client,
                      setup.mjs is the first-run setup
scripts/mock-jev.mjs  local stand-in for Jev
test/                 vitest suites; helpers.ts has the fakes
docs/                 releasing.md, homebrew-tap.md
```

A request flows through them in this order: `app.ts` picks the adapter for the path, the adapter
turns the request into a neutral `RouterInput`, `decide.ts` asks Jev (through `jev.ts`) and returns
a `Decision`, and
the adapter either rewrites the request for `upstream.ts` to forward or builds the answer itself.

## What must stay true

The gateway sits between a coding agent and its provider and handles the user's credentials and
conversations. A change that breaks one of these will not be merged, however useful it is
otherwise.

- **Fail open.** When Jev is slow, down, unsure, or the request is something the gateway does not
  understand, the request goes to the provider untouched (`passthrough`). The gateway may make an
  agent cheaper; it must never make one stop working.
- **Credentials and conversations stay put.** The gateway listens on loopback by default.
  The credentials it forwards to a provider are never written anywhere, and prompts only to
  debug dumps, which are opt-in and redact anything that looks like a secret. The one secret the
  project stores is the user's own key for Jev, saved by the setup they run, in a file only they
  can read. The dashboard shows request metadata only: a log
  line for a `direct` decision holds the tool's arguments, so `events.ts` builds each dashboard
  row field by field instead of passing log entries to the browser.
- **The client's own configuration is never written.** Launchers point a client at the gateway
  through arguments and environment variables for that one process. Nothing in `~/.codex`,
  `~/.claude`, `~/.config/opencode` or `~/.kiro` is modified. (`jev-kiro` gives Kiro a home of
  its own instead, because Kiro reads its endpoint from nowhere else.)
- **Prompt caches survive.** Where rewriting a request would invalidate a cached prefix, the
  gateway adds a hint after the client's last block instead (`hint` mode).
- **Few dependencies.** The published package has a handful. A new one needs a reason a few lines of
  code cannot match.

## Tests

Tests need no keys and make no network calls. `test/helpers.ts` has what makes that possible:

- `fakeJev(canned)` answers Jev's questions from a table and records what it was asked. It throws
  when asked a question it has no answer for, so a test also pins down *which* questions are sent.
- `fakeUpstream(reply)` stands in for the provider and records what was forwarded to it.
- `testConfig(overrides)` is the default configuration with a test upstream.

`createApp({ config, askJev, fetch })` takes all three, and `app.request(...)` drives it without
opening a port; `test/router.test.ts` is the model to copy. A fix comes with a test that fails
without it. A feature comes with tests for the modes it touches, streaming included when the
format streams.

## Adding a wire format

1. Implement `Adapter` (`src/adapters/adapter.ts`) in a new file under `src/adapters/`:
   `toInput` to describe the request to Jev or say why it cannot be routed, `apply` to rewrite it
   for each decision mode, `directJson` and `directStream` to answer without the LLM.
2. Register its route in `src/app.ts`, and add it to the adapter table of `/router/decide`.
3. Teach `src/usage.ts` to read the provider's token counts, streamed and not.
4. Add `test/<format>.test.ts`, and a row to the endpoint table in the README.

Say in the pull request whether it was run against the real API or only unit-tested; the README
says the same to users.

## Adding a client launcher

1. Describe the client in `bin/clients.mjs`: its binary, default port, upstream, and the
   arguments or environment that point it at the gateway (the spec fields are documented at the
   top of `bin/launcher.mjs`). Take a free port; each client runs its own gateway.
2. Add `bin/jev-<client>.mjs`, which is five lines, and register it under `bin` and `scripts` in
   `package.json`.
3. Cover the spec in `test/launcher.test.ts` or a file of its own, as `test/opencode.test.ts` does.
4. Add a "Using it with ..." section to the README, with the client version you checked against.

## Pull requests

1. Fork, and branch from `main`.
2. Keep a pull request to one change. A refactor that a feature needs is easier to review as its
   own commit.
3. Update the README when behaviour, flags or configuration change, and `.env.example` when you
   add a setting.
4. **Leave `version` in `package.json` and `CHANGELOG.md` alone.** release-please writes both
   from commit messages, in a release pull request of its own.
5. Give the pull request a conventional title (next section). The title reaches `main` however
   the pull request is merged, and from there becomes a line in the changelog.
6. Make sure the checks pass. CI must be green before a merge.

For anything large (a new mode, a change to how decisions are made, a new runtime dependency),
open an issue first so the design can be agreed before the work is done.

## Commit messages and pull request titles

Commits on `main` follow [Conventional Commits](https://www.conventionalcommits.org), because
the version number and the changelog are derived from them:

```
<type>[(scope)][!]: <what changes, imperative, no full stop>
```

| Type | Use it for | Effect on the next release |
| --- | --- | --- |
| `feat` | Something users can now do, or must now do differently | Minor bump, listed under **Added** |
| `fix` | Something that was wrong and is now right | Patch bump, listed under **Fixed** |
| `perf` | Same behaviour, faster or cheaper | Patch bump, listed under **Changed** |
| `docs`, `test`, `refactor`, `build`, `ci`, `chore`, `style` | Everything users do not notice | None, and not in the changelog |

Add `!` after the type (`feat!:`) when users have to change something to keep working: a removed
or renamed flag, a new default, a higher Node floor. The scope is optional and names the part
touched: `fix(brew):`, `feat(opencode):`, `docs(readme):`.

The rest of the subject is the entry users will read in the changelog, so say what changes for
them, not what you did to the code:

```
fix: read token usage from streams that send no content-type     good
fix: handle missing header in readUsage                          says nothing to a user
feat!: listen on loopback only                                   good, and flags the break
Update launcher                                                  no type: invisible to the release
```

Explain the why in the body when the diff does not. Squashing is preferred, and then only the
title survives: commit however you like within the branch. When a pull request is merged with a
merge commit instead, its commits land on `main` too, and each conventional one gets a changelog
line of its own next to the title's, so keep them as well-formed as the title. Maintainers
committing straight to `main` follow the same format. How these become a release is in [docs/releasing.md](docs/releasing.md).

## Code style

TypeScript in `src/` and `test/`, plain ES modules in `bin/` and `scripts/` so the launchers run
without a build. There is no formatter or linter to satisfy: match the code around you. Comments
explain why something is the way it is, not what the next line does.

The idioms are written down in `.agents/skills/jev-gateway-conventions/SKILL.md`. Coding agents
that read `.agents/skills/` (Codex, OpenCode, Gemini CLI) load it on their own, and
`.claude/skills/` links to the same file for Claude Code. It reads fine for people too.

## Reporting bugs and security issues

Open an [issue](https://github.com/vinilana/jev-gateway/issues) with the launcher or endpoint you
used, the gateway version (`npm ls -g jev-gateway`), and the relevant lines of
`~/.jev-gateway/<client>.log`. The `mode` and `reason` fields of those lines usually say what
happened. Read log lines and debug dumps before attaching them: a `direct` decision logs the
tool's arguments, and a dump holds the whole conversation.

If the problem exposes credentials or conversations, do not open a public issue: report it
privately through the repository's **Security** tab on GitHub.

## Releases

release-please keeps a release pull request open with the next version and its changelog.
A maintainer merges it, and the rest is automatic. See [docs/releasing.md](docs/releasing.md).

## License

By contributing you agree that your contribution is licensed under the [MIT license](LICENSE).
