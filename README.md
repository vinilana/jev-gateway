# jev-gateway

A local LLM gateway for coding agents. When your agent is about to decide **which tool to call**,
the gateway asks [Jev](https://docs.typesafe.ai/introduction), TypeSafe's fast decision model,
instead of leaving that choice to the expensive reasoning model. Everything else goes to your usual
LLM untouched.

It works with **Codex** and **Claude Code** out of the box, including on ChatGPT and claude.ai
subscriptions, and with any client that speaks the OpenAI or Anthropic APIs.

> Independent project, not affiliated with or endorsed by TypeSafe. "Jev" is TypeSafe's model and
> this gateway is a client of its public API.

## Quick start

You need Node.js 22.15 or newer, a [TypeSafe API key](https://docs.typesafe.ai/introduction), and
Codex and/or Claude Code already installed and logged in.

**1. Install**

```bash
npm install -g jev-gateway
```

### Install with Homebrew (macOS and Linux)

```bash
brew tap vinilana/tap
brew install jev-gateway
# without tapping first: brew install vinilana/tap/jev-gateway
```

Update later with `brew upgrade jev-gateway`. Same launchers, same setup —
continue with step 2 below. (Details: [docs/homebrew-tap.md](docs/homebrew-tap.md).)

**2. Save your TypeSafe key**

```bash
mkdir -p ~/.jev-gateway
echo "TYPESAFE_API_KEY=your-key-here" > ~/.jev-gateway/.env
```

**3. Run your agent through the gateway**

```bash
jev-codex      # use it exactly like `codex`
jev-claude     # use it exactly like `claude`
```

**4. Watch it work**

```bash
jev-codex --dashboard
```

That's it. Your existing login keeps working, nothing in `~/.codex` or `~/.claude` is changed, and
plain `codex` and `claude` still behave as before. Only sessions started with the `jev-` commands go
through the gateway.

## What to expect

- The first `jev-codex` or `jev-claude` starts a small gateway in the background and then opens your
  agent. Every argument is passed through, so `jev-codex exec "fix the failing test"` works like
  `codex exec "fix the failing test"`.
- The gateway keeps running after you close the agent, so the next session starts instantly. Stop it
  with `--stop`.
- Each turn, the gateway asks Jev which tool fits. When Jev is confident, the gateway steers the LLM
  to that tool. When it is not, the request goes through unchanged.
- If Jev is down, slow, or your key is wrong, every request simply goes straight to the LLM. The
  gateway never makes a request fail.
- It listens on `127.0.0.1` only.

## Commands

All of these work with both `jev-codex` and `jev-claude`.

| Command | What it does |
| --- | --- |
| `jev-codex [args]` | Start the gateway if needed, then run Codex through it |
| `jev-codex --dashboard` | Open the monitoring dashboard in your browser |
| `jev-codex --routing off` | Baseline mode: stop asking Jev, keep counting tokens |
| `jev-codex --routing on` | Let Jev decide again |
| `jev-codex --status` | Is the gateway running, and where does it forward to? |
| `jev-codex --logs` | Follow routing decisions live (use a second terminal) |
| `jev-codex --start` | Start the gateway without opening the agent |
| `jev-codex --stop` | Stop the background gateway (close your sessions first) |
| `jev-codex --print-config` | Print settings to point plain `codex` at the gateway permanently |
| `jev-codex --gateway-help` | List all of the above |

Codex uses port 8790 and Claude Code uses port 8789. Change them with `JEV_CODEX_PORT` and
`JEV_CLAUDE_PORT`.

## Dashboard

```bash
jev-codex --dashboard     # or: jev-claude --dashboard
```

This opens `http://localhost:8790/dashboard`. If no browser window appears, paste that address into
your browser. One page shows both gateways (Codex and Claude) and refreshes every 2 seconds.

You will see:

- **A status per gateway:** Routing, Passthrough only, Jev is failing, Idle, Baseline, or Offline,
  with a one-line explanation.
- **Why requests were not routed,** with each reason explained in plain English.
- **Jev's numbers:** calls, latency, confidence, and what it cost.
- **LLM tokens:** input (and how much came from the prompt cache), output (and how much was hidden
  reasoning), and seconds per request.
- **A live table** of recent requests. A request appears when its reply finishes, because that is
  when the provider reports its tokens.

The dashboard only shows request metadata. Prompts, tool arguments, and credentials never reach it.

### Is it worth it? Compare with a baseline

Switch routing off to measure the same work without Jev. The gateway keeps forwarding and counting
tokens, but never asks Jev and rewrites nothing.

```bash
jev-codex --routing off    # do a task
jev-codex --routing on     # do a similar task
```

The same switch is a button on each gateway card. The "Token use" card then shows both states side
by side: tokens in and out per request, cache share, reasoning tokens, and seconds. The comparison
is only meaningful if you do similar work in both states.

## Using it with Codex

`jev-codex` reuses your existing Codex login. With a ChatGPT subscription the gateway forwards to
`https://chatgpt.com/backend-api/codex`. With an API key it forwards to `https://api.openai.com/v1`.
Override either with `JEV_CODEX_UPSTREAM_BASE_URL`.

Codex speaks the Responses API, so the gateway handles `POST /v1/responses`, including Codex's
free-form tools such as `apply_patch`, tools declared inside the conversation, and compressed
request bodies. If the backend rejects a rewritten request, the gateway resends the original, so
Codex never sees an error caused by the gateway.

## Using it with Claude Code

`jev-claude` runs `claude` with only `ANTHROPIC_BASE_URL` set. Claude Code keeps using its saved
login, so a claude.ai subscription keeps working and its usual limits apply.

Jev can do less here than with Codex, because of how the Anthropic API works. Claude Code runs with
extended thinking, and the API rejects a forced tool while thinking is on. It also rereads a cached
conversation on every turn, and changing `tool_choice` would invalidate that cache. So for Claude
Code the gateway adds a short suggestion to the request instead (`hint` mode), which the model is
free to ignore. Expect better tool picks on large tool lists, not lower cost or latency.

## Running it as a server for your own app

Work from a checkout:

```bash
pnpm install
cp .env.example .env    # set TYPESAFE_API_KEY, and UPSTREAM_BASE_URL if you don't use OpenAI
pnpm dev                # listens on http://localhost:8787
```

Then point your client at it:

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8787/v1")  # your usual provider key still works
```

The gateway routes three endpoints and proxies every other `/v1/*` path unchanged:

| Endpoint | API |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/responses` | OpenAI Responses |
| `POST /v1/messages` | Anthropic Messages |

By default your client's own `Authorization` header is forwarded to the provider. Set
`UPSTREAM_API_KEY` to have the gateway hold the provider key instead, and `ROUTER_API_KEY` to
require a gateway key from clients. Any OpenAI-compatible provider works, for example OpenAI,
OpenRouter, vLLM, Ollama, or LiteLLM.

To skip Jev for a single request, send the header `x-jev-gateway: off`.

### Try a decision without calling any LLM

`POST /router/decide` takes a request body, asks Jev, and returns the decision: the mode, the tool,
the arguments, Jev's confidence, and its latency.

```bash
curl -s localhost:8787/router/decide -H 'content-type: application/json' -d '{
  "model": "gpt-5",
  "messages": [{"role": "user", "content": "turn the kitchen lights on"}],
  "tools": [{"type": "function", "function": {
    "name": "set_lights", "description": "Turn the lights in a room on or off.",
    "parameters": {"type": "object", "required": ["room", "on"], "properties": {
      "room": {"type": "string", "enum": ["kitchen", "bedroom", "office"]},
      "on": {"type": "boolean"}}}}}]
}'
```

## How it works

Jev does not generate text. It answers typed questions about a piece of state (pick one option,
give a score, or yes/no) and returns calibrated probabilities with a confidence, in one fast call.
Choosing a tool is exactly that kind of question, so the work is split like this:

| Decision | Who makes it |
| --- | --- |
| Which tool, or no tool at all | **Jev** |
| Arguments that are enums, booleans, or constants | **Jev**, in the same call |
| Open-ended arguments such as free text, numbers, and dates | The LLM, already pointed at Jev's tool |
| Plain text replies, and any request without tools | The LLM, untouched |

A request that carries tools triggers one Jev call. The conversation becomes the state, and the
questions are: which tool (or none), whether a tool is needed at all (an independent cross-check),
and the value of every closed-set argument. The answer selects a mode, which is reported in the
`x-jev-gateway-mode` response header:

| Mode | When | What happens |
| --- | --- | --- |
| `direct` | Jev is confident about the tool and every argument is an enum, boolean, or constant | The gateway builds the tool call itself, streaming included. **No LLM call.** |
| `forced` | Jev is confident about the tool, but some arguments are open-ended | Forwarded with `tool_choice` set to that tool, so the LLM only fills in arguments. `ARGS_MODEL` can send these to a cheaper model |
| `hint` | Jev is confident, but `tool_choice` cannot be changed (Anthropic with thinking on, or a cached conversation) | Forwarded with a one-line suggestion added after the client's last block, so cached prefixes stay valid |
| `none` | Jev is confident that no tool is needed | Forwarded with `tool_choice: "none"` |
| `passthrough` | Low confidence, the two checks disagree, Jev failed, there are no tools, or the caller already chose | Forwarded byte for byte. `x-jev-gateway-reason` says why |

Tool lists longer than 120 entries (Claude Code sends about 280) take two Jev calls. The first ranks
the list in groups. The second decides among the top 3 of each group, using full descriptions.

## Configuration

Settings are environment variables. The launchers read them from your shell,
`~/.jev-gateway/.env`, or a checkout's own `.env`. See [.env.example](.env.example) for the full
list. The ones worth knowing:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | required | Your TypeSafe key |
| `JEV_MIN_CONFIDENCE` | `0.7` | Below this confidence, the LLM decides. Lower it to route more, raise it to be more careful |
| `JEV_ARG_MIN_CERTAINTY` | `0.8` | Every argument must reach this for a `direct` answer |
| `JEV_DIRECT_CALLS` | `true` | Set to `false` so the gateway never answers without the LLM |
| `JEV_ROUTING` | `on` | Set to `off` to start in baseline mode |
| `JEV_TIMEOUT_MS` | `4000` | How long to wait for Jev before letting the LLM decide |
| `ARGS_MODEL` | unset | A cheaper model for filling arguments in `forced` mode |
| `HOST` | `127.0.0.1` | Interface to listen on. Set `ROUTER_API_KEY` before exposing it |
| `JEV_DEBUG_DUMP_DIR` | unset | Write requests and response summaries to this folder, with credentials redacted |

Each request also logs one JSON line to stdout, or to `~/.jev-gateway/<client>.log` under a launcher.

## Known trade-offs

- Jev adds a network call to every turn that carries tools. Expect roughly half a second to a second.
- Jev picks **one** tool per turn. In `forced` mode the LLM can still call that tool several times
  in parallel, but it cannot mix different tools in the same turn.
- A wrong forced tool can derail a turn. If the model had nothing left to do and is forced to call
  a tool anyway, it may produce an incomplete reply and the agent will retry. Raise
  `JEV_MIN_CONFIDENCE` if you see this.
- In `hint` mode the LLM still does its own reasoning, so the gain is accuracy, not cost.
- Jev reads text only and has a 32k-token window. Images become placeholders and long conversations
  keep their newest turns. It is most accurate in English.
- The default confidence thresholds are starting points. Use the dashboard and baseline mode to tune
  them for your own work.

## Benchmark

Is it worth it? [jev-gateway-bench](https://github.com/vinilana/jev-gateway-bench) measures that:
a real coding agent does the same task with routing on and off, the gateway meters every token,
and a hidden verifier scores the result. The tasks are about building, debugging and extending a
chess rules engine.

Results so far, from 40 agent sessions (two chess tasks, five runs per mode, agents run clean with
no MCP servers or plugins), every one of which passed all hidden checks:

| Medians, routing on vs. off | Output tokens | Input tokens | Wall-clock time |
| --- | ---: | ---: | ---: |
| Codex, fixing bugs | -57% | -7% | -39% |
| Codex, adding a feature | 0% | +2% | +8% |
| Claude Code (Fable 5.1), fixing bugs | -13% | -19% | +6% |
| Claude Code (Fable 5.1), adding a feature | -24% | -27% | -26% |

Routing pays off most where an agent's turns are mechanical, and costs a little where there is
nothing to save. Five runs per cell is still a small sample: the chart, the spread of the
individual runs, the raw data and how to run it yourself are in that repository.

## Development

```bash
pnpm install
pnpm test         # runs against fake Jev and provider transports, no keys needed
pnpm typecheck
pnpm build
```

`scripts/mock-jev.mjs` is a local stand-in for Jev. Point `TYPESAFE_BASE_URL` at it to drive a real
agent end to end without a TypeSafe key.

```
src/adapters/         request formats: chat.ts, responses.ts (Codex), messages.ts (Claude Code)
src/state.ts          turns a conversation into Jev state
src/questions.ts      turns tools into Jev questions and finds closed-set arguments
src/decide.ts         the Jev call and the mode decision
src/upstream.ts       streaming reverse proxy
src/usage.ts          token usage read from a reply, normalised across providers
src/app.ts            routes, auth, headers, and the resend-on-rejection fallback
src/events.ts         recent request metadata kept in memory and restored from the log
src/dashboard.ts      serves /dashboard (dashboard.html is the whole page, no build step)
bin/                  jev-codex and jev-claude launchers (launcher.mjs, clients.mjs)
scripts/mock-jev.mjs  local stand-in for Jev
```

## License

MIT
