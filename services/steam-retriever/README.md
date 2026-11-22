# Steam retriever

A small always-on service for dota2.ai. It keeps one or more Steam accounts
logged in to the Dota 2 Game Coordinator (GC) and answers two questions over
HTTP:

| Route | Answer |
|---|---|
| `GET /match/:matchId` | `{ "match": CMsgDOTAMatch }`: the final scoreboard of all ten players, plus `cluster` and `replay_salt` (the replay's address) |
| `GET /history/:accountId?limit=20` | `501 history_unsupported` by default. See "Player history" below |
| `GET /healthz` | counts only: accounts, accounts online, today's usage. No auth |

`/match` and `/history` need `Authorization: Bearer <STEAM_RETRIEVER_SECRET>`.
The main site reads this through `lib/upstream/steamGc.js` once
`STEAM_RETRIEVER_URL` and `STEAM_RETRIEVER_SECRET` are set there. It is how
the site keeps working when OpenDota is down.

It is separate from the main app on purpose: it must run all the time on one
IP (Cloud Run instances come and go), and it has its own dependencies.

## What you need

- A machine that is always on, with about 200 MB of memory free: a GCE
  `e2-micro`, or any server you already have. Node 20.10+ or Docker.
- One to five **spare** Steam accounts. Do not use an account you care about.
  A new free account works; Dota 2 is added to its library on first login.
- Valve's limits, as measured by OpenDota: about 100 match requests per
  account per day and 500 per IP per day. The service stops at 95 and 480.
  The site caches every match it fetches, so this is 95 to 480 *new* matches
  a day.

## Set up

```bash
cd services/steam-retriever
npm ci --ignore-scripts

# 1. Log each account in once. Asks for the login name, the password (not
#    shown) and the Steam Guard code. Only the token Steam issues is stored.
STEAM_DATA_DIR=./data npm run login

# 2. Start it. Make the secret with: openssl rand -hex 32
STEAM_RETRIEVER_SECRET=<secret> STEAM_DATA_DIR=./data npm start

# 3. Check it.
curl -s localhost:5700/healthz
curl -s -H "Authorization: Bearer <secret>" localhost:5700/match/<a recent match id> | head -c 400
```

With Docker:

```bash
docker build -t dota2ai-steam-retriever .
docker volume create retriever-data
docker run --rm -it -v retriever-data:/data dota2ai-steam-retriever node login.mjs
docker run -d --name retriever --restart unless-stopped -p 5700:5700 \
  -v retriever-data:/data -e STEAM_RETRIEVER_SECRET=<secret> dota2ai-steam-retriever
```

Then on the main site (Cloud Run): set `STEAM_RETRIEVER_URL` to this
service's address and `STEAM_RETRIEVER_SECRET` to the same secret (Secret
Manager), and check `https://<site>/api/health/upstream` shows
`steamGc.configured: true`. To make it the first source instead of the
fallback, also set `UPSTREAM_PRIMARY=steam_gc`.

## Reaching it safely

The secret travels in a header, so do not expose plain HTTP to the internet.
Either:

- put it behind HTTPS (for example Caddy on the same machine with a domain
  name, proxying to `127.0.0.1:5700`, and run the service with
  `HOST=127.0.0.1`), or
- keep it on a private network (the VM's internal IP, reached from Cloud Run
  through Direct VPC egress) and close port 5700 to everything else.

## Settings

| Variable | Default | |
|---|---|---|
| `STEAM_RETRIEVER_SECRET` | none | Required, 24+ characters. Without it the service refuses to start |
| `STEAM_DATA_DIR` | `./data` | Tokens (`tokens/<label>.token`, mode 0600) and `quota.json` |
| `PORT`, `HOST` | `5700`, `0.0.0.0` | |
| `MAX_MATCHES_PER_ACCOUNT_DAY` | `95` | |
| `MAX_MATCHES_PER_IP_DAY` | `480` | All accounts share the machine's IP |
| `ENABLE_GC_HISTORY` | unset | `1` turns `/history` on. Only useful for the logged-in account's own games |
| `MAX_HISTORY_PER_ACCOUNT_DAY` | `300` | Only with `ENABLE_GC_HISTORY=1`. Valve publishes no limit; this is a cautious guess |
| `GC_TIMEOUT_MS` | `6000` | |

Accounts are never configured through the environment: no password is stored
anywhere, and logs name accounts only by the label you gave at login.

## Statuses

| Status | Meaning | Caller should |
|---|---|---|
| 200 | data | use it |
| 401 | missing or wrong secret | fix configuration |
| 404 `not_found` | Valve has no such match | not retry |
| 451 `valve_blocked` | Valve withholds this match | not retry here; another source may have it |
| 429 `daily_quota` | today's budget is spent; `Retry-After` is the seconds to 00:00 UTC | use another source |
| 503 `no_account_online` | no account has a GC session right now | retry later |
| 503 `busy` | too many requests are already waiting for the GC | retry in a moment, or use another source |
| 504 `gc_timeout` | the GC did not answer in time | retry later |
| 502 | the GC answered something unexpected | retry later |
| 501 `history_unsupported` | `/history` is off (the default) | not ask |

Counters reset at 00:00 UTC and survive a restart. Requests for the same
match at the same time, or again within ten minutes, cost one GC request.

## Player history

The plan was to serve a player's recent matches from the GC
(`k_EMsgDOTAGetPlayerMatchHistory`). Measured against the live GC on
2026-11-22: it answers that request for the logged-in account itself, and
sends no reply at all for any other account (several request shapes tried,
with accounts whose match data is public; match details and profile cards for
the same accounts were answered). So the route is off by default and the site
does not use the GC for recent matches (its fallback for those is the Steam
Web API, `lib/upstream/steamWebApi.js`). Match details are unaffected.

## Upkeep

- **Token expiry.** A token lasts about 200 days and the service renews it
  while running. If an account shows `needs_login` in the log (password
  changed, token revoked or expired), run `npm run login` for it again with
  the same label and restart.
- **Valve changes the protocol.** `proto/dota_retriever.proto` is the small
  part of Valve's definitions this service uses. `npm run verify-protos`
  compares it with the current upstream definitions.
- **Logs** go to stdout: account state changes and a summary every ten
  minutes. They never contain a token, a password or a login name.
