# Plant Ledger — agent notes

This is Toni's personal houseplant tracker. Self-hosted, single-user,
no real accounts. If you're reading this, you're probably here to help
her add a plant, log a care event, manage photos, or answer a question
about her collection by talking to the live app — not to develop the
app itself (though this doc holds for that too).

Treat her plant data like anything else personal: don't delete or
overwrite something because it seemed implied. If a request is
destructive (removing a plant, removing a photo) and there's any
ambiguity about which one she means, ask rather than guess.

## Talking to the app

It's a plain HTTP + JSON API. No SDK, no auth complexity beyond one
optional shared password.

- **Base URL:** ask, or check the environment you're running in —
  locally it's usually `http://localhost:3210`, in production it's
  `https://greatestnotion.com`. Don't guess a URL you haven't confirmed.
- **Auth:** if the deployment has `AUTH_PASSWORD` set, every request
  needs HTTP Basic Auth (`curl -u anyuser:<password> ...` — the
  username is ignored, only the password is checked). If you don't
  already know the password from context, ask rather than trying
  passwords — **the app locks out after 5 wrong attempts** (exponential
  backoff, up to 15 minutes), and that lockout blocks legitimate
  requests too, including yours. Never brute-force or retry-loop this
  endpoint. Never print the password back into a transcript she didn't
  already provide it in.
- All bodies are JSON except photo upload, which is `multipart/form-data`.

## Data model

A plant:

```
{
  "id": "p1a2b3c4d5e6",
  "name": "Monstera 'Burle Marx Flame'",
  "room": "Living Room",
  "group": "group-1",
  "status": "confirmed",
  "notes": "Fenestrating well on the new leaf.",
  "propagating": false,
  "newLocation": "",
  "pricePaid": 12.5,
  "photos": [{ "id": 7, "url": "/photos/p1a2b3c4d5e6-172...jpg" }],
  "log": [{ "date": "2026-06-02", "type": "Soil", "note": "Repacked with extra perlite" }]
}
```

### `pricePaid` — number or null, not the same thing as zero

`null` means "not recorded" — she never said. `0` means she said it
explicitly was free (gifted, traded, a cutting). If she mentions a
price while adding or describing a plant, set it; if she doesn't say,
leave it `null` — don't assume `0`. The header on the live site shows
a running total (`$X.XX spent so far`) summed from every `pricePaid`
that isn't `null`, plus a count of plants where it's exactly `0`.

### `group` — fixed enum, do not invent new values

This drives a "suggested shelf" feature elsewhere in the app, so it
has to be one of exactly these five strings:

| value | meaning | use when she says something like... |
|---|---|---|
| `group-1` | Bright indirect light, keep consistently moist | "likes it moist", "don't let it dry out", most tropical foliage |
| `group-2` | Bright-medium light, let dry between waterings | "let it dry out a bit", "medium light is fine" |
| `group-3` | Bright light, drought-tolerant | "likes it dry", "drought tolerant", succulents/cacti-adjacent |
| `special` | Needs its own dedicated care approach, doesn't fit the shelf groups | anything unusual — carnivorous, orchid, aquatic, etc. |
| `unsure` | Not sorted into a care group yet | default — use this if she hasn't said enough to place it, or you're not confident. **Prefer `unsure` over guessing.** |

### `status` — fixed enum

- `confirmed` — she's sure of the ID (default; use unless she signals doubt)
- `tentative` — probably right, not fully sure
- `unconfirmed` — genuine unknown ("no idea what this cutting is")

### `room` — free text, but prefer the known set

`Office`, `Living Room`, `Plant Room`, `Outside`, `Other` are the
rooms the UI pre-populates as filters/dropdown options. If she names
one of these, use it verbatim (exact spelling/casing). If she names
something else entirely (e.g. "the bathroom"), just use what she said
— `room` isn't constrained server-side.

### `propagating` — boolean

Only `true` if she explicitly says it's a cutting, offset, or
otherwise being propagated/rooted (e.g. "rooting in water",
"propagating a cutting"). Don't infer this from anything else.

### Log entries — `type` is one of `Soil` / `Fertilizer` / `Repot` / `Other`

**This ledger does not track routine watering.** It's a log of
soil/fertilizer/repot events, not a watering schedule. If she says
"I watered the pothos today," that is not something this app logs by
design — say so rather than silently filing it under `Other`, unless
she explicitly asks you to log it anyway (then use `Other`).

### Photos

Multiple per plant, ordered by upload order. Uploading never replaces
existing photos — it adds one. Server-side, every upload gets
auto-rotated, resized to fit 800×800, and re-encoded as JPEG — don't
pre-process images before sending.

## API reference

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/health` | — | no auth required |
| GET | `/api/plants` | — | full list, use this to answer questions about her collection |
| POST | `/api/plants` | `{name, room, group, status, notes, propagating, pricePaid}` | `name` and `room` required, everything else optional (defaults: `group: "unsure"`, `status: "confirmed"`, `pricePaid: null`) |
| PUT | `/api/plants/:id` | any subset of the same fields | partial update, only send what's changing |
| DELETE | `/api/plants/:id` | — | **destructive** — confirm with her first |
| POST | `/api/plants/:id/logs` | `{type, note}` | date is set server-side to today |
| POST | `/api/plants/:id/photos` | multipart, field name `photo` | adds one photo; call once per file for multiple |
| DELETE | `/api/plants/:id/photos/:photoId` | — | removes one specific photo by its numeric id (from the `photos` array) |
| GET | `/api/export` | — | full JSON snapshot, useful if she asks "what do I have" in bulk |
| GET | `/api/claude-snapshot` | — | everything `/api/plants` has, plus every photo embedded as a base64 data URI in one response. Use this specifically when you need to actually *see* her plants (identifying something from a photo, checking on a plant's visible condition) — it's heavier, so don't use it for plain text questions `/api/plants` already answers. |
| POST | `/api/plants/bulk-update` | `{ids: [...], changes: {...same fields as PUT...}}` | applies the same partial update to every id; returns `{updated, notFound}`. Resolve names to ids via `/api/plants` first — never fuzzy-match names server-side or here. |
| POST | `/api/plants/bulk-logs` | `{ids: [...], type, note}` | adds the same log entry to every id; returns `{updated, notFound}` |
| POST | `/api/plants/confirm-moves` | `{ids: [...]}` (optional) | applies every listed plant's pending `newLocation` as its actual `room` and logs the move — same as the UI's "Confirm move" button, just for many at once. Omit `ids` to apply to every plant that currently has a pending move. |

There's deliberately no bulk delete. Removing a plant is one call per
plant, always — a single bad bulk-delete request is exactly the kind
of mistake that shouldn't be possible to make in one shot.

### Example: add a plant from a casual description

She says: *"Add the new pothos cutting in the office, it's rooting in
a jar, bright light."*

```bash
curl -s -u anyuser:$AUTH_PASSWORD https://greatestnotion.com/api/plants \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Pothos cutting (jar)",
    "room": "Office",
    "group": "group-1",
    "status": "unconfirmed",
    "propagating": true,
    "notes": "Rooting in a jar of water."
  }'
```

(`status: unconfirmed` here because it's an unidentified cutting, not
because propagating implies uncertainty — those are independent fields.)

### Example: log a repot

```bash
curl -s -u anyuser:$AUTH_PASSWORD https://greatestnotion.com/api/plants/p1a2b3c4d5e6/logs \
  -H 'Content-Type: application/json' \
  -d '{"type": "Repot", "note": "Sized up to a 6in pot, fresh chunky mix."}'
```

## Repo map (if you're changing the app itself, not just using it)

- `server.js` — the entire backend: schema, migrations, all API routes. Single file, no framework beyond Express.
- `public/index.html` — the entire frontend: one static page, vanilla JS, no build step. Styling is the "Glass Sky" blue theme (see design tokens as CSS custom properties at the top of the `<style>` block).
- `seed-data.json` — only used to seed a genuinely empty database on first boot. Never touched after that.
- `README.md` — deployment, Docker, Unraid, backup, and NPM reverse-proxy details.
- Schema changes: SQLite via `better-sqlite3`, migrations are additive and idempotent in `server.js` (see the `photos` table migration for the pattern) — never a destructive column drop against live data without asking first.

## Not built yet

This file is meant to eventually back a proper packaged Claude Skill
(`.claude/skills/plant-ledger/`) so Toni can invoke this more
formally rather than relying on CLAUDE.md auto-loading. Hasn't been
built — ask if that's wanted before assuming it exists.
