# Plant Ledger

Self-hosted houseplant tracker: searchable inventory, per-plant photo,
care-group tagging, and a soil/fertilizer/repot log. Built to run as a
single Docker container on Unraid, fronted by Nginx Proxy Manager.

## Stack

- **Backend:** Node.js + Express + better-sqlite3
- **Photos:** uploaded via the browser, resized server-side with `sharp`
  (max 800px, JPEG q74) and stored as real files under `/data/photos`,
  not base64 blobs in the DB
- **Frontend:** single static page, vanilla JS, no build step
- **Persistence:** everything lives under the `/data` volume — the
  SQLite DB and the photos folder. Back that one folder up and you have
  the whole app.

## Running it

```bash
docker compose up -d --build
```

Maps container port 3000 to host port **3210** by default (see
`docker-compose.yml`). Data persists at `/mnt/user/appdata/plant-ledger`
on the host — adjust that volume path for your own setup.

On first boot with an empty database, it seeds itself from
`seed-data.json`. Delete that file (or just ignore it) if you don't
want the starter data.

## Reverse proxy

Point your reverse proxy at `<host-ip>:3210`, HTTP (TLS terminates at
the proxy). No other app-side config needed for a new domain.

## API

| Method | Path                    | Purpose                          |
|--------|--------------------------|-----------------------------------|
| GET    | `/api/plants`            | List all plants + logs           |
| POST   | `/api/plants`             | Create a plant                   |
| PUT    | `/api/plants/:id`         | Update a plant                   |
| DELETE | `/api/plants/:id`         | Delete a plant (+ its photo)     |
| POST   | `/api/plants/:id/logs`    | Add a log entry                  |
| POST   | `/api/plants/:id/photo`   | Upload/replace photo (multipart) |
| DELETE | `/api/plants/:id/photo`   | Remove photo                     |
| GET    | `/api/export`             | Download a JSON snapshot         |

## Backup

The app has no built-in scheduled backup — back up the `/data` volume
folder the same way you back up any other appdata on your host.
