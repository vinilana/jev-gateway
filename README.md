# jev-gateway

A local LLM gateway for coding agents. When your agent is about to decide **which tool to call**,
the gateway asks [Jev](https://docs.typesafe.ai/introduction), TypeSafe's fast decision model,
instead of leaving that choice to the expensive reasoning model. Everything else goes to your usual
LLM untouched.

It works with **Codex**, **Claude Code** and **OpenCode** out of the box, including on ChatGPT and
claude.ai subscriptions, with Gemini API clients, and with any client that speaks the OpenAI,
Anthropic or Google Gemini APIs.

> Independent project, not affiliated with or endorsed by TypeSafe. "Jev" is TypeSafe's model and
> this gateway is a client of its public API.

## Quick start

You need Node.js 22.15 or newer, a key for Jev (from TypeSafe, OpenRouter, Vercel AI Gateway or
OpenCode, see [Where Jev runs](#where-jev-runs)), and Codex, Claude Code, and/or OpenCode already
installed and logged in.

**1. Install**

```bash
npm install -g jev-gateway
```

**2. Run your agent through the gateway**

```bash
jev-codex      # use it exactly like `codex`
jev-claude     # use it exactly like `claude`
jev-opencode   # use it exactly like `opencode` (stable v1)
jev-gemini     # Gemini CLI, with a Gemini API key
jev-devin      # use it exactly like `devin`
jev-kilo       # use it exactly like `kilo`
jev-qwen       # use it exactly like `qwen`
```

**3. Answer two questions, once**

The first time, the launcher asks where you want to reach Jev and for the key. It checks the key
with one real call, saves it to `~/.jev-gateway/.env` (readable only by you), and carries on into
your agent. Every `jev-` command shares that file, so you are asked once for all of them.

```text
Where do you want to reach Jev?
  1) TypeSafe: the official API, direct from the makers of Jev
  2) OpenRouter: Jev through your OpenRouter account and credits
  3) Vercel AI Gateway: Jev through your Vercel AI Gateway key and billing
  4) OpenCode: Jev through your OpenCode Zen key: free by default, paid only if selected
Choose 1-4 [1]:
Paste your TypeSafe API key (input is hidden):
The key works (Jev answered in 712 ms).
```

**4. Watch it work**

```bash
jev-codex --dashboard
```

That's it. Your existing login keeps working, nothing in `~/.codex`, `~/.claude`, or
`~/.config/opencode` is changed, and plain `codex`, `claude`, and `opencode` still behave as
before. Only sessions started with the `jev-` commands go through the gateway.

## What to expect

- The first `jev-codex`, `jev-claude`, or `jev-opencode` starts a small gateway in the background
  and then opens your agent. Every argument is passed through, so `jev-codex exec "fix the
  failing test"` works like `codex exec "fix the failing test"`.
- The gateway keeps running after you close the agent, so the next session starts instantly. Stop it
  with `--stop`.
- Each turn, the gateway asks Jev which tool fits. When Jev is confident, the gateway steers the LLM
  to that tool. When it is not, the request goes through unchanged.
- If Jev is down, slow, or your key is wrong, every request simply goes straight to the LLM. The
  gateway never makes a request fail.
- It listens on `127.0.0.1` only.

## Commands

All of these work with `jev-codex`, `jev-claude`, `jev-opencode`, `jev-gemini`, `jev-devin`, `jev-kilo` and `jev-qwen`.

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
| `jev-codex --setup` | Choose where to reach Jev again, or change the key |
| `jev-codex --print-config` | Print settings to point plain `codex` at the gateway permanently |
| `jev-codex --gateway-help` | List all of the above |

Codex uses port 8790, Claude Code 8789, OpenCode 8791, Gemini clients 8788, Devin 8792, Kilo 8785 and Qwen Code 8787. Change
them with `JEV_CODEX_PORT`, `JEV_CLAUDE_PORT`, `JEV_OPENCODE_PORT`, `JEV_GEMINI_PORT`, `JEV_DEVIN_PORT`, `JEV_KILO_PORT` and
`JEV_QWEN_PORT`.

## Dashboard

```bash
jev-codex --dashboard     # or: jev-claude --dashboard, jev-opencode --dashboard
```

This opens `http://localhost:8790/dashboard`. If no browser window appears, paste that address into
your browser. One page shows each gateway (Codex, Claude, and OpenCode) and refreshes every
2 seconds.

To find the other gateways, the page tries their default ports. A port that never answered is
tried again after 10 seconds, then less often, down to once a minute; each try that finds nothing
shows as a refused connection in the browser console. Add `?peers=none` to the address to watch
only the gateway that serves the page.

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

## Where Jev runs

Jev is served by TypeSafe and by three gateways that resell it. All four take the same questions
and return the same answers, so the choice is about whose account and billing you want to use.

| Provider | Key variable | Default model | Get a key |
| --- | --- | --- | --- |
| TypeSafe (official) | `TYPESAFE_API_KEY` | `jev-latest` | [typesafe.ai](https://typesafe.ai) |
| OpenRouter | `OPENROUTER_API_KEY` | `typesafe/jev-1.13` | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `typesafe-ai/jev` | [Vercel dashboard](https://vercel.com/dashboard/ai-gateway/api-keys) |
| OpenCode | `OPENCODE_API_KEY` | `jev-1.13-free` | [OpenCode Zen](https://opencode.ai/auth) |

OpenCode serves two ids at the same endpoint: `jev-1.13-free` (free,
[for a limited time](https://opencode.ai/docs/zen/#jev)) and the paid `jev-1.13`. The gateway
defaults to the free one. If OpenCode says the free model is gone (404 or 410), the request goes
to the LLM unchanged. The reason names `JEV_MODEL=jev-1.13`, which opts into the paid model.
The setup wizard offers to save that setting if only the paid model answers its key check.

`jev-codex --setup` (or any other launcher) switches between them and restarts the gateway with the
new key. To configure it by hand instead, put `JEV_PROVIDER` and the matching key in
`~/.jev-gateway/.env` or in your environment. Without `JEV_PROVIDER`, the gateway uses whichever key
it finds, TypeSafe's first. `JEV_MODEL` picks another model; an id written for one provider is
ignored under another, because the providers name their models differently. `--status` and the
dashboard show which provider is in use.

With no terminal to ask in (CI, scripts), a launcher does not wait for input: it exits and names
the variables it looked for.

The TypeSafe and OpenCode paths are run against the real APIs. On 2026-09-24, the setup key
check succeeded with a real OpenCode Zen key for both `jev-1.13-free` and paid `jev-1.13`. This
confirms that the paid model answered the check; the account's billing history was not inspected.
The unavailable-free-model behavior and setup consent flow remain test-only because the free model
still answers. The OpenRouter and Vercel paths follow those providers' published endpoints and are
covered by tests, but have not been run with real keys yet. The first-run key check will tell you
at once if one of them disagrees.

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

## Using it with OpenCode

Tested with stable OpenCode v1.18.31. OpenCode v2 is out of scope: no `previous_response_id`
chaining, namespaces, or `additional_tools` behavior is assumed.

**Quick path**

```bash
jev-opencode   # use it exactly like `opencode`
```

That starts the gateway on `http://127.0.0.1:8791` if needed, then runs `opencode` through it
with a `jev-gateway` custom provider injected via `OPENCODE_CONFIG_CONTENT`. Your
`~/.config/opencode` files are never written, and every `opencode` flag (including `-m`) forwards
untouched. The launcher uses stable `@ai-sdk/openai-compatible`, so OpenCode speaks
`POST /v1/chat/completions` off `http://127.0.0.1:8791/v1` by default, an endpoint the gateway
already routes.

### What goes through the gateway, and what does not

Codex and Claude Code have one endpoint, so pointing them at the gateway covers everything they
send. OpenCode chooses a provider per model, and the launcher only makes a gateway model the
*default*. So:

| Request | Through the gateway? |
| --- | --- |
| Agents and subagents with no `model` of their own (`build`, `plan`, `general` out of the box) | Yes: they use the default |
| Session titles and other small-model work | Yes (`small_model` is set too), so some traffic on the dashboard does not mean your agents are covered |
| An agent with its own `model`, in `opencode.json` (`agent.<name>.model`) or in its markdown file (`model:`) | **No.** It goes straight to that model's provider, and Jev never sees it |
| A session started with `-m` / `--model` naming another provider | **No**, by your choice |

The launcher does not rewrite the models you chose. It tells you instead: before OpenCode starts,
and whenever you run `jev-opencode --status`, it lists what will bypass the gateway.

```text
jev-opencode: these go straight to their provider, not through the gateway, because they name a model of their own:
  - agent "build" (anthropic/claude-sonnet-4-5)
  - agent "reviewer" (openai/gpt-5)
Jev only sees requests to jev-gateway/* models. Agents without a model of their own use the default and are covered.
```

To bring an agent under the gateway, give it a `jev-gateway/<model>` model or remove its `model`
line. The gateway forwards to one upstream (`JEV_OPENCODE_UPSTREAM_BASE_URL`), so agents on
different providers cannot all be routed at once.

The list comes from OpenCode itself (`opencode debug config`, its own merge of every config
source), which costs about a second at start-up. `JEV_OPENCODE_CHECK=off` skips it. If OpenCode
cannot be asked, the launcher says nothing and starts as usual.

An `OPENCODE_CONFIG_CONTENT` you already set is kept, comments and trailing commas included: the
launcher lays its default models and the `jev-gateway` provider over it, and leaves the rest
(agents, permissions, other providers) alone. Content that is not a JSON object cannot be merged,
so the session gets only the launcher's settings, and the launcher says so before OpenCode starts.

On the dashboard, a gateway that shows **Idle** received nothing, which is what a bypassing agent
looks like. One that shows **Passthrough only** received requests and did not route them, with
the reason for each.

Manage it like the other launchers:

```bash
jev-opencode --gateway-help   # list launcher commands (`--help` stays opencode's own help)
jev-opencode --print-config   # opencode.json snippet to point plain `opencode` at the gateway
jev-opencode --start          # start the gateway without opening opencode
jev-opencode --stop           # stop the background gateway
jev-opencode --status         # is the gateway running, where does it forward to, and what bypasses it?
jev-opencode --dashboard      # open the monitoring dashboard in your browser
```

### Credentials and upstream

| Variable | Default | Meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | required | Authorizes the Jev tool-selection call only. Never sent as the LLM upstream credential |
| `OPENAI_API_KEY` | your key | Your LLM credential. OpenCode resolves `{env:OPENAI_API_KEY}` and the gateway forwards it untouched to the LLM upstream |
| `JEV_OPENCODE_UPSTREAM_BASE_URL` | `https://api.openai.com/v1` | Where the gateway forwards OpenCode traffic: your LLM provider, not the TypeSafe endpoint |
| `JEV_OPENCODE_MODEL` | `gpt-5` | Model selected as `jev-gateway/<model>` |
| `JEV_OPENCODE_PORT` | `8791` | Router port for OpenCode |
| `JEV_OPENCODE_CHECK` | on | `off` skips asking OpenCode which agents bypass the gateway, which saves about a second at start-up |

The gateway forwards the client's `Authorization` header to the LLM upstream. A launcher-spawned
gateway strips `UPSTREAM_API_KEY`/`ROUTER_API_KEY` by design, so the client's own key always
flows through and no gateway key swap applies on this path. (Standalone server mode can hold the
provider key with `UPSTREAM_API_KEY`; see "Running it as a server" below.)

### Manual setup

Keep the gateway running, then point plain `opencode` at it with a file, so no shell quoting is needed:

```bash
jev-opencode --start
jev-opencode --print-config   # copy the opencode.json snippet it prints
```

Chat Completions (the launcher default, stable `@ai-sdk/openai-compatible`):

```json
{
  "model": "jev-gateway/gpt-5",
  "small_model": "jev-gateway/gpt-5",
  "provider": {
    "jev-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Jev Gateway",
      "options": {
        "baseURL": "http://127.0.0.1:8791/v1",
        "apiKey": "{env:OPENAI_API_KEY}"
      },
      "models": {
        "gpt-5": {
          "name": "Jev Gateway (gpt-5)"
        }
      }
    }
  }
}
```

Responses (stable `@ai-sdk/openai` instead):

```json
{
  "model": "jev-gateway/gpt-5",
  "small_model": "jev-gateway/gpt-5",
  "provider": {
    "jev-gateway": {
      "npm": "@ai-sdk/openai",
      "name": "Jev Gateway",
      "options": {
        "baseURL": "http://127.0.0.1:8791/v1",
        "apiKey": "{env:OPENAI_API_KEY}"
      },
      "models": {
        "gpt-5": {
          "name": "Jev Gateway (gpt-5)"
        }
      }
    }
  }
}
```

Save either block as `opencode.json` in the project root or `~/.config/opencode/opencode.json`,
then select it with `opencode --model jev-gateway/gpt-5`.

`baseURL` includes `/v1`; OpenCode and the AI SDK append the rest (`/chat/completions` for
`@ai-sdk/openai-compatible`, `/responses` for `@ai-sdk/openai`). Both endpoints are routed by the
gateway above.

### Tools and routing

Native OpenCode tools and MCP tools converge on the wire to `type: "function"` function tools. MCP
naming was not captured live; the equivalence verified is the wire shape: an MCP tool arrives as
the same function-tool definition a native tool does, so the gateway offers both to Jev the same
way.

Expected modes (reported in `x-jev-gateway-mode`):

| Mode | When |
| --- | --- |
| `forced` | Jev picked a tool but some arguments are open-ended, so the LLM fills them in |
| `none` | Jev is confident no tool is needed (`tool_choice: "none"`) |
| `passthrough` | Low confidence, Jev failed, no tools, or the caller already decided. Forwarded untouched |
| `direct` | Jev picked a tool and every argument is an enum, boolean, or constant. Answered with no LLM call |

Most OpenCode tools take open text (`bash` takes a command, `read` takes a path), so `forced`
is the usual outcome: Jev picks the tool and the LLM fills in the free-form arguments. `direct`
needs a fully closed schema (only enums, booleans, or constants), which fits small MCP-style tools
with fixed choices rather than everyday file and shell tools.

The launcher sets `OPENCODE_EXPERIMENTAL_NATIVE_LLM=false` and
`OPENCODE_EXPERIMENTAL_CODE_MODE=false` for the launched process only. Those experimental modes
are outside the supported path; the stable AI SDK provider above is the supported one.

## Using it with Gemini

`jev-gemini` runs the Gemini CLI with `GOOGLE_GEMINI_BASE_URL` pointed at a gateway on port 8788,
which forwards to `https://generativelanguage.googleapis.com` (override with
`JEV_GEMINI_UPSTREAM_BASE_URL`). The gateway handles `POST /v1beta/models/<model>:generateContent`
and `:streamGenerateContent`, forces a tool through `toolConfig.functionCallingConfig`, and
proxies every other `/v1beta/*` path unchanged. Your API key travels as the client sent it, in the
`x-goog-api-key` header or the `key` query parameter.

This covers clients that use a **Gemini API key**. A Gemini CLI signed in with a Google account
talks to a different Google service and does not go through the gateway. The Gemini path has unit
tests but has not yet been run against the real API.

## Using it with Devin

`jev-devin` runs the Devin CLI with `WINDSURF_API_SERVER_URL` pointed at a gateway on port 8792,
which forwards to `https://server.codeium.com` (override with `JEV_DEVIN_UPSTREAM_BASE_URL`). The
variable's name is a leftover compiled into the `devin` binary — its inference backend is called
"windsurf" — and it is the only knob that redirects this traffic. `DEVIN_API_URL` points at a
different service (`api.devin.ai`, for auth and handoff) and is left alone.

Devin does not speak JSON REST. Its requests are Connect RPC envelopes carrying protobuf bodies,
so the gateway decodes `POST /exa.api_server_pb.ApiServerService/GetChatMessage` without a schema,
reads the messages and tools out of the wire fields, and re-encodes whatever it changed. There is
no `tool_choice` on this wire, so steering is always `hint` — a suggestion appended as one more
message — while `direct` synthesizes the Connect stream an upstream answer would have had. Every
other `exa.*` endpoint (seat management, model configuration, analytics) and every other path is
proxied opaque. Token usage is read back out of the stream's stats fields, so the dashboard meters
Devin traffic like any other client's.

Verified end to end on Devin CLI 3000.11.3: a `hint` rewrite was accepted upstream, a `direct`
answer was executed by the CLI, and the following turn — whose history carries the unsealed
synthetic call — was accepted, so the server does not enforce the `sealed` field on history.
`devin -p` and the interactive TUI share the same backend, so both go through the gateway. Other
versions were not tested; anything the decoder cannot read fails open to passthrough.

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

The gateway routes these endpoints and proxies every other path unchanged:

| Endpoint | API |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/responses` | OpenAI Responses |
| `POST /v1/messages` | Anthropic Messages |
| `POST /v1beta/models/*` | Google Gemini API (`generateContent`, `streamGenerateContent`) |
| `POST /exa.api_server_pb.ApiServerService/GetChatMessage` | Devin CLI (Connect/protobuf) |

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
| `direct` | Jev is confident about the tool and every argument is an enum, boolean, or constant | The gateway builds the tool call itself, streaming included. **No LLM call.** Never with extended thinking on (Claude Code): the next turn would replay a tool call with no thinking block, which the API rejects, so such a request gets `hint` instead |
| `forced` | Jev is confident about the tool, but some arguments are open-ended | Forwarded with `tool_choice` set to that tool, so the LLM only fills in arguments. `ARGS_MODEL` can send these to a cheaper model |
| `hint` | Jev is confident, but `tool_choice` cannot be changed (Anthropic with thinking on, or a cached conversation) | Forwarded with a one-line suggestion added after the client's last block, so cached prefixes stay valid |
| `none` | Jev is confident that no tool is needed | Forwarded with `tool_choice: "none"` |
| `passthrough` | Low confidence, the two checks disagree, Jev failed, there are no tools, or the caller already chose | Forwarded byte for byte. `x-jev-gateway-reason` says why |

Responses requests containing Codex `agent_message` items pass through without consulting Jev,
with reason `agent_message`. These carry delegated tasks or replies that the router cannot
interpret and may contain encrypted content, so the model keeps control of tool selection.
Once an `agent_message` item is in the input, every later request in the same conversation carries
it. Passthrough therefore lasts for the rest of that conversation, so a subagent session is never
routed by Jev.

Tool lists longer than 120 entries (Claude Code sends about 280) take two Jev calls. The first ranks
the list in groups. The second decides among the top 3 of each group, using full descriptions.

## Configuration

Settings are environment variables. The launchers read them from your shell,
`~/.jev-gateway/.env`, or a checkout's own `.env`. See [.env.example](.env.example) for the full
list. The ones worth knowing:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY` or `OPENCODE_API_KEY` | one is required | The key for Jev; the launchers ask for it on first run |
| `JEV_PROVIDER` | whichever key is set | `typesafe`, `openrouter`, `vercel` or `opencode` |
| `JEV_MIN_CONFIDENCE` | `0.7` | Below this confidence, the LLM decides. Lower it to route more, raise it to be more careful |
| `JEV_ARG_MIN_CERTAINTY` | `0.8` | Every argument must reach this for a `direct` answer |
| `JEV_DIRECT_CALLS` | `true` | Set to `false` so the gateway never answers without the LLM |
| `JEV_ROUTING` | `on` | Set to `off` to start in baseline mode |
| `JEV_TIMEOUT_MS` | `4000` | How long to wait for Jev before letting the LLM decide |
| `ARGS_MODEL` | unset | A cheaper model for filling arguments in `forced` mode |
| `HOST` | `127.0.0.1` | Interface to listen on. Set `ROUTER_API_KEY` before exposing it |
| `JEV_DEBUG_DUMP_DIR` | unset | Write requests and response summaries to this folder. Credentials in headers are redacted; bodies are written whole, system prompts and conversation included, in files only you can read |

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
- A gateway started by a launcher has no key of its own, because the one `Authorization` header a
  client sends belongs to its provider. Any process on your machine can therefore use it: to reach
  the provider with credentials of its own, and to ask Jev on your key through `/router/decide`.
  It is not reachable from other machines. A gateway you run as a server can require a key
  (`ROUTER_API_KEY`), and then `/health` says only that it is up.

## Benchmark

Is it worth it? [jev-gateway-bench](https://github.com/vinilana/jev-gateway-bench) measures that:
a real coding agent does the same task with routing on and off, the gateway meters every token,
and a hidden verifier scores the result. The tasks are about building, debugging and extending a
chess rules engine.

Results so far, from 120 agent sessions: six models, two chess tasks, five runs per mode, agents
run clean with no MCP servers or plugins. Medians with routing on, compared with the same model
without it:

| | Fixing bugs: output / input tokens / time | Adding a feature: output / input tokens / time |
| --- | ---: | ---: |
| GPT-6 Astra (Codex) | -57% / -7% / -39% | 0% / +2% / +8% |
| GPT-5.6 Sol (Codex) | -57% / -40% / -36% | -9% / -39% / -16% |
| GPT-5.6 Luna (Codex) | -12% / -10% / +10% | -14% / -51% / -14% |
| Fable 5.1 (Claude Code) | -13% / -19% / +6% | -24% / -27% / -26% |
| Opus 5 (Claude Code) | -7% / -22% / +2% | +22% / +61% / +83% |
| Sonnet 5 (Claude Code) | -41% / -48% / -25% | +9% / +16% / +37% |

Routing pays off when debugging, for every model. On the feature task it helped some models and
made Opus 5 and Sonnet 5 clearly worse, and GPT-5.6 Luna got cheaper but less often right (3 of 5
runs solved, against 5 of 5 without routing). Measure on your own work before trusting it: five
runs per cell is a small sample. The chart, the spread of the individual runs, the raw data, how
one run was caught copying from another, and how to run it yourself are in that repository.

## Development

```bash
pnpm install
pnpm test         # runs against fake Jev and provider transports, no keys needed
pnpm typecheck
pnpm build
```

Pull requests are welcome and run the same checks in CI. [CONTRIBUTING.md](CONTRIBUTING.md) covers
running your changes, where things live in the code, how to add a wire format or a client
launcher, and what a pull request should contain.

`scripts/mock-jev.mjs` is a local stand-in for Jev. Point `TYPESAFE_BASE_URL` at it to drive a real
agent end to end without a TypeSafe key.

Releases are automatic: release-please keeps a release pull request open, and merging it publishes
to npm through trusted publishing, with no tokens involved. See [docs/releasing.md](docs/releasing.md).

## License

MIT
