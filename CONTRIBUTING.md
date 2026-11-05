# Contributing

## Local development

This repository is a DSH plugin bundle (`dsh.bundle.patch` + `dsh.client`). It is usually linked
into a DSH profile instead of being published to npm:

```powershell
plugin_manager install_bundle target='<absolute path to this repo>'
```

After editing:

- **Host code** (`index.js`, `host/*.js`): toggle the plugin once (`plugin_manager set_plugin`
  disable + enable) so the profile recomposes and the new module instance is loaded.
- **Client code** (`client.js`): reload the DSH page (Ctrl+R). Linked local bundles do not hot-reload
  their client module.

## Tests

```powershell
node --test test/*.test.js
```

The suite has no third-party dependencies (Node `node:test` only) and runs in CI on Node 20/22.

## Conventions

- Before UI work, read [the design reference entry](docs/ui-design-contract.md), then use
  existing authorized access to read the pinned private design baseline and its task route.
  Keep this repository's business-specific boundaries and validation records here; do not
  maintain a second full copy of the private reference. Historical designs do not override
  the current baseline. [AGENTS.md](AGENTS.md) provides the Agent entry point.
- Host and Client are separate halves: the Client may only talk to the Host through
  `/plan-completion/*` same-origin HTTP routes. Keep this boundary.
- Pure logic belongs in `host/*.js` so it can be unit-tested without a DSH runtime.
- UI foreground, background and border colours use host theme tokens (`--dsw-alias-*`).
  The pinned design baseline describes contrast checks and the limited shadow fallback.
- The plugin must not modify the agent loop, prompts, tools or the session log. Plan/suggestion
  state stays in the plugin.

## Release checklist

See `docs/publish-assessment.md`. Minimum: tests green, CHANGELOG updated, no local absolute paths
in README/config, debug routes disabled by default, and `debugDir` unset in shipped config.
