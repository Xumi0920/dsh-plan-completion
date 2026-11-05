# Agent development instructions

Follow the user's current requirements and preserve the plugin's documented behavior.

## UI work

- Before changing visible UI, read [the UI design contract](docs/ui-design-contract.md). It covers DSH theme tokens, shared controls, layout, states and verification.
- Inspect the current DSH runtime and the matching native surface. Do not guess token meanings, private imports or hashed class names.
- Consolidate existing styles instead of appending another skin. Keep styles and DOM changes inside the plugin's supported surface.
- Preserve action semantics: filling a draft does not send it; model-reported completion is not tool verification; manual confirmation stays distinct.
- Verify the changed surfaces in light/dark themes and relevant narrow/long-content states. Report isolated rendering and real DSH checks separately.
- Record justified differences in the PR. Routine design choices do not require a separate approval step.

For documentation-only changes, validate factual claims, examples and links; a full runtime test run is unnecessary. See [CONTRIBUTING.md](CONTRIBUTING.md) for development and packaging checks.
