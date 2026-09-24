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

You need Node.js 22.15 or newer, a key for Jev (from TypeSafe, OpenRouter or Vercel AI Gateway, see
[Where Jev runs](#where-jev-runs)), and Codex, Claude Code, and/or OpenCode already installed and
logged in.

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
Choose 1-3 [1]:
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

All of these work with `jev-codex`, `jev-claude`, `jev-opencode` and `jev-gemini`.

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

Codex uses port 8790, Claude Code 8789, OpenCode 8791 and Gemini clients 8788. Change them with
`JEV_CODEX_PORT`, `JEV_CLAUDE_PORT`, `JEV_OPENCODE_PORT` and `JEV_GEMINI_PORT`.

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

Jev is served by TypeSafe and by two gateways that resell it. All three take the same questions
and return the same answers, so the choice is about whose account and billing you want to use.

| Provider | Key variable | Default model | Get a key |
| --- | --- | --- | --- |
| TypeSafe (official) | `TYPESAFE_API_KEY` | `jev-latest` | [typesafe.ai](https://typesafe.ai) |
| OpenRouter | `OPENROUTER_API_KEY` | `typesafe/jev-1.13` | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | `typesafe-ai/jev` | [Vercel dashboard](https://vercel.com/dashboard/ai-gateway/api-keys) |

`jev-codex --setup` (or any other launcher) switches between them and restarts the gateway with the
new key. To configure it by hand instead, put `JEV_PROVIDER` and the matching key in
`~/.jev-gateway/.env` or in your environment. Without `JEV_PROVIDER`, the gateway uses whichever key
it finds, TypeSafe's first. `JEV_MODEL` picks another model; an id written for one provider is
ignored under another, because the providers name their models differently. `--status` and the
dashboard show which provider is in use.

With no terminal to ask in (CI, scripts), a launcher does not wait for input: it exits and names
the variables it looked for.

The TypeSafe path is run against the real API. The OpenRouter and Vercel paths follow those
providers' published endpoints and are covered by tests, but have not been run with real keys yet.
The first-run key check will tell you at once if one of them disagrees.

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

The gateway's request handling was tested with stable OpenCode v1.18.31. On v2.0.16, a real
Zen session reached the gateway, but a project with a Go default model started a Zen gateway
because this branch did not discover the selected model. That Go session would bypass the gateway.
[#43](https://github.com/vinilana/jev-gateway/pull/43) addresses v2 startup and discovery. No
`previous_response_id` chaining, namespaces, or `additional_tools` behavior is assumed here.

**Quick path**

```bash
jev-opencode   # use it exactly like `opencode`
```

That starts the gateway on `http://127.0.0.1:8791` if needed, then runs `opencode` through it,
pointed at the gateway through `OPENCODE_CONFIG_CONTENT`. The launcher reads your OpenCode config
to decide where the gateway forwards (see below). Your `~/.config/opencode` files are never
written, and every `opencode` flag (including `-m`) forwards untouched.

### What goes through the gateway, and what does not

Codex and Claude Code have one endpoint, so pointing them at the gateway covers everything they
send. OpenCode chooses a provider per model. The launcher points either the selected default
model's provider or a `jev-gateway` fallback at the gateway. So:

| Request | Through the gateway? |
| --- | --- |
| Agents and subagents with no `model` of their own (`build`, `plan`, `general` out of the box) | Yes, when the default uses the provider pointed at the gateway |
| Session titles and other small-model work | Through the gateway when `small_model` uses that provider. The `jev-gateway` fallback sets `small_model` too |
| An agent with its own `model`, in `opencode.json` (`agent.<name>.model`) or in its markdown file (`model:`) | Yes if it uses the provider pointed at the gateway; otherwise no |
| A session started with `-m` / `--model` | Yes if that model uses the provider pointed at the gateway; otherwise no |

The launcher does not rewrite the models you chose when it follows a provider. Before OpenCode
starts, and whenever you run `jev-opencode --status`, it lists what will bypass the gateway.

```text
jev-opencode: these go straight to their provider, not through the gateway, because they name a model of their own:
  - agent "build" (anthropic/claude-sonnet-4-5)
  - agent "reviewer" (openai/gpt-5)
Jev sees requests sent to http://127.0.0.1:8791. Agents without a model of their own use the default.
```

To bring an agent under the gateway, select a model on the provider the launcher moved, or remove
its `model` line to use the covered default. On the `jev-gateway` fallback, select a
`jev-gateway/<model>` model instead. The gateway forwards to one upstream, so agents on
different providers cannot all be routed at once.

The list comes from OpenCode's resolved config, which costs about a second at start-up.
`JEV_OPENCODE_CHECK=off` skips this coverage check, but still reads the config to choose an
upstream. If OpenCode cannot be asked for the coverage check, the launcher says nothing and
starts as usual.

An `OPENCODE_CONFIG_CONTENT` you already set is kept, comments and trailing commas included. The
launcher adds the selected provider's `baseURL`, or lays its default models and the
`jev-gateway` provider over it on the fallback. It leaves other settings alone. Content that is
not a JSON object cannot be merged, so the session gets only the launcher's settings from this
variable, and the launcher says so before OpenCode starts.

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

### Where OpenCode traffic goes

The launcher asks OpenCode for its resolved default `model` and provider, including the config
sources OpenCode itself loads. It uses `opencode debug config` in v1 and the local API when that
is unavailable. If the query fails, it uses the fallback rows. The first row that applies wins:

| Your setup | The gateway forwards to | What the launched OpenCode gets |
| --- | --- | --- |
| `JEV_OPENCODE_MODEL` is set | `JEV_OPENCODE_UPSTREAM_BASE_URL`, else `https://api.openai.com/v1` | A `jev-gateway` provider with that model, keyed by `{env:OPENAI_API_KEY}` |
| Default model on `opencode/` | `https://opencode.ai/zen/v1` | Only `opencode` gets the gateway `baseURL`; its model stays selected |
| Default model on `opencode-go/` | `https://opencode.ai/zen/go/v1` | Only `opencode-go` gets the gateway `baseURL`; its model stays selected |
| Default model on an `@ai-sdk/openai-compatible` provider with a safe API root | That provider's resolved `baseURL` | Only that provider gets the gateway `baseURL`; its model stays selected |
| No provider above, `OPENAI_API_KEY` set | `https://api.openai.com/v1` | `jev-gateway/gpt-5`, as before |
| No provider above, no `OPENAI_API_KEY`, `OPENCODE_API_KEY` set | `https://opencode.ai/zen/v1` | Only `opencode` gets the gateway `baseURL`; other models still bypass it |
| No provider above or key set | `https://api.openai.com/v1` | `jev-gateway/gpt-5`, as before |

`JEV_OPENCODE_UPSTREAM_BASE_URL` replaces the address in every row. An unsafe explicit address
stops the launcher with an error instead of starting a gateway pointed at it.

When a provider is moved, only its `baseURL` changes. Its key and models stay as you set them, so
OpenCode sends the credential it already has (`opencode auth login`, `{env:...}`, or a key in the
file) and the gateway forwards it. The launcher never copies a key. Every agent and subagent
using that provider goes through Jev. Agents on other providers do not.

Zen and Go use separate upstreams. When the selected provider is detected, the launcher moves
only that provider, so a Go model is not sent to Zen by this setup. The v2 discovery limit above
can leave Go traffic outside the gateway. Billing with a real OpenCode login has not been verified.
`OPENCODE_API_KEY` is an LLM credential here; Jev still needs one of the keys listed in
[Where Jev runs](#where-jev-runs).

An unsupported provider (such as Anthropic or Google), a URL with a token in its path, query, or
fragment, an unresolved `{env:...}` or `{file:...}` address, or a gateway address cannot be
followed. The launcher then uses a fallback row. Detection uses the working directory, and one
gateway serves one upstream. Moving to a project whose config leads elsewhere requires
`jev-opencode --stop` first.

The detection and config changes are unit-tested with stub OpenCode responses and config. On
2026-09-24, a real v2.0.16 Zen session using `glm-5.3-flash` returned `GATEWAY_OK` through this
gateway, which recorded HTTP 200. Its coverage notice incorrectly said that the session bypassed
the gateway. Go-default discovery on this branch failed as described above; a real Go launch and
billing have not been verified on this branch. #43 reports separate real Go end-to-end tests.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENAI_API_KEY` | your key | On the OpenAI rows, your LLM credential. OpenCode resolves `{env:OPENAI_API_KEY}` and the gateway forwards it untouched |
| `OPENCODE_API_KEY` | unset | LLM credential for the OpenCode Zen fallback; OpenCode may also use a saved login |
| `JEV_OPENCODE_UPSTREAM_BASE_URL` | follows the table | Where the gateway forwards OpenCode traffic: your LLM provider, not the Jev endpoint |
| `JEV_OPENCODE_MODEL` | unset | Skip the config and use `jev-gateway/<model>` |
| `JEV_OPENCODE_PORT` | `8791` | Router port for OpenCode |
| `JEV_OPENCODE_CHECK` | on | `off` skips asking OpenCode which agents bypass the gateway, which saves about a second at start-up |

The gateway forwards the client's `Authorization` header to the LLM upstream. A launcher-spawned
gateway strips `UPSTREAM_API_KEY`/`ROUTER_API_KEY` by design, so the client's own key always
flows through and no gateway key swap applies on this path. (Standalone server mode can hold the
provider key with `UPSTREAM_API_KEY`; see "Running it as a server" below.)

### Manual setup

Keep the gateway running, then point plain `opencode` at it with a file, so no shell quoting is needed.
`--print-config` prints the snippet for your setup: the selected provider's moved `baseURL` when
the launcher follows one, or the `jev-gateway` provider below otherwise. After moving a custom
provider's `baseURL` in the file, its real address is no longer there to detect, so start the
gateway with `JEV_OPENCODE_UPSTREAM_BASE_URL` set to it; `--print-config` shows the command.

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

The gateway routes four endpoints and proxies every other `/v1/*` or `/v1beta/*` path unchanged:

| Endpoint | API |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/responses` | OpenAI Responses |
| `POST /v1/messages` | Anthropic Messages |
| `POST /v1beta/models/*` | Google Gemini API (`generateContent`, `streamGenerateContent`) |

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
| `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY` or `AI_GATEWAY_API_KEY` | one is required | The key for Jev; the launchers ask for it on first run |
| `JEV_PROVIDER` | whichever key is set | `typesafe`, `openrouter` or `vercel` |
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
