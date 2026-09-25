# Changelog

## [0.5.0](https://github.com/vinilana/jev-gateway/compare/v0.4.3...v0.5.0) (2026-09-25)


### Added

* jev-devin routes Devin CLI tool calls through Jev ([#44](https://github.com/vinilana/jev-gateway/issues/44)) ([f23d1ca](https://github.com/vinilana/jev-gateway/commit/f23d1ca8853ac2a8b798caa941b38971b9bcfad4))
* **kilo:** add jev-kilo, a launcher for Kilo CLI ([#48](https://github.com/vinilana/jev-gateway/issues/48)) ([34f6de9](https://github.com/vinilana/jev-gateway/commit/34f6de9b38b4f32a50a0f65b262989ae1270405a))
* reach Jev with an OpenCode Zen key ([#27](https://github.com/vinilana/jev-gateway/issues/27)) ([aac48a9](https://github.com/vinilana/jev-gateway/commit/aac48a9150fc234369d670ecf881993053198fa1))


### Fixed

* **claude:** never answer a thinking conversation by itself ([#39](https://github.com/vinilana/jev-gateway/issues/39)) ([9ec3e0e](https://github.com/vinilana/jev-gateway/commit/9ec3e0e0988137712f42b88b7c2aa0c6ba2e4e9a))

## [0.4.3](https://github.com/vinilana/jev-gateway/compare/v0.4.2...v0.4.3) (2026-09-23)


### Fixed

* pass Codex subagent requests through instead of taking their tools away ([576d89f](https://github.com/vinilana/jev-gateway/commit/576d89f770b4e6397b389fdd1de46665d8fc5f98))
* pass requests through when a Jev error page cannot fit in a header ([0eab07b](https://github.com/vinilana/jev-gateway/commit/0eab07bdc70239c12b6cb71e3ff94cb9b8892915))

## [0.4.2](https://github.com/vinilana/jev-gateway/compare/v0.4.1...v0.4.2) (2026-09-23)


### Fixed

* **dashboard:** probe unused peer ports less often, and allow ?peers=none ([fbe327d](https://github.com/vinilana/jev-gateway/commit/fbe327d4b1cbf4c094074ab837c965ac358808f8))
* honour JEV_DIRECT_CALLS=false for tools with no open arguments ([aa5af35](https://github.com/vinilana/jev-gateway/commit/aa5af3580ff4c30282187cae9f07428c724cb098))
* **opencode:** say which agents bypass the gateway, and keep an inherited inline config ([384e7f4](https://github.com/vinilana/jev-gateway/commit/384e7f40779c7b12fe2f1625092364ece9abf483))

## [0.4.1](https://github.com/vinilana/jev-gateway/compare/v0.4.0...v0.4.1) (2026-09-20)


### Fixed

* keep /health to "ok" once the gateway has a key ([57651ff](https://github.com/vinilana/jev-gateway/commit/57651ff8e6d1d40fd0cacabb8941c6703c4a773d)), closes [#8](https://github.com/vinilana/jev-gateway/issues/8)
* keep hostile tool names out of hints, and pass malformed requests through instead of failing ([40fd608](https://github.com/vinilana/jev-gateway/commit/40fd60848915dc08e61305b3b1620ac0f035ccfb))
* keep tool names that are not a single inert token away from Jev and the LLM ([f306026](https://github.com/vinilana/jev-gateway/commit/f306026d74156a93f50a5fa9f2b035163a74956c)), closes [#8](https://github.com/vinilana/jev-gateway/issues/8)
* pass malformed requests through instead of answering 500 ([174d84a](https://github.com/vinilana/jev-gateway/commit/174d84a09cdbb0810409bfb59ac7b74c2a139147)), closes [#8](https://github.com/vinilana/jev-gateway/issues/8)
* route Chat Completions requests that also carry built-in tools ([f6fd00c](https://github.com/vinilana/jev-gateway/commit/f6fd00c95dc0e6a36bb2ba8b23dcd5aaecce9137)), closes [#8](https://github.com/vinilana/jev-gateway/issues/8)

## [0.4.0](https://github.com/vinilana/jev-gateway/compare/v0.3.1...v0.4.0) (2026-09-20)

### Added
- **First-run setup.** Every `jev-` launcher now asks where to reach Jev and for the key when none
  is configured, checks the key with one real call, and saves it to `~/.jev-gateway/.env`. No file
  to write by hand. `--setup` runs it again, `--status` shows which provider is in use, and without
  a terminal a launcher exits naming what is missing instead of waiting for input.
- **Jev through OpenRouter and Vercel AI Gateway**, next to TypeSafe's own API. Set
  `OPENROUTER_API_KEY` or `AI_GATEWAY_API_KEY`, or pick one in the setup. `JEV_PROVIDER` chooses
  when several keys are present.

### Changed
- The gateway calls Jev over plain HTTP for all three providers, so `@typesafe-ai/sdk` is no longer
  installed with the package. `TYPESAFE_BASE_URL` still redirects the TypeSafe provider, and
  `JEV_URL` replaces the endpoint of any provider.

## 0.3.1

First version published by the release workflow. It carries everything listed under 0.3.0, which
was tagged but never reached npm.

### Changed
- Releases are automatic: pushing a `vX.Y.Z` tag publishes to npm through trusted publishing
  (OIDC), with provenance and without tokens, then creates the GitHub release. See
  `docs/releasing.md`.
- Pull requests and pushes to `main` run the type check, the tests and the build in CI, on Node
  22.15 and 24.

### Fixed
- The Homebrew workflow checks for its token before anything else, instead of polling npm for half
  an hour and then failing when no tap is configured.

## 0.3.0

### Added
- **OpenCode support.** `jev-opencode` runs stable OpenCode (v1) through a gateway on port 8791,
  injecting a provider through `OPENCODE_CONFIG_CONTENT` so nothing in your OpenCode config is
  written. Checked against OpenCode 1.18.31. Thanks to @viniciosrab (#4).
- **Gemini API support.** The gateway routes `POST /v1beta/models/<model>:generateContent` and
  `:streamGenerateContent`, forcing a tool through `toolConfig.functionCallingConfig`, and
  `jev-gemini` points the Gemini CLI at a gateway on port 8788. For clients that use a Gemini API
  key. Unit-tested, not yet run against the real API. Thanks to @andrecodexvictor (#5).
- **Homebrew release automation.** A workflow that updates a formula in `vinilana/homebrew-tap`
  after each release. It does nothing until the tap and its token exist; see
  `docs/homebrew-tap.md`. Thanks to @viniciosrab (#2).
- Token metering understands Gemini's `usageMetadata`, streamed or not.

### Fixed
- The proxy dropped the leading `/v1` from any path that started with it, so `/v1beta/...` was
  forwarded as `beta/...`. Only the `/v1` segment is dropped now.

## 0.2.2

### Changed
- How each agent is pointed at a gateway now lives in `bin/clients.mjs`, and `bin/launcher.mjs`
  exports what is needed to start a gateway process. The
  [benchmark](https://github.com/vinilana/jev-gateway-bench) uses both, so it drives agents exactly
  the way `jev-codex` and `jev-claude` do. No change in behaviour.

## 0.2.1

### Fixed
- Token metering now works with Codex on a ChatGPT subscription. That backend streams its replies
  without a content-type header, so 0.2.0 read them as plain JSON and recorded no tokens at all.

## 0.2.0

### Added
- **Monitoring dashboard.** `jev-codex --dashboard` (or `jev-claude --dashboard`) opens a local page
  that shows whether each gateway is routing, passing traffic through, idle, or failing, and why.
  One page covers both gateways and updates live. It shows request metadata only, never prompts,
  tool arguments, or credentials.
- **Token metering.** Every forwarded request records what the provider says it cost: input tokens
  (and how many came from the prompt cache), output tokens (and how many were reasoning), and
  duration. Works for Chat Completions, the Responses API, and Anthropic Messages.
- **Baseline mode.** `--routing off` stops asking Jev but keeps metering, so the dashboard can show
  token use with and without Jev side by side. Also a button on the dashboard and `JEV_ROUTING=off`.
- `HOST` setting for the interface to listen on.

### Changed
- **The gateway now listens on `127.0.0.1` only.** 0.1.0 listened on every interface, which made a
  gateway that forwards your credentials reachable from the local network. Upgrade.
- Launcher flags lost their `jev-` prefix: `--dashboard`, `--routing`, `--status`, `--logs`,
  `--start`, `--stop`. The gateway's own help and config are `--gateway-help` and `--print-config`,
  because `--help` and `--config` belong to Codex and Claude Code. The old `--jev-*` spellings still
  work.
- Requests are logged when their reply ends instead of when it starts, since that is when token
  counts are known.
- Requires Node.js 22.15 or newer.
- README rewritten around getting started.

### Fixed
- `--stop` now stops whichever gateway answers on the port, including one started by an older
  version that recorded its pid elsewhere.

## 0.1.0

First release: tool selection routed to Jev for Chat Completions, the Responses API, and Anthropic
Messages, with the `jev-codex` and `jev-claude` launchers.
