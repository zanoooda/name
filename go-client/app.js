const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const capturesEl = document.getElementById("captures");
const sizeSelect = document.getElementById("board-size");
const colorSelect = document.getElementById("human-color");
const newGameBtn = document.getElementById("new-game");
const passBtn = document.getElementById("pass");
const undo1Btn = document.getElementById("undo-1");
const undo2Btn = document.getElementById("undo-2");
const analyzeBtn = document.getElementById("analyze");
const visitsInput = document.getElementById("visits");
const visitsValue = document.getElementById("visits-value");
const thinkLabel = document.getElementById("think-label");
const thinkProgress = document.getElementById("think-progress");
const analysisList = document.getElementById("analysis-list");
const historyList = document.getElementById("history-list");

let state = null;
let analysisData = null;
let historyData = { moves: [] };

const margin = 24;

function boardPixelSize() {
  return canvas.width - margin * 2;
}

function gap(size) {
  return boardPixelSize() / (size - 1);
}

function coordToPixel(x, y, size) {
  return [margin + x * gap(size), margin + y * gap(size)];
}

function drawBoard() {
  if (!state) return;
  const size = state.size;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "#2f2415";
  ctx.lineWidth = 1.2;
  for (let i = 0; i < size; i += 1) {
    const p = margin + i * gap(size);
    ctx.beginPath();
    ctx.moveTo(margin, p);
    ctx.lineTo(canvas.width - margin, p);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(p, margin);
    ctx.lineTo(p, canvas.height - margin);
    ctx.stroke();
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const v = state.board[y][x];
      if (!v) continue;
      const [px, py] = coordToPixel(x, y, size);
      ctx.beginPath();
      ctx.arc(px, py, Math.max(6, gap(size) * 0.42), 0, Math.PI * 2);
      if (v === 1) {
        ctx.fillStyle = "#101010";
      } else {
        ctx.fillStyle = "#f8f8f8";
      }
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.28)";
      ctx.stroke();
    }
  }

  drawAnalysisOverlay();
}

function drawAnalysisOverlay() {
  if (!analysisData || !analysisData.candidates) return;
  const size = state.size;
  const totalVisits = analysisData.candidates.reduce((acc, item) => acc + (item.visits || 0), 0) || 1;
  const base = Math.max(7, gap(size) * 0.34);
  analysisData.candidates.forEach((item, idx) => {
    if (item.x === null || item.y === null) return;
    const weight = Math.max(0.02, (item.visits || 0) / totalVisits);
    const [px, py] = coordToPixel(item.x, item.y, size);
    const alpha = Math.max(0.22, 0.24 + weight * 1.2);
    const radius = base + weight * gap(size) * 0.9;
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(225, 68, 30, ${alpha})`;
    ctx.fill();
    ctx.strokeStyle = "rgba(110, 22, 0, 0.45)";
    ctx.stroke();

    ctx.fillStyle = "#fffdf5";
    ctx.font = `bold ${Math.max(9, gap(size) * 0.26)}px "IBM Plex Sans"`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${Math.round(weight * 100)}%`, px, py);

    ctx.fillStyle = "#6a1d08";
    ctx.font = `bold ${Math.max(10, gap(size) * 0.24)}px "IBM Plex Sans"`;
    ctx.fillText(String(idx + 1), px, py - radius - 8);
  });
}

function updateInfo() {
  if (!state) return;
  const colorName = state.to_move === "B" ? "black" : "white";
  const you = state.human_color === "B" ? "black" : "white";
  statusEl.textContent = `Turn: ${colorName}. You are ${you}.`;
  capturesEl.textContent = `Captures: B ${state.captures.B} / W ${state.captures.W}`;
}

function updateThinkProgress(percent, text = "") {
  thinkProgress.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  thinkLabel.textContent = text;
}

function renderAnalysis() {
  analysisList.innerHTML = "";
  if (!analysisData || !analysisData.candidates || analysisData.candidates.length === 0) {
    analysisList.innerHTML = "<li>No analysis data</li>";
    return;
  }
  analysisData.candidates.forEach((item, idx) => {
    const wr = item.winrate === null || item.winrate === undefined ? "-" : `${(item.winrate * 100).toFixed(1)}%`;
    const visits = item.visits ?? "-";
    const sum = analysisData.candidates.reduce((acc, x) => acc + (x.visits || 0), 0) || 1;
    const weight = item.visits ? `${((item.visits / sum) * 100).toFixed(1)}%` : "-";
    const score = item.score_lead === null || item.score_lead === undefined ? "-" : item.score_lead.toFixed(1);
    const li = document.createElement("li");
    li.innerHTML = `<strong>#${idx + 1}</strong><span>${item.move}</span><span>weight ${weight} | visits ${visits} | WR ${wr} | lead ${score}</span>`;
    analysisList.appendChild(li);
  });
}

function renderHistory() {
  historyList.innerHTML = "";
  const moves = historyData.moves || [];
  if (moves.length === 0) {
    historyList.innerHTML = "<li><span>-</span><span></span><span>No moves yet</span></li>";
    return;
  }
  moves.forEach((mv) => {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${mv.index}.</strong><span>${mv.color}</span><span>${mv.move}</span>`;
    historyList.appendChild(li);
  });
  historyList.scrollTop = historyList.scrollHeight;
}

async function api(path, method = "GET", body = null) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ detail: "unknown error" }));
    throw new Error(data.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

async function refreshState() {
  state = await api("/game/state");
  historyData = await api("/game/history");
  renderHistory();
  drawBoard();
  updateInfo();
}

async function maybeAIMove() {
  if (state.to_move !== state.ai_color) return;
  updateThinkProgress(10, "KataGo is analyzing the position...");
  try {
    analysisData = await api("/game/analyze", "POST", {
      color: state.ai_color,
      visits: Number(visitsInput.value),
      max_moves: 6,
    });
    drawBoard();
    renderAnalysis();
    updateThinkProgress(72, `Analysis ready in ${analysisData.elapsed_ms} ms`);
  } catch (err) {
    updateThinkProgress(0, `Analysis error: ${err.message}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 380));
  updateThinkProgress(86, "KataGo is making a move...");
  state = await api("/game/ai-move", "POST");
  historyData = await api("/game/history");
  renderHistory();
  drawBoard();
  updateInfo();
  updateThinkProgress(100, "AI move completed");
  setTimeout(() => updateThinkProgress(0, ""), 900);
}

async function startNewGame() {
  const size = Number(sizeSelect.value);
  const humanColor = colorSelect.value;
  analysisData = null;
  renderAnalysis();
  updateThinkProgress(0, "");
  state = await api("/game/new", "POST", { size, human_color: humanColor, komi: 7.5 });
  historyData = await api("/game/history");
  renderHistory();
  drawBoard();
  updateInfo();
  await maybeAIMove();
}

canvas.addEventListener("click", async (evt) => {
  if (!state || state.to_move !== state.human_color) return;
  const rect = canvas.getBoundingClientRect();
  const px = evt.clientX - rect.left;
  const py = evt.clientY - rect.top;
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = Math.round((px * scaleX - margin) / gap(state.size));
  const y = Math.round((py * scaleY - margin) / gap(state.size));

  if (x < 0 || y < 0 || x >= state.size || y >= state.size) return;

  try {
    state = await api("/game/play", "POST", { x, y });
    historyData = await api("/game/history");
    renderHistory();
    analysisData = null;
    renderAnalysis();
    drawBoard();
    updateInfo();
    await maybeAIMove();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

newGameBtn.addEventListener("click", async () => {
  try {
    await startNewGame();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

passBtn.addEventListener("click", async () => {
  if (!state || state.to_move !== state.human_color) return;
  try {
    state = await api("/game/pass", "POST");
    historyData = await api("/game/history");
    renderHistory();
    analysisData = null;
    renderAnalysis();
    drawBoard();
    updateInfo();
    await maybeAIMove();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

async function undoSteps(steps) {
  state = await api("/game/undo", "POST", { steps });
  historyData = await api("/game/history");
  analysisData = null;
  renderAnalysis();
  renderHistory();
  drawBoard();
  updateInfo();
}

undo1Btn.addEventListener("click", async () => {
  if (!state) return;
  try {
    await undoSteps(1);
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

undo2Btn.addEventListener("click", async () => {
  if (!state) return;
  try {
    await undoSteps(2);
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

analyzeBtn.addEventListener("click", async () => {
  if (!state) return;
  try {
    updateThinkProgress(12, "Requesting analysis...");
    analysisData = await api("/game/analyze", "POST", {
      color: state.to_move,
      visits: Number(visitsInput.value),
      max_moves: 6,
    });
    drawBoard();
    renderAnalysis();
    updateThinkProgress(100, `Done in ${analysisData.elapsed_ms} ms`);
    setTimeout(() => updateThinkProgress(0, ""), 800);
  } catch (err) {
    updateThinkProgress(0, `Analysis error: ${err.message}`);
  }
});

visitsInput.addEventListener("input", () => {
  visitsValue.textContent = visitsInput.value;
});

visitsValue.textContent = visitsInput.value;
renderAnalysis();
renderHistory();

startNewGame().catch((err) => {
  statusEl.textContent = `Failed to connect to API: ${err.message}`;
});
