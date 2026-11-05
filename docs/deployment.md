# Deploying ClearPort

ClearPort is one Node process (the API, with background jobs inside it) plus static web files. There is no database server, no object store and no Redis: the data is one SQLite file and a folder of documents.

## 1. What you need

* A server (or an always-on PC) with **Node 24**, and **Chrome, Edge or Chromium** if you want printed PDFs (invoices, statements, report PDFs).
* A web server that terminates **HTTPS** and forwards `/api` to the API (Caddy or nginx; examples below). The API itself speaks plain HTTP and must not be exposed directly to the internet.
* Optionally a **ClamAV** daemon (`clamd`) for virus scanning of uploads.

## 2. First install

```bash
git clone https://github.com/wisosonic/ClearPort.git && cd ClearPort
npm install
npm run build -w frontend                 # produces frontend/dist
cd backend
cp .env.example .env                      # then edit, see section 3
npm run db:deploy && npm run db:generate  # database and client
npm run db:seed                           # permissions, roles, currencies, document types, ports
CLEARPORT_OWNER_PASSWORD='a-strong-password' npm run tenant:create -- \
  --name "My Office" --slug my-office --owner-email me@example.com --owner-first Me --owner-last Owner
```

Run the API with `NODE_ENV=production npm start` under a service manager so it restarts after a crash or reboot (systemd, pm2, or a Windows service such as NSSM).

## 3. Settings that matter in production (`backend/.env`)

| Variable | Set it to |
|---|---|
| `NODE_ENV` | `production` (the API then refuses an example secret or `CORS_ORIGINS=*`) |
| `JWT_ACCESS_SECRET` | 32+ random characters: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Keep it out of git. Changing it signs everyone out. |
| `CORS_ORIGINS` | the address people open, e.g. `https://office.example.com` (leave empty if the web files and `/api` share one address, which the examples below do) |
| `TRUST_PROXY` | `1` behind one proxy. Without it every request looks like it comes from the proxy, so rate limits and the audit log record the wrong address. |
| `DATABASE_URL`, `STORAGE_ROOT` | absolute paths on a disk that is backed up, e.g. `file:/var/lib/clearport/clearport.db`, `/var/lib/clearport/storage` |
| `MALWARE_SCAN` | `clamd` (with `CLAMD_HOST`/`CLAMD_PORT`). The default `builtin` only recognises the EICAR test file and is **not** anti-virus. With `clamd`, uploads are refused while the daemon is down. |
| `BACKUP_DIR`, `BACKUP_PASSPHRASE` | turn on the nightly encrypted backup (section 5) |

Do not run the API as an administrator/root user. Give it a dedicated account that can write only to the database file, `STORAGE_ROOT` and `BACKUP_DIR`.

## 4. HTTPS and serving the web app

Build the web app once (`npm run build -w frontend`) and let the web server serve `frontend/dist`, send `/api` to the API, and fall back to `index.html` for every other path (the app uses browser routing).

Caddy (HTTPS certificates are automatic):

```
office.example.com {
    root * /srv/clearport/frontend/dist
    encode gzip
    handle /api/* {
        reverse_proxy 127.0.0.1:3000
    }
    handle {
        try_files {path} /index.html
        file_server
    }
}
```

nginx (certificates from certbot or your own):

```
server {
    listen 443 ssl;
    server_name office.example.com;
    root /srv/clearport/frontend/dist;
    client_max_body_size 30m;                # a little above MAX_UPLOAD_MB
    location /api/ { proxy_pass http://127.0.0.1:3000; proxy_set_header X-Forwarded-For $remote_addr; }
    location / { try_files $uri /index.html; }
}
```

Allow only 80/443 through the firewall; port 3000 stays on the local machine.

## 5. Backups

* **Nightly encrypted backup:** set `BACKUP_DIR` and `BACKUP_PASSPHRASE` (12+ characters) and keep `BACKUP_KEEP` (default 14). The job runs inside the API. Keep the passphrase somewhere safe: **without it a backup cannot be restored.**
* **Copy them off the machine.** A backup in the same place as the database does not survive a disk or server loss. Sync `BACKUP_DIR` to another disk, a NAS or a cloud drive.
* **Check them:** `npm run backup -- verify <file>`; **restore:** `npm run backup -- restore <file>` (stop the API first). Try a restore on a spare machine before you need it.
* Documents are in `STORAGE_ROOT`; make sure the backup copy covers both the database and that folder.

## 6. Updating

```bash
git pull && npm install
npm run build -w frontend
cd backend && npm run db:deploy && npm run db:generate
# restart the API service
```

Take a backup first (`npm run backup -- create`). Migrations are applied by `db:deploy` and never run by themselves.

## 7. Before you go live

* Sign in as the owner and change the temporary password; create real users with the narrowest role that fits (Viewer, Clearance Officer, Accountant, Manager).
* In **Settings** set the office name, time zone, tax (off by default) and, if you want a second pair of eyes on costs, *Someone else must approve an expense*.
* In **Accounting → Exchange rates** record the current rates for every foreign currency you use. Nothing is booked in a currency without a rate.
* Run a test file end to end (client, file, documents, invoice, payment), print the invoice PDF, then take and verify a backup.
* Open the app on a phone and in Arabic once; check the layout reads right-to-left.
