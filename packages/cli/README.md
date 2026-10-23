# dota2ai

```sh
npx dota2ai review 9035042364 --hero pudge --lang en --json
npx dota2ai review 9035042364 --hero 14 --json --offline
```

Default API: `https://dota2.ai`; override with `DOTA2AI_API_BASE`.
Offline mode uses OpenDota + the bundled review engine, without LLM keys.
`OPENDOTA_API_KEY` is optional. Exit codes: 0 success (including unparsed),
2 invalid input, 3 insufficient, 4 upstream/network error.

From this monorepo, `npm pack` in `packages/cli` includes the workspace engine
and its dependencies. Run `npx --yes ./dota2ai-0.1.0.tgz review …`.
For npm versions that treat the tarball as an executable, use
`npx --yes --package ./dota2ai-0.1.0.tgz dota2ai review …`.

From the repo root, `node packages/cli/scripts/verify-packed.js` packs and runs
the CLI in isolation with the existing gzipped fixture injected as the fetch
response. It requires no keys or registry access and compares the full JSON
with the engine, including match ID, gold.low and insight IDs.
