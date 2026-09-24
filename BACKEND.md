# WikiRush backend

The browser must be served by `server.js`; do not use the old static-only server for account or Elo features.

## Start locally

PowerShell:

```powershell
$env:ADMIN_PASSWORD = 'use-a-private-password-at-least-12-characters'
npm start
```

Open `http://localhost:3000`.

User `b` is created as the only admin account on first startup. The password comes from `ADMIN_PASSWORD` and is never sent to the browser.

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

Account passwords are scrypt-hashed. Sessions use HttpOnly cookies. The account file is stored under `data/accounts.json` and is ignored by Git.

This is suitable for a local prototype. For public deployment, put it behind HTTPS and use a real database with backups and rate limiting.
