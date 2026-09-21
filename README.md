# Peanut Punch Hockey Room

A locally hosted fantasy hockey draft assistant: FantasyPros ADP, Sleeper NHL profiles, need-aware recommendations, and optional Sleeper live-draft sync.

## Quick start

```bash
cd fantasy-hockey-draft
npm start
```

Open [http://localhost:3005](http://localhost:3005).

## What’s in this repo

- `server.js` — Node HTTP server (listens on `process.env.PORT` or 3005, binds `0.0.0.0`)
- `public/index.html` — draft room UI
- `public/app.js` — board, roster, and recommendations
- `public/styles.css` — Peanut Punch / Bears-inspired theme
- `package.json` — `npm start` / `npm run dev`
- `render.yaml` — Render web service blueprint

## API

- `GET /api/health`
- `GET /api/players` — ADP board with Sleeper enrichment
- `GET /api/sleeper/draft?draftId=...` — completed Sleeper picks

## Deploy on Render

1. Connect this GitHub repo in [Render](https://dashboard.render.com).
2. Use **New → Blueprint** (`render.yaml`) or a Node web service:
   - Branch: `main`
   - Build: `npm install`
   - Start: `npm start`
   - Health check: `/api/health`

No API keys are required. Do not commit `.env` files.

## Data sources

- [FantasyPros NHL ADP](https://www.fantasypros.com/nhl/adp/overall.php)
- [Sleeper API](https://docs.sleeper.com/) (NHL players and drafts)
