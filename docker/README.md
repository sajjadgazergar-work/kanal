# KANAL deployment

The minimal viable install is **4 containers** on a 2 vCPU / 4 GB box
(plan §12.7, §18.1): `api`, `worker`, `postgres`, `redis`.

## Quick start

```bash
# 1. Install docker + compose (Ubuntu 24.04):
#    curl -fsSL https://get.kanal.dev | sh   # also writes .env and generates secrets

# 2. Explicit path:
git clone <your-remote>/kanal && cd kanal
cp docker/.env.example docker/.env
cp kanal.config.example.yaml kanal.config.yaml

# 3. Fill in real secrets (placeholders are refused at boot):
#    sed -i 's/changeme-api-key-.../'"$(openssl rand -base64 32)"'/' .env
#    ... same for KANAL_MASTER_KEY, KANAL_SESSION_SECRET, KANAL_DB_PASSWORD

# 4. Bring it up:
docker compose -f docker/compose.yml up -d
docker compose -f docker/compose.yml logs -f api
```

The API is bound to `127.0.0.1:3001` and publishes **no admin port**. Put TLS
in front of it:

```nginx
# /etc/nginx/sites-available/kanal
server {
  listen 443 ssl http2;
  server_name kanal.example.com;
  ssl_certificate     /etc/letsencrypt/live/kanal.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/kanal.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # SSE needs no buffering:
    proxy_buffering off;
    proxy_cache off;
  }
}
```

## Compose variants

| Command | What it adds |
| --- | --- |
| `docker compose -f docker/compose.yml up -d` | Minimal install (4 containers) |
| `docker compose -f docker/compose.yml -f docker/compose.gpu.yml up -d` | Local vLLM or Ollama for air-gapped inference (pick a profile: `gpu-ollama` or `gpu-vllm`) |
| `docker compose -f docker/compose.yml -f docker/compose.sidecar.yml up -d` | MTProto sidecar for per-post metrics, opt-in, separate network policy |

## Security posture (plan §16.3, enforced in compose)

- Postgres and Redis are **not published** to the host.
- API binds `127.0.0.1` and requires `KANAL_API_KEY`.
- Containers run as non-root `uid 10001`, read-only root fs, `cap_drop: ALL`.
- Secrets refuse placeholder values at boot.
- The sidecar has no inbound ports and egress is limited to the Telegram DCs.
- `KANAL_PUBLISH=off` by default — flip it only after you configure Telegram.

## Backups

`postgres` writes a `pgbackup` volume. Daily backup with cron on the host:

```bash
docker compose -f docker/compose.yml exec -T postgres pg_dump -U kanal -d kanal \
  | gzip > /var/backups/kanal/$(date +%F).dump.gz
```

Restore:

```bash
gunzip -c /var/backups/kanal/YYYY-MM-DD.dump.gz \
  | docker compose -f docker/compose.yml exec -T postgres pg_restore -U kanal -d kanal
```

## Verifying a deploy

`kanal doctor` (bundled with the core CLI) exits 0 only when: all images are
up, `KANAL_API_KEY` is set, Postgres accepts `pg_isready`, and the API health
route returns 200.
