# @dota2ai/review-engine

Pure match-review logic shared through an ESM workspace package. Legacy lib imports remain available through re-export shims. No network requests or credentials are required.

The bundled hero table provides offline name and slug fallbacks; live metadata takes priority. Its patch and source date are recorded in data/static-heroes.json.

Run `npm run build:types -w @dota2ai/review-engine` to generate declarations in dist, or `npm run typecheck -w @dota2ai/review-engine` to check JavaScript without emitting.
