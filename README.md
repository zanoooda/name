# Local Go Client + KataGo Server via Docker Compose

This project runs two services:
- `katago-server`: FastAPI API + locally running KataGo (GTP).
- `go-client`: web board client that proxies API requests via `/api`.

## Run

```bash
docker compose up --build
```

After startup:
- client: http://localhost
- API: http://localhost:8080

## How it works

- On first startup, `katago-server` downloads the KataGo binary and model into the `katago-data` volume.
- You can pin a model URL via `KATAGO_MODEL_URL` in `docker-compose.yml`.
- The web client supports:
  - starting a new game (9/13/19),
  - choosing your color,
  - placing stones by click,
  - passing,
  - viewing KataGo analysis (top candidates on board, visits/winrate/lead),
  - seeing candidate weight directly on the board as visit share,
  - selecting a candidate to preview its PV line on the board,
  - viewing move history,
  - undoing the last move or last pair of moves.

## Performance note

- If `/api/game/analyze` is slow on CPU, lower `Analysis depth (visits)` in the UI.
- Nginx proxy timeout for `/api/*` is increased to 300s to avoid premature `504` on long analysis.

## Notes

- If model auto-discovery fails, set a direct URL:
  - `docker-compose.yml` -> `services.katago-server.environment.KATAGO_MODEL_URL`.
- KataGo data (binary, config, model) is persisted in the `katago-data` volume.
