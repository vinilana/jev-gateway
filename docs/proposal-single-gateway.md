# Proposal: one gateway, enabled inside each tool

Status: proposal with a working prototype on this branch. Nothing here is released.

## The idea

Today every tool has a wrapper: `jev-codex`, `jev-claude`, `jev-opencode`, `jev-gemini`. Each one
starts a gateway of its own on its own port and launches the tool pointed at it. You have to
remember to type the wrapper's name, and anything that starts the tool for you (an IDE extension, a
script, a desktop app) goes around the gateway.

The proposal turns that inside out:

```bash
jev-gateway enable codex claude   # once
codex                             # from then on, under its own name
claude
```

One gateway runs in the background. `enable` writes a few lines into the tool's own configuration
so the tool uses the gateway by default. `disable` takes them out again.

## How it works

**One gateway, a path per tool.** Codex and OpenCode both speak OpenAI's APIs but go to different
backends, so a single gateway cannot tell them apart by the request alone. Each tool therefore gets
a path prefix, and the prefix carries two facts: where the traffic goes, and which tool to credit
on the dashboard.

| Tool | Base URL written into the tool | Forwarded to |
| --- | --- | --- |
| Codex | `http://127.0.0.1:8787/codex/v1` | ChatGPT's Codex backend, or `api.openai.com` with an API key |
| Claude Code | `http://127.0.0.1:8787/claude` | `api.anthropic.com` |
| OpenCode | `http://127.0.0.1:8787/opencode/v1` | `api.openai.com` |
| Gemini CLI | `http://127.0.0.1:8787/gemini` | `generativelanguage.googleapis.com` |

`JEV_<TOOL>_UPSTREAM_BASE_URL` overrides any of them. Requests without a prefix behave exactly as
before, so nothing that exists today breaks. The code is `src/profiles.ts` and a `mount()` in
`src/app.ts`; every event now carries the tool's name, so one dashboard shows all of them.

**`enable` edits the tool's own file, and only what it needs.**

| Tool | File | What is written |
| --- | --- | --- |
| Codex | `~/.codex/config.toml` | `model_provider = "jev-gateway"` at the top and a `[model_providers.jev-gateway]` table at the end, both inside marked blocks. A `model_provider` you already had is parked in a comment, because TOML forbids the key twice |
| Claude Code | `~/.claude/settings.json` | `env.ANTHROPIC_BASE_URL` |
| OpenCode | `~/.config/opencode/opencode.json` | a `jev-gateway` provider, and `model` / `small_model` pointing at it |
| Gemini CLI | `~/.gemini/.env` | `GOOGLE_GEMINI_BASE_URL` |

The original file is copied next to itself once (`config.toml.before-jev-gateway`), what each value
held before is recorded in `~/.jev-gateway/enabled.json`, and `disable` puts it back. Logins are
never touched: each tool keeps authenticating the way it does today, and the gateway forwards the
credentials as they come.

**The first-run setup carries over.** `jev-gateway enable` asks for the Jev key if there is none,
exactly like the wrappers on the branch this one is built on.

## What was checked

- 116 tests pass, 10 of them new: each prefix reaches its own upstream without the prefix, events
  are credited to the right tool, and the config editors round-trip (enable twice, then disable,
  gives back the original text byte for byte).
- **A real Codex, without a wrapper.** With a copy of a real 400-line `config.toml` in a throwaway
  `CODEX_HOME`: `jev-gateway enable codex`, then plain `codex exec`. Codex reported
  `provider: jev-gateway`, its requests arrived at `/codex/v1/responses`, were credited to `codex`
  on the dashboard, and were forwarded to OpenAI (which answered 401, because the key was fake on
  purpose). `jev-gateway disable codex` left the file identical to the original, checked with `diff`.
- Not run for real: Claude Code, OpenCode and Gemini through `enable`. Claude Code was left alone
  on purpose: this work was done from inside a Claude Code session, and rewriting its base URL
  while it runs is a good way to cut off the branch you are sitting on.

## What it costs

This is the part to decide on.

1. **If the gateway is down, the tool is down.** A wrapper cannot have this problem, because it
   starts the gateway itself. A tool that was told to always use `127.0.0.1:8787` just fails to
   connect. The prototype offers `jev-gateway autostart on`, one line in `~/.bashrc` / `~/.zshrc`
   that starts the gateway in the background with every shell. That covers terminals. It does not
   cover a tool started from a desktop icon before any terminal was opened, and it does not restart
   a gateway that crashed. A real service (a systemd user unit, a launchd agent) would, at the
   price of per-platform code that has to be maintained and tested on machines we do not have.
2. **It writes to other programs' configuration.** "Nothing in `~/.codex` is modified" has been a
   promise of this project since the first release, and it is a good one to be able to make. This
   proposal gives it up, carefully (marked blocks, a backup, an exact undo), but it gives it up. A
   future version of a tool can change its config format and turn a working `enable` into a broken
   config file.
3. **Comments in JSON files do not survive.** `settings.json` and `opencode.json` are parsed and
   written back. A file with comments (OpenCode accepts JSONC) is refused rather than rewritten,
   which is safe and also means `enable` does not work for those users.
4. **One process for everything.** A crash or a bad setting now affects every tool at once, where
   four gateways failed one at a time. In exchange there is one port, one log, one dashboard and
   one thing to restart.
5. **OpenCode's model changes.** Its provider and model are one setting (`provider/model`), so
   enabling the gateway means replacing the user's default model. The wrapper only did that for
   the session it launched.

## A way to have both

The two styles are not exclusive, and the prototype keeps both working:

- Keep the wrappers as the default the README teaches: no setup, nothing to undo, cannot leave a
  tool pointing at a dead port.
- Offer `jev-gateway enable` as the opt-in for people who want the tool to go through the gateway
  however it is started, and who accept a background process.
- Move the wrappers onto the single gateway as well (`jev-codex` would use
  `127.0.0.1:8787/codex/v1` instead of a gateway of its own), so there is one process and one
  dashboard either way. That is a small change on top of this branch and is not done yet.

## Open questions

- Should `enable` refuse to run unless autostart is on, or a service is installed?
- Is a per-platform service worth owning, or is the shell hook enough?
- Should `disable --all` run automatically when the package is uninstalled? npm has no reliable
  uninstall hook, so a user who removes the package with a tool still enabled is left with a tool
  that cannot connect, until they run the undo by hand or restore the backup.
- Which prefix scheme ages best: a path per tool (this prototype), or a port per tool on one
  process?
