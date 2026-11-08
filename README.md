# Co-Living Room Finder

A two-sided co-living marketplace:

- **Renters** browse rooms in shared homes (search + filters by city, max rent, room type, furnished), open a room's full details, and apply with their contact info, move-in date, planned stay, and an about-me note.
- **Owners** list rooms (rent, deposit, room/bathroom type, furnished, utilities, availability, minimum stay, amenities, housemates, house rules, optional photo), manage their listings (edit, pause/reactivate, mark filled, delete), and work an applications inbox (New → Reviewing → Accepted → Declined).

There is no account system in this v1 — owners identify themselves by entering the same email they used when listing. Anyone with that email can see those listings/applications, so treat this as a starter version, not a production-secure release.

**Stack:** Node.js + Express, no build step. Data is stored in PostgreSQL when `DATABASE_URL` is set, and in a local `data.json` file when it isn't.

---

## 1. Run it locally

Requirements: Node.js 18 or newer.

```bash
npm install
npm start
```

Then open http://localhost:3000 (or the port shown in the terminal).

With no `DATABASE_URL` set, the app uses `data.json` in this folder — perfect for trying it out. Delete `data.json` any time to start over with an empty database.

To run it against a local PostgreSQL instead:

```bash
DATABASE_URL=postgres://user:password@localhost:5432/coliving npm start
```

Tables (`listings`, `applications`) are created automatically on first start.

---

## 2. Deploy to Railway (step by step)

### Step 1 — Put the code on GitHub

1. Create a free account at [github.com](https://github.com) if you don't have one.
2. Create a **new repository** (for example `co-living-room-finder`). Leave it empty — no README, no .gitignore template.
3. Upload this project's files to the repo. Either:
   - **Web upload:** on the empty repo page, click **uploading an existing file**, and drag in all files/folders from this project **except** `node_modules` and `data.json` (the repo includes a `.gitignore` that excludes them anyway). Make sure `server.js`, `package.json`, `README.md`, `.gitignore`, and the `public/` folder all land at the **top level** of the repo, not inside an extra folder.
   - **Or with git:** `git init`, `git add .`, `git commit -m "Co-Living Room Finder"`, then follow GitHub's "push an existing repository" instructions.

### Step 2 — Create the Railway project

1. Sign up / log in at [railway.app](https://railway.app).
2. Click **New Project** → **Deploy from GitHub repo**.
3. Connect your GitHub account if asked, then select the `co-living-room-finder` repository.
4. Railway detects a Node.js app and starts deploying. The start command comes from `package.json` (`npm start` → `node server.js`). If Railway ever asks for a start command, enter:

   ```
   npm start
   ```

   The server listens on the `PORT` environment variable, which Railway sets automatically.

### Step 3 — Add the PostgreSQL database

1. Inside your Railway project, click **New** (or right-click the canvas) → **Database** → **PostgreSQL**. Railway provisions the database in the same project.
2. Click on your **app service** (not the database), go to the **Variables** tab, and confirm there is a `DATABASE_URL` variable pointing at the database:
   - When the database is in the same project, Railway can link it automatically — but if `DATABASE_URL` is missing, add it manually as a **reference variable**: **New Variable** → name it `DATABASE_URL` → as the value, choose **Add Reference** and select the Postgres service's `DATABASE_URL` variable (it will look like `${{ Postgres.DATABASE_URL }}`).
3. Save. Adding/changing variables redeploys the app automatically. On boot, the app sees `DATABASE_URL`, connects to PostgreSQL (with SSL, as Railway requires), and creates its tables automatically. You can confirm this in the app's deploy logs: it should print `Storage: PostgreSQL (DATABASE_URL set)`.

### Step 4 — Get a public web address

1. Click your **app service** → **Settings** → **Networking**.
2. Click **Generate Domain**. Railway gives you a free public address like `co-living-room-finder-production-xxxx.up.railway.app`.
3. Open that address — the app is live. Add a test listing, apply for it, and check the Applications inbox to verify everything saves.

---

## 3. Adding your own domain later

Railway supports custom domains (for example `rooms.yourdomain.com`):

1. Buy a domain from any registrar (e.g. Cloudflare, Namecheap, Google Domains successor Squarespace Domains).
2. In Railway: app service → **Settings** → **Networking** → **Custom Domain**, and enter your domain.
3. Railway shows you a DNS record (a CNAME — or an A record for a root domain) to add at your registrar. Add it exactly as shown; the address starts working once DNS propagates (a few minutes up to a few hours), and Railway issues the HTTPS certificate automatically.

---

## Project layout

```
server.js          Express server + JSON API (PostgreSQL or JSON-file storage)
public/index.html  The whole frontend (single page, inline CSS/JS)
package.json       Start command: npm start  →  node server.js
data.json          Local data file (only used when DATABASE_URL is not set; git-ignored)
```
