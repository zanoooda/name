# Next.js + Python backend в Docker Compose

Минимальный проект:
- `frontend` — Next.js (React) с одной страницей и кнопкой.
- `backend` — FastAPI с эндпоинтом `GET /ping`.
- `docker-compose.yml` запускает всё вместе.

Кнопка на странице вызывает `/api/ping` у Next.js, а Next.js проксирует запрос в Python backend.

## Требования

- Docker
- Docker Compose (плагин `docker compose`)

## Структура

- `frontend/` — Next.js приложение
- `backend/` — FastAPI приложение
- `docker-compose.yml` — запуск сервисов
- `.vscode/launch.json` — attach-конфиги для дебага

## Локальный запуск (dev)

```bash
docker compose up --build
```

После запуска:
- фронтенд: http://localhost:3000
- backend: http://localhost:8000/ping

Проверка сценария:
1. Откройте http://localhost:3000
2. Нажмите кнопку `Проверить backend`
3. Должен появиться текст: `Ответ от Python backend`

Остановка:

```bash
docker compose down
```

## Деплой

Для простого деплоя на сервере (как есть):

```bash
docker compose up -d --build
```

Проверка статуса:

```bash
docker compose ps
docker compose logs -f
```

Обновление:

```bash
git pull
docker compose up -d --build
```

## Debugger

### 1) Запуск в debug-режиме

Проект использует переменную `DEBUG=1`:

```bash
DEBUG=1 docker compose up --build
```

Откроются debug-порты:
- `9229` — Node Inspector (frontend)
- `5678` — debugpy (backend)

### 2) Подключение из VS Code

В репозитории уже есть `.vscode/launch.json` с двумя конфигами:
- `Attach Frontend (Next.js in Docker)`
- `Attach Backend (FastAPI in Docker)`

Шаги:
1. Поставьте breakpoints в `frontend/` и/или `backend/`.
2. Запустите контейнеры с `DEBUG=1`.
3. В VS Code откройте Run and Debug и подключитесь через нужный `Attach` конфиг.

### 3) Что дебажить

- Frontend:
  - `frontend/app/page.js`
  - `frontend/app/api/ping/route.js`
- Backend:
  - `backend/app/main.py`

## Полезные команды

Пересобрать только один сервис:

```bash
docker compose up --build frontend
```

Логи backend:

```bash
docker compose logs -f backend
```

Логи frontend:

```bash
docker compose logs -f frontend
```
