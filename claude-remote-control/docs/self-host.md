# Self-Hosting 247

Panduan lengkap untuk menjalankan 247 Agent di server lokal atau LAN.

## Gambaran Umum

247 Agent dapat di-host di server lokal untuk diakses dari browser di jaringan yang sama (LAN) atau melalui koneksi remote. Dokumentasi ini mencakup:

- Setup Docker container
- Konfigurasi systemd service
- Manajemen tmux session resume
- Keamanan dan firewall
- Troubleshooting

## Persyaratan Sistem

- **OS**: Linux (Ubuntu 20.04+, Debian 11+, atau distribusi modern lainnya)
- **Node.js**: v22 atau lebih baru
- **pnpm**: v9.15.1 atau lebih baru
- **tmux**: v1.9 atau lebih baru
- **Docker**: v20.10 atau lebih baru (opsional, untuk containerized deployment)

## Instalasi

### 1. Install Dependencies

```bash
# Install Node.js dependencies
pnpm install

# Build packages
pnpm build

# Install CLI globally (opsional)
pnpm --filter 247-cli bundle
npm install -g ./packages/cli/dist/247-cli-*.tgz
```

### 2. Inisialisasi Konfigurasi

```bash
247 init
```

Command ini akan:
- Membuat direktori konfigurasi di `~/.247/`
- Membuat direktori tmux di `~/.247/tmux/` (Linux only)
- Menghasilkan file konfigurasi default

### 3. Install sebagai Systemd Service (Linux)

```bash
247 service install --enable --start
```

Flag yang tersedia:
- `--enable`: Aktifkan service saat boot
- `--start`: Mulai service setelah install
- `--linger`: Aktifkan systemd linger (agar service tetap jalan tanpa user login)

## Konfigurasi

### File Konfigurasi

Konfigurasi utama terletak di:
```
~/.247/config.json
```

Struktur konfigurasi:
```json
{
  "agent": {
    "port": 4678,
    "host": "0.0.0.0"
  },
  "tmux": {
    "enabled": true
  }
}
```

### Variabel Environment

Environment variables yang didukung:

| Variable | Deskripsi | Default |
|----------|-----------|---------|
| `AGENT_247_HOME` | Override home directory (untuk testing) | `~` |
| `AGENT_PORT` | Port agent | `4678` |
| `AGENT_HOST` | Host binding | `0.0.0.0` |

## Protocol dan Koneksi

### Page Protocol Detection

247 menggunakan **page protocol detection** untuk menentukan protokol koneksi ke agent:

- Jika halaman diakses via `http://` → koneksi ke agent menggunakan `ws://` dan `http://`
- Jika halaman diakses via `https://` → koneksi ke agent menggunakan `wss://` dan `https://`

**Contoh:**

```javascript
// Di browser dengan page protocol http://
buildWebSocketUrl('localhost:4678', '/ws')
// → ws://localhost:4678/ws

// Di browser dengan page protocol https://
buildWebSocketUrl('192.168.1.100:4678', '/ws')
// → wss://192.168.1.100:4678/ws
```

**Penting:** Agent selalu berjalan di plain HTTP/WS (tanpa TLS). Untuk HTTPS:
- Gunakan reverse proxy (nginx, Caddy) dengan SSL termination
- Atau gunakan Tailscale/Cloudflare Tunnel

### Akses via LAN

Untuk mengakses dari device lain di jaringan lokal:

1. Pastikan firewall mengizinkan port 4678:
```bash
sudo ufw allow 4678/tcp
```

2. Buka browser di device lain:
```
http://192.168.x.x:3001
```

3. Masukkan URL agent:
```
http://192.168.x.x:4678
```

## Docker Deployment

### Build Docker Image

```bash
docker build -f apps/web/Dockerfile -t 247-web:latest .
```

### Jalankan dengan Docker Compose

```bash
docker-compose up -d
```

### Konfigurasi Docker Compose

File `docker-compose.yml` di root:

```yaml
services:
  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
    ports:
      - "0.0.0.0:3001:3001"
    volumes:
      - web-data:/app/data
    environment:
      WEB_AUTH_SECRET: ${WEB_AUTH_SECRET:-}
      WEB_DB_PATH: /app/data/web.db
      NODE_ENV: production
      VAPID_PRIVATE_KEY: ${VAPID_PRIVATE_KEY:-}
      NEXT_PUBLIC_VAPID_PUBLIC_KEY: ${NEXT_PUBLIC_VAPID_PUBLIC_KEY:-}
    restart: unless-stopped

volumes:
  web-data:
```

> **⚠️ `WEB_AUTH_SECRET` wajib diset di production.** Container akan fail-closed (menolak start) jika `WEB_AUTH_SECRET` kosong atau tidak memenuhi entropi minimum (32 bytes). Di Docker Compose, set melalui file `.env` atau secret manager. Di environment development/native, secret di-generate otomatis dan dipersist ke `web.db` — tapi di production Anda **harus** menyediakannya sendiri.

### .dockerignore

File `.dockerignore` telah dikonfigurasi untuk mengizinkan `apps/web` dalam build context:

```dockerignore
# Web app - included for web Dockerfile
apps/web/

# Agent app (jika tidak dibutuhkan dalam web image)
apps/agent/
```

## tmux Session Resume

### Cara Kerja

247 menggunakan **tmux-resurrect** dan **tmux-continuum** untuk persisten session:

1. **Auto-save**: tmux-continuum menyimpan session setiap 15 menit ke `~/.247/tmux/resurrect/`
2. **Auto-restore**: Saat service start, session sebelumnya di-restore
3. **Process resume**: Mapping khusus untuk AI CLI tools:
   - `claude` → `claude --continue` (resume last conversation)
   - `codex` → `codex resume --last`
   - `gemini`, `qwen` → restore process name saja

### Konfigurasi tmux

File `~/.tmux.conf` akan ditambahkan blok managed oleh 247:

```tmux
# >>> 247 managed >>>
set -g exit-empty off
set -g @resurrect-dir '/home/user/.247/tmux/resurrect'
set -g @resurrect-capture-pane-contents 'on'
set -g @resurrect-processes '"~claude->claude --continue" "~codex->codex resume --last" "gemini" "qwen"'
set -g @continuum-restore 'on'
set -g @continuum-save-interval '15'
run-shell '/home/user/.247/tmux/plugins/tmux-resurrect/resurrect.tmux'
run-shell '/home/user/.247/tmux/plugins/tmux-continuum/continuum.tmux'
# <<< 247 managed <<<
```

### Backup Otomatis

Saat pertama kali setup, jika `~/.tmux.conf` sudah ada:
- Backup dibuat: `~/.tmux.conf.247-backup-<timestamp>`
- Blok managed ditambahkan tanpa menghapus konfigurasi user

### Uninstall

```bash
247 service uninstall
```

Command ini akan:
- Stop dan disable systemd service
- Hapus unit file
- Hapus konfigurasi tmux resume (blok managed saja)
- Tampilkan notice tentang linger (tidak auto-disable)

## Systemd Service Management

### Service Architecture

247 menggunakan **dua systemd units**:

1. **247-tmux.service**: Bootstrap tmux server
   - Type: `oneshot`
   - RemainAfterExit: `yes`
   - ExecStart: `tmux start-server`

2. **247-agent.service**: Agent utama
   - Type: `simple`
   - After: `247-tmux.service`
   - Wants: `247-tmux.service`

**Alasan:** Memisahkan lifecycle tmux server dari agent untuk menghindari session termination saat agent restart.

### Commands

```bash
# Install service
247 service install [--enable] [--start] [--linger]

# Uninstall service
247 service uninstall

# Start/Stop/Restart
247 service start
247 service stop
247 service restart

# Status
247 service status

# Logs
247 service logs
journalctl --user -u 247-agent.service -f
```

### Systemd Linger

Linger memungkinkan user service berjalan tanpa user login:

```bash
# Cek status linger
loginctl show-user $USER -p Linger

# Enable linger (dilakukan otomatis oleh service install --linger)
sudo loginctl enable-linger $USER

# Disable linger (manual setelah uninstall)
sudo loginctl disable-linger $USER
```

**Catatan:** Linger TIDAK auto-disable saat uninstall karena:
- Mungkin service lain yang menggunakan linger
- User mungkin ingin reinstall tanpa setup ulang

## Keamanan

### ⚠️ Peringatan Keamanan

**Agent tidak memiliki autentikasi built-in.** Siapapun yang dapat mengakses port agent dapat:
- Melihat semua tmux sessions
- Mengirim command ke tmux
- Mengakses terminal

### Model Ancaman Pairing Token (Track 2)

**Penerimaan Deferral:** Dalam arsitektur Track 2 (self-host di trusted LAN atau melalui https-tunnel), pairing token-leg **tidak dienkripsi**. Ini adalah keputusan arsitektur yang diterima dan terdokumentasi, bukan TODO yang tertunda.

**Mitigasi yang Diterapkan:**
- **Postur jaringan trusted:** LAN terisolasi atau https-tunnel (Tailscale/Cloudflare Tunnel)
- **TTL pendek:** Pairing code dan token HMAC kadaluarsa dalam ≤5 menit
- **Perlindungan HMAC:** Pairing flow menggunakan signature HMAC untuk integritas payload
- **Rate-limiting lookup:** Maksimal 5 percobaan gagal per IP per 10 menit (HTTP 429 setelah limit tercapai)

Kombinasi mitigasi ini memberikan perlindungan memadai untuk postur Track 2 tanpa enkripsi tambahan pada token-leg.

### ⚠️ PENTING: Konfigurasi Dashboard URL Sebelum Pairing

**Footgun Eksposur URL:** `agentAuthToken` disematkan dalam pairing link (`${dashboardUrl}/connect?token=…`) yang muncul di:
- QR code yang ditampilkan di layar agent
- Browser history di device yang melakukan pairing
- Referrer headers saat navigasi
- Log server dan proxy

**WAJIB:** Sebelum melakukan pairing, self-hoster **HARUS** mengonfigurasi `config.dashboard.apiUrl` ke dashboard lokal/LAN mereka sendiri:

```bash
# Edit ~/.247/config.json
{
  "dashboard": {
    "apiUrl": "http://192.168.1.100:3001/api"  # Ganti dengan URL dashboard lokal Anda
  }
}
```

**Cara kerja `getDashboardUrl()`:**
- Jika `config.dashboard.apiUrl` diset → gunakan nilai tersebut (hapus suffix `/api`)
- Jika tidak diset → fallback ke `http://<local-ip>:3001` (IP LAN mesin yang menjalankan Docker)

Pastikan nilai yang Anda set menunjuk ke dashboard lokal/LAN Anda, bukan domain publik.

### Agent Token Enforcement (Story 3.4)

**Enforcement ON secara default.** Agent menolak koneksi WebSocket yang tidak menyertakan token autentikasi yang valid, **kecuali** Anda secara eksplisit menonaktifkannya via environment variable.

**Cara kerja:**
- `AGENT_TOKEN_ENFORCE` default = ON (secure-by-default)
- Untuk menonaktifkan sementara (testing/legacy): set `AGENT_TOKEN_ENFORCE=false`
- Token dikirim via header `Sec-WebSocket-Protocol` sebagai subprotocol kedua setelah `"247"`
- Koneksi tanpa token valid → HTTP 401 Unauthorized sebelum socket di-destroy

**Pre-flip checklist (WAJIB sebelum mengaktifkan enforcement):**

Sebelum mengaktifkan enforcement, ikuti langkah berikut **secara berurutan**:

1. **Cek token coverage dari dashboard** (atau CLI):
   - **Docker/operator (dashboard):** Buka **User Menu → Token Coverage** di dashboard. Pastikan semua koneksi menunjukkan status "covered" (bukan "tokenless").
   - **Developer (CLI):** `pnpm --filter 247-web db:check-token-coverage` (perlu source checkout, bukan CLI npm global)

2. **Verifikasi token benar-benar berfungsi** (presence ≠ correctness):
   ```bash
   247 token --test
   ```
   Ini melakukan WS-upgrade nyata ke agent — memverifikasi token tidak hanya ada, tapi benar-benar diterima oleh agent.

3. **Aktifkan enforcement** (jika langkah 1 dan 2 sudah bersih):
   ```bash
   # Default sudah ON — hanya perlu set jika sebelumnya dimatikan
   # Hapus AGENT_TOKEN_ENFORCE=false dari environment, atau set:
   AGENT_TOKEN_ENFORCE=true
   ```

Jika ada koneksi tanpa token (token = NULL):
1. Re-pair koneksi tersebut dari dashboard
2. Proses re-pair akan otomatis menyimpan token ke database
3. Jalankan ulang langkah 1 dan 2 untuk memastikan semua koneksi sudah memiliki token

**Trust posture:**
- **Single-principal bearer secret**: `agentAuthToken` adalah rahasia tunggal untuk host-shell access
- **Trusted-LAN/https-tunnel**: Token dikirim plaintext di jaringan (tidak dienkripsi layer tambahan)
- **Posture konsisten dengan NFR5**: Aman untuk deployment LAN terisolasi atau via Tailscale/Cloudflare Tunnel
- **Plaintext-at-rest diterima**: Token disimpan plaintext di `~/.247/config.json` (host-local trust boundary)

**Catatan implementasi:**
- Enforcement logic sudah ada di Story 3.3 (dormant), Story 3.4 mengaktifkannya
- Coverage check bersifat advisory (tidak memblokir agent boot)
- Runtime fail-safe tetap aktif per-koneksi (jika token mismatch → reject)

### Firewall Configuration

**Rekomendasi:** Batasi akses ke trusted IP/subnet saja.

```bash
# Ubuntu/Debian (ufw)
sudo ufw allow from 192.168.1.0/24 to any port 4678
sudo ufw allow from 192.168.1.0/24 to any port 3001

# CentOS/RHEL (firewalld)
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="192.168.1.0/24" port port="4678" protocol="tcp" accept'
sudo firewall-cmd --reload
```

### Reverse Proxy dengan HTTPS

Untuk produksi, gunakan reverse proxy:

**Nginx example:**

```nginx
server {
    listen 443 ssl http2;
    server_name agent.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:4678;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> **⚠️ WAJIB untuk dashboard web (port 3001) di belakang nginx:** sertakan
> `proxy_set_header X-Forwarded-Proto $scheme;`. Dashboard menentukan flag
> `Secure` + prefix `__Host-` pada cookie sesi **hanya** dari header ini (request
> yang sampai ke Next selalu plain http di belakang proxy, jadi protokol URL tak
> bermakna). Tanpa header ini, cookie sesi di-set tanpa `Secure` walau diakses
> via https. Caddy dan Tailscale serve menyetel header ini otomatis.

**Caddy example:**

```caddyfile
agent.example.com {
    reverse_proxy localhost:4678
}
```

### Tunnel Alternatives

Jika tidak bisa expose port langsung:

- **Tailscale**: Zero-config VPN dengan built-in HTTPS
- **Cloudflare Tunnel**: Gratis, tidak perlu port forwarding
- **ngrok**: Development/testing

## Troubleshooting

### Service tidak start

```bash
# Cek status
247 service status

# Lihat logs
journalctl --user -u 247-agent.service --no-pager -n 50

# Cek apakah port sudah dipakai
lsof -i :4678
```

### tmux session tidak resume

```bash
# Cek apakah plugins terinstall
ls -la ~/.247/tmux/plugins/

# Cek tmux version
tmux -V  # Harus >= 1.9

# Manual restore
tmux source-file ~/.tmux.conf
tmux resurrect
```

### WebSocket connection gagal

**Symptom:** Browser tidak bisa connect ke agent.

**Check:**
1. Agent running?
```bash
247 service status
curl http://localhost:4678/health
```

2. Firewall allow port?
```bash
sudo ufw status
```

3. Page protocol match?
- Jika page `https://`, agent URL harus accessible via `wss://`
- Gunakan reverse proxy dengan SSL

### Docker build gagal

```bash
# Clean build
docker system prune -f

# Rebuild without cache
docker build --no-cache -f apps/web/Dockerfile -t 247-web .
```

### Port 4678 already in use

```bash
# Find process
lsof -i :4678

# Kill process
kill -9 <PID>

# Or change port in config
# Edit ~/.247/config.json → agent.port
```

## Advanced Configuration

### Custom tmux Resume Mapping

Edit `~/.tmux.conf` dan tambahkan mapping kustom:

```tmux
set -g @resurrect-processes '"~claude->claude --continue" "~codex->codex resume --last" "~mytool->mytool --resume" "gemini" "qwen"'
```

Format: `"~process_name->command_with_flags"`

### Disable Auto-save

Jika tidak ingin auto-save (manual only):

```bash
# Edit ~/.tmux.conf
set -g @continuum-save-interval '0'
```

### Multiple Agents

Untuk menjalankan multiple agents di server yang sama:

```bash
# Create separate configs
mkdir ~/.247-instance2
AGENT_247_HOME=~/.247-instance2 247 init

# Install with different service name
# (requires manual systemd unit creation)
```

## Monitoring

### Health Check

```bash
# Agent health endpoint
curl http://localhost:4678/health

# Response:
# {"status":"ok","uptime":3600,"sessions":2}
```

### Metrics

247 tidak memiliki built-in metrics. Untuk monitoring:

- **Logs**: `journalctl --user -u 247-agent.service -f`
- **Sessions**: `tmux list-sessions`
- **System resources**: `htop`, `iotop`

### Alerting

Setup monitoring dengan:

- **Prometheus + Grafana**: Custom exporter
- **Uptime Kuma**: HTTP health check
- **Systemd watchdog**: `WatchdogSec=30` in unit file

## Upgrade

### Upgrade Agent

```bash
# Pull latest code
git pull origin main

# Rebuild
pnpm install
pnpm build

# Restart service
247 service restart
```

### Migrate from Old Setup

Jika upgrade dari versi lama:

```bash
# Backup config
cp ~/.247/config.json ~/.247/config.json.backup

# Uninstall old service
247 service uninstall

# Install new version
npm install -g 247-cli@latest

# Reinitialize
247 init

# Restore config (if needed)
# Edit ~/.247/config.json manually
```

## Trust Model dan Manajemen Sesi (Track 2)

### Postur Keamanan Terpadu (NFR5)

Seluruh komponen 247 di Track 2 berbagi **satu postur keamanan**: jaringan trusted (LAN terisolasi) atau https/tunnel (Tailscale / Cloudflare Tunnel / reverse-proxy TLS) untuk jaringan hostile.

| Komponen | Mekanisme | Trust Posture |
|----------|-----------|---------------|
| Web session cookie | `httpOnly` + `sameSite=lax`, protocol-conditional `Secure` | Trusted LAN atau https/tunnel |
| Agent bearer token | `agentAuthToken` di header `Sec-WebSocket-Protocol` | Trusted LAN atau https/tunnel |
| Track-1 WS transport | Plain `ws://` atau `wss://` (via proxy) | Trusted LAN atau https/tunnel |

**Cross-references:**
- Model ancaman pairing token: lihat [Model Ancaman Pairing Token (Track 2)](#model-ancaman-pairing-token-track-2)
- Agent token trust posture: lihat [Agent Token Enforcement (Story 3.4)](#agent-token-enforcement-story-34)
- Nginx `X-Forwarded-Proto` cookie note: lihat [Reverse Proxy dengan HTTPS](#reverse-proxy-dengan-https)

### `WEB_AUTH_SECRET` dan Rotasi Sesi

**Provisioning:**
- **Env-first** (Docker/compose): `WEB_AUTH_SECRET` dibaca dari environment variable
- **Dev/native fallback**: Generate 32 bytes otomatis, persist ke `user_settings` table di `web.db`
- **Fail-closed di production**: Container menolak start jika `WEB_AUTH_SECRET` tidak diset atau gagal cek entropi minimum — **dua** gate: panjang ≥ 32 bytes **dan** ≥ 16 distinct byte values (menolak nilai panjang-tapi-low-entropy seperti `'a'.repeat(32)`)

**🚨 PENTING: Realitas rotasi `WEB_AUTH_SECRET` (berlawanan dengan ekspektasi epic)**

Sesi di Track 2 adalah **token opaque yang di-backup database**:
- Token di-mint sebagai `randomBytes(32)` (256-bit random)
- Hanya `sha256(raw)` yang disimpan di table `session.tokenHash` — raw token **tidak pernah** dipersist
- Validasi: hash cookie yang disajikan, lookup by `tokenHash`, reject jika missing atau expired
- **`WEB_AUTH_SECRET` TIDAK digunakan untuk menandatangani sesi** — secret ini reserved untuk future session-signing

**Implikasi:**
- ✅ **Rotasi `WEB_AUTH_SECRET` TIDAK melogout user yang sudah login** (sesi tidak di-sign dengan secret)
- ❌ Untuk invalidate semua sesi: hapus rows dari table `session` di `web.db`
  ```bash
  sqlite3 ~/.247/data/web.db "DELETE FROM session;"
  ```
  > **Docker:** path `~/.247/data/web.db` hanya berlaku untuk install native. Di Docker, DB ada di volume `web-data` — jalankan `docker compose exec <service> sqlite3 /app/data/web.db "DELETE FROM session;"`.
- ⏱️ TTL absolut sesi: **30 hari** (tidak ada sliding refresh)

**Catatan:** Ekspektasi awal epic ("rotating `WEB_AUTH_SECRET` logs everyone out") tidak sesuai dengan implementasi yang di-ship. Secret ini di-enforce keberadaannya (fail-closed) tapi belum digunakan untuk signing. Jika Anda memerlukan rotation-based session invalidation, ini memerlukan wire `WEB_AUTH_SECRET` ke session signing (out of scope Track 2).

### Deferred: `/api/push/notify` Unauthenticated (G-2)

**Risiko yang diketahui dan diterima:** Endpoint `/api/push/notify` di Track 2 **tidak diautentikasi** — hanya di-key oleh `machineId`. Ini adalah gap keamanan yang secara eksplisit di-defer (G-2) dan out of scope untuk Track 2.

**Mitigasi saat ini:**
- `machineId` adalah UUID random yang di-generate saat `247 init`
- Endpoint hanya menerima POST dengan payload `{machineId, sessionName, reason}` dan hanya mengirim push ke subscription milik user yang ter-pair dengan `machineId` tersebut (machineId yang tidak dikenal → `sent: 0`, no-op)
- **Tidak ada rate-limiting di endpoint ini** — jangan andalkan throttling bawaan; mitigasi satu-satunya adalah isolasi jaringan (LAN trusted) atau auth-layer di reverse proxy

**Untuk deployment production di jaringan hostile:** Tambahkan autentikasi layer (API key, bearer token, atau mTLS) di reverse proxy Anda sebelum request mencapai `/api/push/notify`.

## Migrasi dari Neon (Track 1 → Track 2)

### Jalur Default: Re-pair dari Dashboard

**Database web dimulai kosong di build Track 2.** Ini adalah keputusan arsitektur yang disengaja (bukan bug) — Epic 1 dengan sengaja tidak membawa data Neon ke SQLite karena:
- Self-host Neon Auth tidak pernah berfungsi (auth flow bergantung pada cloud)
- Data yang dipersist di Neon sangat sedikit atau tidak ada sama sekali
- Schema port faithful (timestamp sebagai epoch-ms, boolean sebagai integer) lebih sederhana daripada backfill

**Apa yang perlu Anda lakukan:**

1. **Upgrade ke build Track 2** (local SQLite + local auth)
2. **Re-pair setiap agent dari dashboard:**
   - Buka dashboard di browser
   - Jalankan pairing flow untuk setiap agent yang ingin Anda reconnect
   - Proses re-pair akan membuat row baru di `web.db` table `agent_connection`

3. **User preferences dan push subscription:**
   - `user_settings`: Re-enter preferences melalui UI (theme, notification settings, dll.)
   - `push_subscription`: Re-subscribe ke push notifications dari browser

**Re-pair juga memenuhi Epic 3 token enforcement gate:**

Saat Anda re-pair, `agentAuthToken` otomatis ditulis ke kolom `agent_connection.token`. Ini berarti mengikuti panduan migrasi ini **secara otomatis memenuhi** syarat flip-ON Epic 3 (setiap connection row memiliki token non-null).

Lihat [Agent Token Enforcement (Story 3.4)](#agent-token-enforcement-story-34) untuk coverage check dan pre-flip checklist.

### Escape Hatch: Ekspor Manual Neon → SQLite (Advanced/Optional)

**⚠️ Ini adalah kasus edge yang jarang diperlukan.** Hanya gunakan jika Anda memiliki data signifikan di Neon yang ingin dipertahankan (misalnya, ratusan agent connections atau user settings yang kompleks).

**Tidak ada tool migrasi otomatis.** Proses ini manual dan memerlukan akses langsung ke database Neon lama.

**Langkah-langkah:**

> **Prinsip kunci:** lakukan SEMUA transformasi schema di sisi ekspor Postgres (lewat `\copy (SELECT ...)`), supaya CSV yang dihasilkan SUDAH dalam bentuk yang benar (epoch-ms integer, boolean `0`/`1`) dengan **urutan kolom eksplisit yang cocok dengan schema SQLite**. `sqlite3 .import` memetakan kolom **by posisi**, jadi urutan harus tepat. Ekspor **tanpa** `HEADER` supaya tidak ada baris header yang ikut ter-import sebagai data.

1. **Dump + transform 3 tables dari Neon (epoch-ms + boolean→int, urutan kolom eksplisit, NO header):**
   ```sql
   -- Jalankan di psql terhubung ke Neon lama.
   -- timestamptz → epoch-MILLISECONDS: EXTRACT(epoch ...) * 1000 (cast bigint).
   -- boolean is_cloud → 0/1: is_cloud::int.
   -- Urutan kolom HARUS sama persis dengan schema.ts SQLite.
   \copy (SELECT id, user_id, machine_id, url, name, method, is_cloud::int, cloud_agent_id, color, (EXTRACT(epoch FROM created_at)*1000)::bigint, (EXTRACT(epoch FROM updated_at)*1000)::bigint, token FROM agent_connection) TO '/tmp/agent_connection.csv' WITH (FORMAT csv);
   \copy (SELECT id, user_id, key, value, (EXTRACT(epoch FROM created_at)*1000)::bigint, (EXTRACT(epoch FROM updated_at)*1000)::bigint FROM user_settings) TO '/tmp/user_settings.csv' WITH (FORMAT csv);
   \copy (SELECT id, user_id, endpoint, p256dh, auth, user_agent, (EXTRACT(epoch FROM created_at)*1000)::bigint FROM push_subscription) TO '/tmp/push_subscription.csv' WITH (FORMAT csv);
   ```

   Untuk referensi, perbedaan shape yang ditangani query di atas:

   | Kolom | Neon (Postgres) | SQLite (Track 2) |
   |-------|-----------------|------------------|
   | Timestamp columns (`created_at`/`updated_at`) | `timestamptz` | `integer` (epoch **milliseconds**, `Date.getTime()`) |
   | `agent_connection.is_cloud` | `boolean` | `integer` (`0`/`1`) |

   **Contoh konversi timestamp (sanity check):**
   ```
   '2026-06-17 10:30:00+00'  →  1781692200000   (ms; = detik 1781692200 × 1000)
   ```

2. **Import ke `web.db`** (CSV sudah tanpa header, jadi `.import` aman tanpa `--skip`):
   ```bash
   sqlite3 ~/.247/data/web.db <<'EOF'
   .mode csv
   .import /tmp/agent_connection.csv agent_connection
   .import /tmp/user_settings.csv user_settings
   .import /tmp/push_subscription.csv push_subscription
   EOF
   ```
   > **Catatan path (Docker):** command di atas memakai path **native** `~/.247/data/web.db`. Di deployment Docker, DB ada di dalam volume `web-data` (`WEB_DB_PATH=/app/data/web.db`), BUKAN di host. Jalankan lewat container, mis. `docker compose cp /tmp/agent_connection.csv <service>:/tmp/` lalu `docker compose exec <service> sqlite3 /app/data/web.db ...`.

3. **Normalisasi field kosong → NULL** (CSV menyimpan kolom kosong sebagai string `''`, bukan `NULL`; `token=''` akan dihitung sebagai *tokenless* oleh coverage check dan menggagalkan flip-ON gate Epic 3):
   ```bash
   sqlite3 ~/.247/data/web.db <<'EOF'
   UPDATE agent_connection SET token=NULL          WHERE TRIM(token)='';
   UPDATE agent_connection SET machine_id=NULL      WHERE TRIM(machine_id)='';
   UPDATE agent_connection SET cloud_agent_id=NULL  WHERE TRIM(cloud_agent_id)='';
   UPDATE agent_connection SET color=NULL           WHERE TRIM(color)='';
   EOF
   ```

4. **Verifikasi:**
   ```bash
   sqlite3 ~/.247/data/web.db "SELECT COUNT(*) FROM agent_connection;"
   # cek tidak ada timestamp yang nyasar jadi teks (harus angka epoch-ms ~13 digit):
   sqlite3 ~/.247/data/web.db "SELECT id, created_at FROM agent_connection LIMIT 3;"
   pnpm --filter 247-web db:check-token-coverage   # perlu source checkout (pnpm workspace), bukan CLI npm global
   ```

**Pertimbangan:**
- Jika Anda hanya memiliki beberapa agent connections, re-pair lebih cepat dan lebih aman
- Data `user_settings` dan `push_subscription` mudah di-recreate melalui UI
- Migration manual berisiko corrupt jika urutan kolom pada `\copy (SELECT ...)` tidak sama persis dengan urutan di `schema.ts` — `.import` memetakan by posisi tanpa error jika salah

## Support

Untuk bantuan lebih lanjut:

- **Issues**: [GitHub Issues](https://github.com/247-ai/247-agent/issues)
- **Discussions**: [GitHub Discussions](https://github.com/247-ai/247-agent/discussions)
- **Logs**: `journalctl --user -u 247-agent.service -f`

---

**Last updated**: 2026-06-17  
**Version**: Track 2 complete (Local auth + SQLite + Agent token enforcement)
