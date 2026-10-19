# OpenCode V2 final-request plugin

Use the optional native V2 plugin with an already-running Jev gateway. It
redirects configured final HTTP inference requests after provider authentication,
preserving the selected model, authentication headers, query, streamed body and
cancellation. It does not start a gateway or change the client's config files.

Place it after authentication and provider plugins in your OpenCode config:

```json
{
  "plugins": [{
    "package": "jev-gateway",
    "options": {
      "routes": {
        "https://api.anthropic.com/v1/messages": "http://127.0.0.1:8792/v1/messages"
      }
    }
  }]
}
```

The source must be the final URL produced by the provider/authentication plugin.
For a local installation, set `package` to the installed `jev-gateway` directory;
its manifest exports the V2 `server` entrypoint without a generated root shim.
For a local Meridian backend, use its loopback `/v1/messages` URL as the source
and configure Jev's upstream to that backend. Each gateway has its own upstream;
the route map does not change the gateway's routing engine.

Only POST requests to declared origin/path pairs are redirected. Source query
parameters are forwarded intact. Destinations must be HTTP loopback endpoints
on `127.0.0.1` or `[::1]`, with an explicit port and no URL credentials, query or
fragment. Source keys cannot contain credentials, query or fragment either.

Unmatched inference requests pass through by default, as do discovery and
authentication requests. Set `options.unmatched = "reject"` to explicitly reject
unconfigured supported inference paths. That policy only covers route-map
admission; Jev's inference-time fail-open behavior is unchanged. Disposal releases
the hook once and leaves the gateway running.

The native hook requires V2's `http.request` API. OpenCode 1.x users retain the
existing launcher. Offline tests exercise request streams, post-auth headers,
query, abort, strict mode and cleanup; actual subscription access is separate.
