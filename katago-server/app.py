import asyncio
import hashlib
import os
import shlex
import subprocess
import time
from dataclasses import dataclass, field
from typing import Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field


def other_color(color: str) -> str:
    return "W" if color == "B" else "B"


def stone_value(color: str) -> int:
    return 1 if color == "B" else 2


def board_hash(board: list[list[int]]) -> str:
    raw = "".join("".join(str(cell) for cell in row) for row in board)
    return hashlib.sha1(raw.encode("ascii")).hexdigest()


def gtp_col_label(x: int) -> str:
    if x < 8:
        return chr(ord("A") + x)
    return chr(ord("A") + x + 1)


def to_gtp_vertex(x: int, y: int, size: int) -> str:
    return f"{gtp_col_label(x)}{size - y}"


def from_gtp_vertex(vertex: str, size: int) -> Optional[tuple[int, int]]:
    token = vertex.strip().upper()
    if token in {"PASS", "RESIGN"}:
        return None
    if len(token) < 2:
        raise ValueError(f"invalid vertex: {vertex}")
    col = token[0]
    row = int(token[1:])
    x = ord(col) - ord("A")
    if col > "I":
        x -= 1
    y = size - row
    return x, y


def neighbors(x: int, y: int, size: int) -> list[tuple[int, int]]:
    out = []
    if x > 0:
        out.append((x - 1, y))
    if x < size - 1:
        out.append((x + 1, y))
    if y > 0:
        out.append((x, y - 1))
    if y < size - 1:
        out.append((x, y + 1))
    return out


def collect_group(board: list[list[int]], x: int, y: int) -> tuple[set[tuple[int, int]], bool]:
    size = len(board)
    target = board[y][x]
    seen: set[tuple[int, int]] = set()
    stack = [(x, y)]
    has_liberty = False

    while stack:
        cx, cy = stack.pop()
        if (cx, cy) in seen:
            continue
        seen.add((cx, cy))
        for nx, ny in neighbors(cx, cy, size):
            stone = board[ny][nx]
            if stone == 0:
                has_liberty = True
            elif stone == target and (nx, ny) not in seen:
                stack.append((nx, ny))
    return seen, has_liberty


def apply_local_move(
    board: list[list[int]],
    color: str,
    x: int,
    y: int,
    history: list[str],
) -> tuple[list[list[int]], int]:
    size = len(board)
    if x < 0 or y < 0 or x >= size or y >= size:
        raise ValueError("move is out of board")
    if board[y][x] != 0:
        raise ValueError("intersection is occupied")

    mine = stone_value(color)
    opp = stone_value(other_color(color))
    next_board = [row[:] for row in board]
    next_board[y][x] = mine
    captured = 0

    for nx, ny in neighbors(x, y, size):
        if next_board[ny][nx] != opp:
            continue
        grp, has_lib = collect_group(next_board, nx, ny)
        if has_lib:
            continue
        captured += len(grp)
        for gx, gy in grp:
            next_board[gy][gx] = 0

    own_group, own_has_lib = collect_group(next_board, x, y)
    if not own_has_lib:
        raise ValueError("suicide move is not allowed")

    next_hash = board_hash(next_board)
    if len(history) >= 2 and next_hash == history[-2]:
        raise ValueError("ko rule violation")

    return next_board, captured


class GTPProcess:
    def __init__(self, command: str) -> None:
        self.command = command
        self.proc: Optional[subprocess.Popen] = None

    def start(self) -> None:
        if self.proc is not None:
            return
        self.proc = subprocess.Popen(
            shlex.split(self.command),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

    def stop(self) -> None:
        if self.proc is None:
            return
        self.proc.terminate()
        self.proc = None

    def send_raw(self, command: str) -> tuple[str, list[str]]:
        if self.proc is None or self.proc.stdin is None or self.proc.stdout is None:
            raise RuntimeError("KataGo process is not running")

        self.proc.stdin.write(f"{command}\n")
        self.proc.stdin.flush()

        first = self.proc.stdout.readline()
        if first == "":
            stderr_text = ""
            if self.proc.stderr is not None:
                try:
                    stderr_text = self.proc.stderr.read().strip()
                except Exception:
                    stderr_text = ""
            self.stop()
            if stderr_text:
                raise RuntimeError(f"KataGo closed stdout unexpectedly: {stderr_text}")
            raise RuntimeError("KataGo closed stdout unexpectedly")

        payload: list[str] = []
        while True:
            line = self.proc.stdout.readline()
            if line == "":
                break
            if line.strip() == "":
                break
            payload.append(line.rstrip("\n"))

        if first.startswith("?"):
            first_err = first[1:].strip()
            if payload:
                raise RuntimeError(payload[0])
            raise RuntimeError(first_err if first_err else "GTP command failed")

        if first.startswith("="):
            inline = first[1:].strip()
            return inline, payload

        raise RuntimeError(f"unexpected GTP response: {first.strip()}")

    def send(self, command: str) -> str:
        inline, payload = self.send_raw(command)
        if inline:
            return inline
        return payload[0].strip() if payload else ""


@dataclass
class GameState:
    size: int = 19
    board: list[list[int]] = field(default_factory=lambda: [[0] * 19 for _ in range(19)])
    to_move: str = "B"
    human_color: str = "B"
    ai_color: str = "W"
    captures_black: int = 0
    captures_white: int = 0
    consecutive_passes: int = 0
    last_move: Optional[str] = None
    history: list[str] = field(default_factory=list)
    moves: list[tuple[str, str]] = field(default_factory=list)

    def reset(self, size: int, human_color: str) -> None:
        self.size = size
        self.board = [[0] * size for _ in range(size)]
        self.to_move = "B"
        self.human_color = human_color
        self.ai_color = other_color(human_color)
        self.captures_black = 0
        self.captures_white = 0
        self.consecutive_passes = 0
        self.last_move = None
        self.history = [board_hash(self.board)]
        self.moves = []

    def snapshot(self) -> dict:
        return {
            "size": self.size,
            "board": self.board,
            "to_move": self.to_move,
            "human_color": self.human_color,
            "ai_color": self.ai_color,
            "captures": {"B": self.captures_black, "W": self.captures_white},
            "consecutive_passes": self.consecutive_passes,
            "last_move": self.last_move,
        }


class NewGameRequest(BaseModel):
    size: int = Field(default=19, ge=9, le=19)
    human_color: str = Field(default="B", pattern="^[BW]$")
    komi: float = 7.5


class PlayMoveRequest(BaseModel):
    x: int = Field(ge=0, le=18)
    y: int = Field(ge=0, le=18)


class AnalyzeRequest(BaseModel):
    visits: int = Field(default=80, ge=20, le=3000)
    max_moves: int = Field(default=6, ge=1, le=12)
    color: Optional[str] = Field(default=None, pattern="^[BW]$")


class UndoRequest(BaseModel):
    steps: int = Field(default=1, ge=1, le=50)


app = FastAPI(title="KataGo Local Server")

gtp_cmd = os.getenv(
    "KATAGO_GTP_CMD",
    "env APPIMAGE_EXTRACT_AND_RUN=1 /opt/katago/bin/katago gtp -config /opt/katago/config/gtp.cfg -model /opt/katago/models/model.bin.gz",
)
gtp = GTPProcess(gtp_cmd)
state = GameState()
lock = asyncio.Lock()
komi_value = 7.5
engine_error: Optional[str] = None


async def initialize_game(size: int, komi: float) -> None:
    gtp.send("clear_board")
    gtp.send(f"boardsize {size}")
    gtp.send(f"komi {komi}")


def init_engine_sync(size: int, komi: float) -> None:
    global engine_error
    try:
        gtp.stop()
        gtp.start()
        gtp.send("name")
        gtp.send("version")
        gtp.send("clear_board")
        gtp.send(f"boardsize {size}")
        gtp.send(f"komi {komi}")
        engine_error = None
    except Exception as err:
        engine_error = str(err)
        raise


async def ensure_engine_ready(size: int, komi: float) -> None:
    global engine_error
    if engine_error is None:
        return
    last_err = None
    for _ in range(3):
        try:
            init_engine_sync(size, komi)
            return
        except Exception as err:
            last_err = err
            await asyncio.sleep(0.8)
    raise HTTPException(status_code=503, detail=f"KataGo is not ready: {last_err}")


@app.on_event("startup")
async def startup_event() -> None:
    global komi_value
    komi_value = 7.5
    state.reset(19, "B")
    try:
        init_engine_sync(19, komi_value)
    except Exception:
        # Keep API process alive; engine will be retried lazily on requests.
        pass


@app.on_event("shutdown")
async def shutdown_event() -> None:
    gtp.stop()


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "engine_ready": engine_error is None, "engine_error": engine_error}


@app.get("/game/state")
async def game_state() -> dict:
    return state.snapshot()


@app.get("/game/history")
async def game_history() -> dict:
    moves_out = []
    for idx, (mv_color, vertex) in enumerate(state.moves, start=1):
        moves_out.append({"index": idx, "color": mv_color, "move": vertex})
    return {"moves": moves_out, "count": len(moves_out)}


@app.post("/game/new")
async def new_game(req: NewGameRequest) -> dict:
    global komi_value
    async with lock:
        await ensure_engine_ready(req.size, req.komi)
        komi_value = req.komi
        state.reset(req.size, req.human_color)
        await initialize_game(req.size, komi_value)
        return state.snapshot()


def apply_move(color: str, x: int, y: int) -> None:
    next_board, captured = apply_local_move(state.board, color, x, y, state.history)
    state.board = next_board
    state.history.append(board_hash(next_board))
    state.to_move = other_color(color)
    state.consecutive_passes = 0
    state.last_move = f"{color}:{x},{y}"
    state.moves.append((color, to_gtp_vertex(x, y, state.size)))
    if color == "B":
        state.captures_black += captured
    else:
        state.captures_white += captured


def parse_analysis_lines(
    lines: list[str],
    size: int,
    max_moves: int,
) -> tuple[Optional[str], list[dict]]:
    best_move: Optional[str] = None
    candidates: list[dict] = []

    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "play" and len(parts) >= 2:
            best_move = parts[1].upper()
            continue
        if parts[0] != "info":
            continue

        item: dict = {"move": None, "x": None, "y": None, "visits": None, "winrate": None, "score_lead": None, "pv": []}
        idx = 0
        while idx < len(parts):
            key = parts[idx]
            if key == "move" and idx + 1 < len(parts):
                mv = parts[idx + 1].upper()
                item["move"] = mv
                coords = from_gtp_vertex(mv, size)
                if coords is not None:
                    item["x"], item["y"] = coords
                idx += 2
                continue
            if key == "visits" and idx + 1 < len(parts):
                try:
                    item["visits"] = int(parts[idx + 1])
                except ValueError:
                    pass
                idx += 2
                continue
            if key == "winrate" and idx + 1 < len(parts):
                try:
                    wr = float(parts[idx + 1])
                    if wr > 1.0:
                        wr = wr / 100.0
                    item["winrate"] = wr
                except ValueError:
                    pass
                idx += 2
                continue
            if key == "scoreLead" and idx + 1 < len(parts):
                try:
                    item["score_lead"] = float(parts[idx + 1])
                except ValueError:
                    pass
                idx += 2
                continue
            if key == "pv":
                item["pv"] = [p.upper() for p in parts[idx + 1 : idx + 13]]
                break
            idx += 1

        if item["move"] is not None:
            candidates.append(item)

    candidates.sort(key=lambda it: (it["visits"] or 0), reverse=True)
    return best_move, candidates[:max_moves]


def replay_moves(move_list: list[tuple[str, str]], size: int, human_color: str) -> None:
    state.reset(size, human_color)
    for mv_color, vertex in move_list:
        token = vertex.upper()
        if token in {"PASS", "RESIGN"}:
            state.to_move = other_color(mv_color)
            state.last_move = f"{mv_color}:{token}"
            state.consecutive_passes += 1
            state.history.append(board_hash(state.board))
            state.moves.append((mv_color, token))
            continue

        coords = from_gtp_vertex(token, size)
        if coords is None:
            raise ValueError(f"cannot replay move {mv_color} {token}")
        x, y = coords
        next_board, captured = apply_local_move(state.board, mv_color, x, y, state.history)
        state.board = next_board
        state.history.append(board_hash(next_board))
        state.to_move = other_color(mv_color)
        state.consecutive_passes = 0
        state.last_move = f"{mv_color}:{x},{y}"
        state.moves.append((mv_color, token))
        if mv_color == "B":
            state.captures_black += captured
        else:
            state.captures_white += captured


def sync_engine_from_state(size: int, komi: float, move_list: list[tuple[str, str]]) -> None:
    gtp.send("clear_board")
    gtp.send(f"boardsize {size}")
    gtp.send(f"komi {komi}")
    for mv_color, vertex in move_list:
        gtp.send(f"play {mv_color} {vertex}")


def run_analysis_snapshot(size: int, komi: float, color: str, visits: int, max_moves: int, moves: list[tuple[str, str]]) -> dict:
    probe = GTPProcess(gtp_cmd)
    started = time.perf_counter()
    try:
        probe.start()
        probe.send("clear_board")
        probe.send(f"boardsize {size}")
        probe.send(f"komi {komi}")
        for mv_color, vertex in moves:
            probe.send(f"play {mv_color} {vertex}")
        analysis_commands = [
            f"kata-genmove_analyze {color} visits {visits}",
            f"lz-genmove_analyze {color} {visits}",
        ]
        lines: list[str] = []
        last_err: Optional[Exception] = None
        for cmd in analysis_commands:
            try:
                inline, payload = probe.send_raw(cmd)
                lines = ([inline] if inline else []) + payload
                break
            except RuntimeError as err:
                last_err = err
        if not lines:
            if last_err is not None:
                raise RuntimeError(str(last_err))
            raise RuntimeError("analysis command not available")
        best_move, candidates = parse_analysis_lines(lines, size, max_moves)
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return {
            "to_move": color,
            "visits_requested": visits,
            "elapsed_ms": elapsed_ms,
            "best_move": best_move,
            "candidates": candidates,
        }
    finally:
        probe.stop()


@app.post("/game/play")
async def play_human(req: PlayMoveRequest) -> dict:
    async with lock:
        await ensure_engine_ready(state.size, komi_value)
        if state.to_move != state.human_color:
            raise HTTPException(status_code=409, detail="it is not human turn")

        if req.x >= state.size or req.y >= state.size:
            raise HTTPException(status_code=400, detail="move is out of current board size")

        try:
            vertex = to_gtp_vertex(req.x, req.y, state.size)
            gtp.send(f"play {state.human_color} {vertex}")
            apply_move(state.human_color, req.x, req.y)
        except ValueError as err:
            raise HTTPException(status_code=400, detail=str(err)) from err
        except RuntimeError as err:
            raise HTTPException(status_code=500, detail=str(err)) from err

        return state.snapshot()


@app.post("/game/pass")
async def pass_human() -> dict:
    async with lock:
        await ensure_engine_ready(state.size, komi_value)
        if state.to_move != state.human_color:
            raise HTTPException(status_code=409, detail="it is not human turn")
        try:
            gtp.send(f"play {state.human_color} pass")
        except RuntimeError as err:
            raise HTTPException(status_code=500, detail=str(err)) from err
        state.to_move = state.ai_color
        state.last_move = f"{state.human_color}:PASS"
        state.consecutive_passes += 1
        state.history.append(board_hash(state.board))
        state.moves.append((state.human_color, "PASS"))
        return state.snapshot()


@app.post("/game/ai-move")
async def ai_move() -> dict:
    async with lock:
        await ensure_engine_ready(state.size, komi_value)
        if state.to_move != state.ai_color:
            raise HTTPException(status_code=409, detail="it is not AI turn")
        try:
            resp = gtp.send(f"genmove {state.ai_color}").strip().upper()
        except RuntimeError as err:
            raise HTTPException(status_code=500, detail=str(err)) from err

        if resp in {"PASS", "RESIGN"}:
            state.to_move = state.human_color
            state.last_move = f"{state.ai_color}:{resp}"
            state.consecutive_passes += 1
            state.history.append(board_hash(state.board))
            state.moves.append((state.ai_color, resp))
            return state.snapshot()

        letter = resp[0]
        row = int(resp[1:])
        x = ord(letter) - ord("A")
        if letter > "I":
            x -= 1
        y = state.size - row

        try:
            apply_move(state.ai_color, x, y)
        except ValueError as err:
            raise HTTPException(status_code=500, detail=f"AI made illegal move: {err}") from err

        return state.snapshot()


@app.post("/game/analyze")
async def analyze(req: AnalyzeRequest) -> dict:
    async with lock:
        await ensure_engine_ready(state.size, komi_value)
        color = req.color or state.to_move
        try:
            return await asyncio.to_thread(
                run_analysis_snapshot,
                state.size,
                komi_value,
                color,
                req.visits,
                req.max_moves,
                list(state.moves),
            )
        except RuntimeError as err:
            raise HTTPException(status_code=500, detail=f"analysis failed: {err}") from err


def build_analysis_steps(target_visits: int) -> list[int]:
    if target_visits <= 20:
        return [target_visits]
    step = max(20, target_visits // 6)
    values = []
    cur = min(20, target_visits)
    while cur < target_visits:
        values.append(cur)
        cur += step
    values.append(target_visits)
    # Remove duplicates while preserving order.
    out: list[int] = []
    seen: set[int] = set()
    for v in values:
        if v in seen:
            continue
        out.append(v)
        seen.add(v)
    return out


@app.websocket("/ws/analyze")
async def analyze_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        qp = websocket.query_params
        visits = int(qp.get("visits", "80"))
        max_moves = int(qp.get("max_moves", "6"))
        color_q = qp.get("color")
        visits = max(20, min(3000, visits))
        max_moves = max(1, min(12, max_moves))
        if color_q is not None:
            color_q = color_q.upper()
            if color_q not in {"B", "W"}:
                await websocket.send_json({"type": "error", "detail": "invalid color"})
                await websocket.close()
                return

        async with lock:
            await ensure_engine_ready(state.size, komi_value)
            size = state.size
            komi = komi_value
            color = color_q or state.to_move
            moves = list(state.moves)

        steps = build_analysis_steps(visits)
        last: Optional[dict] = None
        for v in steps:
            snapshot = await asyncio.to_thread(
                run_analysis_snapshot,
                size,
                komi,
                color,
                v,
                max_moves,
                moves,
            )
            snapshot["visits_target"] = visits
            await websocket.send_json({"type": "update", "analysis": snapshot})
            last = snapshot

        await websocket.send_json({"type": "done", "analysis": last})
        await websocket.close()
    except WebSocketDisconnect:
        return
    except Exception as err:
        try:
            await websocket.send_json({"type": "error", "detail": str(err)})
        except Exception:
            pass
        try:
            await websocket.close()
        except Exception:
            pass


@app.post("/game/undo")
async def undo(req: UndoRequest) -> dict:
    async with lock:
        await ensure_engine_ready(state.size, komi_value)
        if not state.moves:
            return state.snapshot()
        keep = max(0, len(state.moves) - req.steps)
        trimmed_moves = list(state.moves[:keep])
        try:
            replay_moves(trimmed_moves, state.size, state.human_color)
            sync_engine_from_state(state.size, komi_value, trimmed_moves)
        except (ValueError, RuntimeError) as err:
            raise HTTPException(status_code=500, detail=f"undo failed: {err}") from err
        return state.snapshot()
