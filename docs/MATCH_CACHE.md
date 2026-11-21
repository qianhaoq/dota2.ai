# Durable match cache (GCS)

Parsed OpenDota matches never change. With `MATCH_CACHE_BUCKET` set, the
server keeps them in one GCS bucket (`lib/matchStore.js`), shared by every
Cloud Run instance and every deploy: a match is fetched from OpenDota once,
then served from the bucket. Pro-case candidate lists (explorer queries) are
kept there too, for 12 hours.

- `matches/{id}.json` — parsed matches only, written once (create-only).
  Unparsed matches and STRATZ fallbacks are never written.
- `results/{sha256}.json` — time-boxed results, `{ at, value }`.
- Reads are bounded (1.5 s) and every failure is a cache miss: the bucket can
  be slow, missing or misconfigured without breaking a review.
- Usage: `GET /api/health/upstream` → `matchStore` (hits, misses, writes, errors).

## One-time setup (run by the project owner)

```bash
PROJECT=aegis-assistant-488913
REGION=asia-east1
BUCKET=${PROJECT}-match-cache
SA=$(gcloud run services describe dota2-ai --region $REGION --project $PROJECT \
  --format='value(spec.template.spec.serviceAccountName)')
# Default compute SA when the service has none set:
[ -n "$SA" ] || SA="$(gcloud projects describe $PROJECT --format='value(projectNumber)')-compute@developer.gserviceaccount.com"

gcloud storage buckets create gs://$BUCKET --project $PROJECT --location $REGION \
  --uniform-bucket-level-access --public-access-prevention

# Time-boxed results expire on their own; matches stay.
cat > /tmp/lifecycle.json <<'JSON'
{"rule":[{"action":{"type":"Delete"},"condition":{"age":2,"matchesPrefix":["results/"]}}]}
JSON
gcloud storage buckets update gs://$BUCKET --lifecycle-file=/tmp/lifecycle.json

# Read + write on this bucket only.
gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
  --member="serviceAccount:$SA" --role=roles/storage.objectAdmin

gcloud run services update dota2-ai --region $REGION --project $PROJECT \
  --update-env-vars MATCH_CACHE_BUCKET=$BUCKET
```

Check: open any parsed match twice, then `curl https://dota2.ai/api/health/upstream`
shows `matchStore.writes ≥ 1` and, on another instance or after a deploy, `hits ≥ 1`.
