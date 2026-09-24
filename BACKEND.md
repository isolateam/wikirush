```powershell
npm start
```

Open `http://localhost:2100`.

The server always uses port `2100`, so open `http://localhost:2100`. `ADMIN_PASSWORD` is optional; if omitted, the default admin password is `bach-admin-2100`. Set `ADMIN_PASSWORD` in production to replace it.

## Vercel deployment

Vercel's deployed `/var/task` directory is read-only. The server automatically uses `/tmp/wikirush-data` when `VERCEL` is set, so startup will not fail with `ENOENT` or a read-only filesystem error. Vercel `/tmp` storage is temporary and can be cleared between invocations, so it must not be used for permanent accounts or Elo.

For production, set `DATA_DIR` only when deploying to a runtime with a writable persistent volume, or replace the JSON storage functions in `server.js` with a hosted database such as Postgres, Turso, or another persistent store. Also configure `ADMIN_PASSWORD` as a Vercel environment variable with at least 12 characters.

User `bach` is created as the only admin account on first startup. The password comes from `ADMIN_PASSWORD`, or defaults to `bach-admin-2100` when unset.

## Admin Elo controls

Log in as `b`, then use the authenticated session cookie. From the browser console, reset every account to 300 Elo:

```js
fetch('/api/admin/reset-elo', { method: 'POST' }).then(response => response.json())
```

Change one account:

```js
fetch('/api/admin/accounts/player_name/elo', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ elo: 300 })
}).then(response => response.json())
```