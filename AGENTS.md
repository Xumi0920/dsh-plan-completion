# Agent development instructions

Follow the user's current requirements and preserve the plugin's documented behavior.

## UI work

- Before changing visible UI, read [the design reference entry](docs/ui-design-contract.md). The shared design baseline is private repository `Xumi0920/dsh-plugin-design-system`, version 1.0.0 at commit `80ec9bc5be06d1616cfc9efaeb27c0deb289f0b5`.
- Using existing authorized access, read that commit's README.md, AGENTS.md and MANIFEST.json, then follow the relevant task route. Do not copy the complete private reference into this public repository. Report missing access without requesting tokens in chat.
- Inspect the current DSH runtime and the matching native surface. Do not guess token meanings, private imports or hashed class names.
- Consolidate existing styles instead of appending another skin. Keep styles and DOM changes inside the plugin's supported surface.
- Preserve action semantics: filling a draft does not send it; model-reported completion is not tool verification; manual confirmation stays distinct.
- Verify the changed surfaces in light/dark themes and relevant narrow/long-content states. Report isolated rendering and real DSH checks separately.
- Record justified differences in the PR. Routine design choices do not require a separate approval step.

For documentation-only changes, validate factual claims, examples and links; a full runtime test run is unnecessary. See [CONTRIBUTING.md](CONTRIBUTING.md) for development and packaging checks.
