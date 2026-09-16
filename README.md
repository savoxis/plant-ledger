# Plant Ledger

Self-hosted houseplant tracker: searchable inventory, per-plant photo,
care-group tagging, and a soil/fertilizer/repot log. Runs as a single
Docker container on Unraid, fronted by Nginx Proxy Manager (NPM) at
`greatestnotion.com`.

## Architecture

```
Browser  --HTTPS-->  NPM (TLS termination, port 443)  --HTTP-->  container:3210  ->  host:3000  ->  Express app
                                                                                                        |
                                                                                                        v
                                                                                             SQLite (/data/plants.db)
                                                                                             photos (/data/photos/*.jpg)
```

- **Backend:** Node.js 20 + Express + `better-sqlite3` (synchronous,
  file-backed, WAL mode). No separate DB server, no ORM.
- **Photos:** uploaded via the browser, resized server-side with `sharp`
  (max 800px, JPEG q74) and stored as real files under `/data/photos`,
  not base64 blobs in the DB.
- **Frontend:** one static HTML page (`public/index.html`), vanilla JS,
  no build step, no framework, no bundler.
- **Persistence:** everything that matters lives under the `/data`
  volume — `plants.db` and `photos/`. Nothing else in the container is
  stateful; the container itself is fully disposable.
- **Auth:** none, by design. See [Exposure & access control](#exposure--access-control).

### Data model

Two tables, `plants` and `logs` (one-to-many, `ON DELETE CASCADE`). See
`server.js` for the full `CREATE TABLE` statements — that file is the
source of truth for schema, not this doc.

### Boot sequence

1. Ensure `/data` and `/data/photos` exist.
2. Open the SQLite DB, enable WAL, create tables if missing (idempotent —
   safe on every restart).
3. If the `plants` table is empty, seed it once from `seed-data.json`
   (decoding any embedded base64 photos into real files). This only
   fires on a genuinely empty DB, so it will not re-seed or duplicate
   data on a normal restart.
4. Start Express on `PORT` (default 3000).

## Running it

```bash
docker compose up -d --build
```

Maps container port 3000 to host port **3210** (`docker-compose.yml`).
Data persists at `/mnt/user/appdata/plant-ledger` on the host — adjust
that volume path for your own setup.

On first boot with an empty database, it seeds itself from
`seed-data.json`. Delete that file (or ignore it) if you don't want the
starter data.

## API

| Method | Path                    | Purpose                          |
|--------|--------------------------|-----------------------------------|
| GET    | `/api/health`             | Liveness check (used by Docker `HEALTHCHECK`) |
| GET    | `/api/plants`            | List all plants + logs           |
| POST   | `/api/plants`             | Create a plant                   |
| PUT    | `/api/plants/:id`         | Update a plant                   |
| DELETE | `/api/plants/:id`         | Delete a plant (+ its photo)     |
| POST   | `/api/plants/:id/logs`    | Add a log entry                  |
| POST   | `/api/plants/:id/photo`   | Upload/replace photo (multipart) |
| DELETE | `/api/plants/:id/photo`   | Remove photo                     |
| GET    | `/api/export`             | Download a JSON snapshot         |

No route requires a token, cookie, or header. Anything that can reach
the container on its listening port has full read/write/delete access.

## Exposure & access control

**This app ships with zero authentication.** That's an acceptable
tradeoff on a LAN-only reverse proxy and a real liability the moment
it's forwarded to a public domain like `greatestnotion.com`, because at
that point anyone who finds the URL can view, edit, or delete your
plant inventory and swap in their own photos.

The chosen mitigation for this deployment: lock the door at the reverse
proxy with an **NPM Access List** as the primary control, plus a simple
app-level backstop — HTTP Basic Auth checked against a single shared
password from the `AUTH_PASSWORD` env var — in case the Access List
ever gets removed or misconfigured on the NPM side.

### App-level lock (`AUTH_PASSWORD`)

- Copy `.env.example` to `.env`, set `AUTH_PASSWORD` to a real password,
  and `docker compose up -d --build` (compose reads `.env`
  automatically). `.env` is gitignored — never commit it.
- Any username works with HTTP Basic Auth; only the password is
  checked, against a constant-time comparison.
- `/api/health` is exempt so Docker's own `HEALTHCHECK` (which sends no
  credentials) keeps working.
- If `AUTH_PASSWORD` is unset or empty, the lock is disabled and the
  app logs a warning on startup — it does not fail closed. Don't rely
  on this alone; it's a backstop behind the NPM Access List, not a
  replacement for it.
- This is a single shared password with no rate limiting, no lockout,
  and no per-user accounts. Fine as a second layer behind NPM. Not
  something to expose directly to the internet on its own.

### NPM proxy host — what it needs to be set to

**Important:** this repository has no record of what your NPM instance
is actually configured to do. NPM's proxy host config lives in its own
SQLite DB on the Unraid host, in NPM's own container — it is not part
of this codebase and this session has no access to it. Nothing below
is "confirmed as built"; it's the spec this app requires. Check your
NPM UI (Hosts -> Proxy Hosts -> the `greatestnotion.com` entry) against
this list yourself, or paste me its settings and I'll tell you what's
wrong.

Required, on the **Details** tab:

- Domain Names: `greatestnotion.com` (and `www.` if you want it)
- Scheme: `http` (TLS terminates at NPM; the app has no cert and no
  HTTPS listener)
- Forward Hostname/IP: your Unraid host's LAN IP (not `localhost`,
  not the container name unless NPM and the app share a Docker network)
- Forward Port: `3210`
- Websockets Support: **off** — the app has no websocket/SSE endpoints,
  no need to enable it
- Block Common Exploits: **on**

On the **SSL** tab:

- A valid cert (Let's Encrypt is fine) with **Force SSL** and **HTTP/2
  Support** on. There's no reason to ever serve this over plain HTTP
  once a cert exists.

On the **Access List** tab (this is the actual security control here):

1. Create an Access List (Security -> Access Lists, or the dropdown on
   the proxy host itself) with either:
   - HTTP Basic Auth: one or more username/password pairs, or
   - IP allowlist under "Access": satisfy `any` with the networks that
     should get in without a prompt (e.g. your home/VPN CIDR), and
     require auth for everything else.
2. Attach that Access List to the `greatestnotion.com` proxy host.
3. Verify from a browser in a private window that hitting the domain
   cold prompts for credentials before it ever reaches `/api/plants`.

If that Access List isn't there yet, treat this as the one item to fix
before calling this deployment done — everything else in this doc is
housekeeping, this is the thing standing between your plant photos and
the open internet.

## Resilience — what changed and why

This app now assumes it will run untouched for months at a time on a
home server that nobody is babysitting. Changes made with that in mind:

- **`package-lock.json` is now committed.** The original `package.json`
  used caret ranges (`^11.3.0`, `^0.35.4`) on `better-sqlite3` and
  `sharp` — both native modules — with no lockfile. A rebuild a year
  from now (`docker compose up --build`) would have silently resolved
  whatever the newest matching version was at that moment, native
  bindings and all, with zero reproducibility. Dockerfile now runs
  `npm ci` instead of `npm install`, so builds are pinned and
  deterministic. **When you deliberately want to move dependency
  versions forward, run `npm update` (or bump manually) and commit the
  new lockfile — don't delete it to "fix" a build.**
- **Multi-stage Dockerfile.** Build tools (`python3 make g++ vips-dev`)
  now live only in the build stage; the runtime image just has the
  compiled `node_modules` and the `vips` runtime lib. Smaller image,
  smaller attack surface, faster `docker compose up --build` after the
  first one (better layer caching).
- **Runs as a non-root user** (`app`) instead of root inside the
  container.
- **`HEALTHCHECK` added**, hitting `/api/health` every 30s. Docker will
  now report and can act on a hung-but-still-running process, not just
  a crashed one. `restart: unless-stopped` was already correct for
  surviving crashes and host reboots — this closes the gap where the
  process is alive but wedged.
- **Graceful shutdown** (`server.js`): `SIGTERM`/`SIGINT` now drain the
  HTTP server and close the SQLite handle cleanly instead of letting
  Docker SIGKILL the process after its default 10s grace period. A
  10-second force-exit timer is also in place in case a stuck upload
  never drains.
- **Crashes loud instead of hanging silent.** `uncaughtException` and
  `unhandledRejection` handlers now log and `process.exit(1)` rather
  than leaving the process in an undefined state — combined with
  `restart: unless-stopped`, an unexpected error now means a few
  seconds of downtime and a restart, not a slow zombie that serves
  errors for weeks until someone notices.
- **Log rotation** added to `docker-compose.yml` (`max-size: 10m`,
  `max-file: 3`). Docker's default `json-file` driver has no cap —
  left alone, container logs grow forever and can fill the appdata
  disk on a host that runs for years.
- **Memory limit** (`mem_limit: 512m`) added so a leak or a pathological
  image upload can't take down the whole Unraid box.
- **Removed `plant-ledger-docker.tar.gz`** from git. It was a stale,
  manually-made snapshot of the source tree checked in as a binary —
  it would silently drift out of sync with real commits and just
  bloats the repo. The actual deployable artifact is the Docker image
  built from this repo; there's no reason to also ship a tarball copy
  of the source inside the source.

### Still worth doing (not done here — needs a decision from you)

- **Backups aren't automated by Docker or this repo.** A backup script
  is provided at `scripts/backup.sh` — it does a live, consistent
  SQLite backup (via `sqlite3 .backup`, so it's safe to run while the
  app is up) plus the photos folder, tars it, and prunes anything older
  than 30 days. It runs on the **host**, not in the container. Wire it
  up with Unraid's User Scripts plugin or a host crontab, e.g. daily at
  3am:
  ```
  0 3 * * * /mnt/user/appdata/plant-ledger/scripts/backup.sh
  ```
  Point it somewhere off the same disk as `/data` (or off the box
  entirely) if you want it to survive a drive failure, not just a
  container failure.
- **No offsite/3-2-1 copy of backups** — that's a "where do backups
  go" decision for your infrastructure, not something this repo can
  decide for you.
- **No uptime monitoring** — `/api/health` exists specifically so
  something like Uptime Kuma, Healthchecks.io, or NPM's own status
  page can watch it from outside the container.

## Backup

Run `scripts/backup.sh` on the host (see above), or manually:

```bash
tar -czf plant-ledger-backup-$(date +%F).tar.gz -C /mnt/user/appdata/plant-ledger .
```

The `/data` volume is the entire application state. Anything backing
that folder up on a schedule covers the whole app.
