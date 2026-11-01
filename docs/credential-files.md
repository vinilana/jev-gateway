# Decision-provider credential files

The gateway accepts the selected provider's key from either its
ordinary environment variable or `<KEY_ENV>_FILE`:

| Provider | File variable |
| --- | --- |
| TypeSafe | `TYPESAFE_API_KEY_FILE` |
| OpenRouter | `OPENROUTER_API_KEY_FILE` |
| Vercel | `AI_GATEWAY_API_KEY_FILE` |
| OpenCode | `OPENCODE_API_KEY_FILE` |

For example, a systemd service can use
`TYPESAFE_API_KEY_FILE=%d/typesafe` alongside `LoadCredential=typesafe:/runtime/key`.
The key is read once at startup and surrounding whitespace is trimmed.
The source environment and credential file are not modified.

`JEV_PROVIDER` always wins. Without it, provider detection uses the existing table
order (TypeSafe, OpenRouter, Vercel, OpenCode), considering both nonblank ordinary
keys and configured file variables. Only the selected provider's file is read;
unselected unreadable files do not prevent startup.

For the selected provider, configure one source. A nonblank ordinary value
alongside a file variable is an error. An empty ordinary value can accompany a
file. A configured empty path, unreadable file or whitespace-only file is a
startup error, with no fallback to another provider. Errors name the variable,
without logging file paths or credential values.

Launchers recognize file-only configurations and pass file variables to the
gateway for startup validation. This applies to the decision-provider credential;
interactive setup still saves an ordinary key. Upstream provider credentials
keep their existing behavior. Jev's inference-time
fail-open behavior remains unchanged.
