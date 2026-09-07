# Dara — full-stack version

A real client/server version of the Dara board game with:

- **Auth** — username/password accounts, JWT-based sessions, bcrypt password hashing.
- **Database** — Postgres (via `pg`), storing users, friend relationships, and message history.
- **Friends** — real accounts: send a request by username, accept/decline, remove.
- **Live messaging** — private 1:1 chat between accepted friends over Socket.io (WebSocket), persisted to the database and delivered instantly to both sides while connected.
- **Game** — the same Dara rules (placement, movement, mills/captures, win conditions), a local AI opponent that gets sharper the more games you've played, and a rank ladder — all now tracked server-side per account instead of per-browser.

## Project layout

```
dara-app/
  server/   Node/Express API + Socket.io + Postgres
  client/   Plain HTML/CSS/JS frontend (no build step)
```

The server also serves the client as static files, so in production this is **one process on one port** — no separate frontend host needed.

## Running it locally

Requires Node.js 18+ and a Postgres database (local, or just point `DATABASE_URL` at the same Render Postgres instance used in production — see below).

```bash
cd server
npm install
DATABASE_URL="postgres://user:pass@host:5432/dbname" npm start
```

The server creates its tables automatically on startup (`init()` in `server/db.js`) — no separate migration step needed.

Then open **http://localhost:3001** in your browser. Register an account, and open a second browser (or an incognito window) to register a second account so you can test adding a friend and chatting between the two.

## Configuration

Copy `.env.example` to `.env` (or just export the variables) before deploying:

```bash
export DATABASE_URL="postgres://..."
export JWT_SECRET="$(openssl rand -hex 48)"
export NODE_ENV=production
```

If `JWT_SECRET` isn't set, the server now generates a random one in memory at startup instead of using a fixed default — so no one can forge tokens by reading the source, but every restart invalidates all logged-in sessions. **In production the server refuses to start at all without an explicit `JWT_SECRET`**, and it also refuses to start without `DATABASE_URL` in any environment, since there's nothing useful it can do without a database.

## Security hardening in this version

- **Rate limiting** — 10 requests / 15 min on `/api/auth/*` (register + login), 300 / 15 min on the rest of the API. Both are per-IP via `express-rate-limit`, with `trust proxy` enabled so it reads the real client IP behind a host's reverse proxy.
- **Secrets** — see above. No more hardcoded fallback JWT secret.
- **Password rules** — 8+ characters, at least one letter and one number, hashed with bcrypt at cost factor 12.
- **Username rules** — 3–24 characters, letters/numbers/`_`/`-` only, and uniqueness is case-insensitive (`Bob` and `bob` can't both register) via a unique index on `lower(username)`.
- **Input validation** — centralized in `server/validate.js` and applied to registration, avatar color, and chat messages (2000-character cap) instead of ad hoc checks scattered across routes.
- **Avatar color is a whitelist, not free text** — it's rendered into a `style="background:..."` attribute in the client, so accepting arbitrary strings there would have been a CSS/HTML-injection opening. Only the six swatch colors the UI actually offers are accepted server-side.
- **Chat is now restricted to accepted friends, enforced server-side** — both the message-history endpoint and the live socket handler check for an accepted friend link, not just the UI hiding the option. Previously the API would have allowed messaging any user ID if you called it directly.
- **Per-connection message throttling** — 15 messages / 10 seconds per socket, to blunt spam bursts.
- **HTTP security headers** via `helmet`, including a Content-Security-Policy scoped to this app's actual needs (self + the Socket.io CDN script).
- **CORS is no longer wide open** — defaults to reflecting the request's own origin (correct for the same-process deployment this README describes) and can be locked to specific origins via `CORS_ORIGIN` if you ever split the client onto its own host.
- **Request body size capped** at 100kb to reject oversized payloads outright.
- Login failures return the same generic "Invalid username or password" for both a wrong username and a wrong password, so the endpoint can't be used to enumerate which usernames exist.

## Deploying it (Render)

A Render Postgres instance has already been provisioned for this project:

- Name: `dara-db`, id `dpg-dafdj1tbedkc738qenl0-a`, region Oregon, free plan
- Dashboard: https://dashboard.render.com/d/dpg-dafdj1tbedkc738qenl0-a
- **Free-plan Render Postgres instances expire 30 days after creation** unless upgraded to a paid plan — worth knowing before you treat this as permanent storage for real users.

Render's API doesn't expose the database password back out through automation (for good reason — it's a credential), so the connection string has to come from you:

1. Open the dashboard link above → **Connections** → copy the **Internal Database URL** (use this if the web service and database are both on Render, in the same region — no SSL needed) or the **External Database URL** (if connecting from outside Render — needs `PGSSL=true`).
2. Push this project to a Git repository (GitHub, GitLab, etc.) — Render deploys from a repo URL, not a zip upload.
3. Create the web service (I can do this via the Render MCP connector once I have the repo URL from you), with:
   - Build command: `cd server && npm install`
   - Start command: `cd server && npm start`
   - Environment variables: `DATABASE_URL` (from step 1), `JWT_SECRET` (a random value), `NODE_ENV=production`
4. Once deployed, Render gives the service a public `https://<name>.onrender.com` URL — that's what you share.

Platforms that run multiple server instances behind a load balancer need the [Socket.io Redis adapter](https://socket.io/docs/v4/redis-adapter/) so real-time messages reach a user connected to a different instance than their friend. A single instance (the default here) doesn't need this.

## Known limitations / what a production version would add

This is now meaningfully hardened, but still not a fully production-grade service. If you take this further, consider adding:

- Email verification and password reset (there's currently no email step at all — just username + password).
- Short-lived access tokens with a refresh-token flow, instead of a single 30-day JWT (so a stolen token can't be used indefinitely).
- Pagination for chat history (currently capped at the most recent 200 messages per conversation).
- HTTPS termination in front of the app (most hosts handle this for you automatically).
- The Socket.io Redis adapter and a shared rate-limit store (e.g. Redis) if you ever scale to more than one server instance — the current in-memory rate limiting and message throttling are per-instance.
- An account lockout or CAPTCHA after repeated failed logins, on top of the IP-based rate limit, for defense against distributed brute-force attempts.
