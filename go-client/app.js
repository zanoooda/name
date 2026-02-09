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
let selectedCandidateIndex = -1;
let analysisSocket = null;

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

function gtpToCoord(vertex, size) {
  if (!vertex) return null;
  const token = String(vertex).trim().toUpperCase();
  if (token === "PASS" || token === "RESIGN") return null;
  if (token.length < 2) return null;
  const col = token.charCodeAt(0);
  let x = col - 65;
  if (token[0] > "I") x -= 1;
  const row = Number(token.slice(1));
  if (!Number.isFinite(row)) return null;
  const y = size - row;
  if (x < 0 || y < 0 || x >= size || y >= size) return null;
  return { x, y };
}

function analysisTotalVisits() {
  if (!analysisData?.candidates?.length) return 1;
  return analysisData.candidates.reduce((acc, item) => acc + (item.visits || 0), 0) || 1;
}

function candidateWeight(item) {
  return (item?.visits || 0) / analysisTotalVisits();
}

function selectedCandidate() {
  if (!analysisData?.candidates?.length) return null;
  if (selectedCandidateIndex < 0 || selectedCandidateIndex >= analysisData.candidates.length) return null;
  return analysisData.candidates[selectedCandidateIndex];
}

function wsURL(pathWithQuery) {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}${pathWithQuery}`;
}

function closeAnalysisSocket() {
  if (!analysisSocket) return;
  try {
    analysisSocket.close();
  } catch (e) {
    // ignore close races
  }
  analysisSocket = null;
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
  drawPVOverlay();
}

function drawAnalysisOverlay() {
  if (!analysisData || !analysisData.candidates) return;
  const size = state.size;
  const totalVisits = analysisTotalVisits();
  const base = Math.max(7, gap(size) * 0.28);
  analysisData.candidates.forEach((item, idx) => {
    if (item.x === null || item.y === null) return;
    const weight = Math.max(0.02, (item.visits || 0) / totalVisits);
    const [px, py] = coordToPixel(item.x, item.y, size);
    const isActive = idx === selectedCandidateIndex;
    const alpha = Math.max(0.22, 0.2 + weight * 1.3);
    const radius = base + weight * gap(size) * (isActive ? 1.35 : 1.0);
    const hue = Math.max(20, Math.min(125, Math.round(20 + weight * 105)));
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${hue}, 78%, 48%, ${alpha})`;
    ctx.fill();
    ctx.strokeStyle = isActive ? "rgba(12, 14, 12, 0.75)" : "rgba(40, 28, 10, 0.35)";
    ctx.lineWidth = isActive ? 2.2 : 1.2;
    ctx.stroke();

    ctx.fillStyle = "#fffdf5";
    ctx.font = `bold ${Math.max(9, gap(size) * 0.26)}px "IBM Plex Sans"`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${Math.round(weight * 100)}%`, px, py);

    ctx.fillStyle = "#6a1d08";
    ctx.font = `bold ${Math.max(10, gap(size) * 0.22)}px "IBM Plex Sans"`;
    ctx.fillText(String(idx + 1), px, py - radius - 8);
  });
  ctx.lineWidth = 1.2;
}

function drawPVOverlay() {
  const candidate = selectedCandidate();
  if (!candidate || !Array.isArray(candidate.pv) || candidate.pv.length === 0 || !state) return;

  const size = state.size;
  const maxPv = Math.min(10, candidate.pv.length);
  let color = analysisData?.to_move === "W" ? "W" : "B";
  const stoneR = Math.max(7, gap(size) * 0.33);

  for (let i = 0; i < maxPv; i += 1) {
    const c = gtpToCoord(candidate.pv[i], size);
    if (!c) {
      color = color === "B" ? "W" : "B";
      continue;
    }
    const [px, py] = coordToPixel(c.x, c.y, size);
    const scale = 1 - i * 0.04;
    const r = stoneR * Math.max(0.62, scale);

    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = color === "B" ? "rgba(20,20,20,0.74)" : "rgba(255,255,255,0.8)";
    ctx.fill();
    ctx.strokeStyle = "rgba(30,30,30,0.55)";
    ctx.lineWidth = 1.1;
    ctx.stroke();

    ctx.fillStyle = color === "B" ? "#f4f2ea" : "#171717";
    ctx.font = `bold ${Math.max(9, gap(size) * 0.22)}px "IBM Plex Sans"`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), px, py);
    color = color === "B" ? "W" : "B";
  }
  ctx.lineWidth = 1.2;
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
  const sum = analysisTotalVisits();
  analysisData.candidates.forEach((item, idx) => {
    const wr = item.winrate === null || item.winrate === undefined ? "-" : `${(item.winrate * 100).toFixed(1)}%`;
    const visits = item.visits ?? "-";
    const weight = item.visits ? `${((item.visits / sum) * 100).toFixed(1)}%` : "-";
    const score = item.score_lead === null || item.score_lead === undefined ? "-" : item.score_lead.toFixed(1);
    const pvShort = Array.isArray(item.pv) && item.pv.length ? item.pv.slice(0, 6).join(" ") : "-";
    const li = document.createElement("li");
    li.className = "analysis-item";
    if (idx === selectedCandidateIndex) li.classList.add("analysis-item-active");
    li.innerHTML = `<strong>#${idx + 1}</strong><span>${item.move}</span><span>w ${weight} | v ${visits} | WR ${wr} | lead ${score}<br/>PV: ${pvShort}</span>`;
    li.addEventListener("mouseenter", () => {
      selectedCandidateIndex = idx;
      renderAnalysis();
      drawBoard();
    });
    li.addEventListener("click", () => {
      selectedCandidateIndex = idx;
      renderAnalysis();
      drawBoard();
    });
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

async function runLiveAnalysis(color) {
  if (!state) return null;
  closeAnalysisSocket();
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      color,
      visits: String(Number(visitsInput.value)),
      max_moves: "6",
    });
    const ws = new WebSocket(wsURL(`/ws/analyze?${params.toString()}`));
    analysisSocket = ws;
    let finished = false;
    let last = null;

    ws.onopen = () => {
      updateThinkProgress(5, "KataGo is analyzing...");
    };

    ws.onmessage = (event) => {
      let msg = null;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (msg.type === "error") {
        finished = true;
        closeAnalysisSocket();
        reject(new Error(msg.detail || "analysis stream failed"));
        return;
      }
      if (msg.type === "update" || msg.type === "done") {
        const next = msg.analysis || null;
        if (!next) return;
        last = next;
        const prevSelectedMove = selectedCandidate()?.move || null;
        analysisData = next;
        if (prevSelectedMove) {
          const idx = (analysisData.candidates || []).findIndex((c) => c.move === prevSelectedMove);
          selectedCandidateIndex = idx >= 0 ? idx : 0;
        } else {
          selectedCandidateIndex = analysisData.candidates?.length ? 0 : -1;
        }
        renderAnalysis();
        drawBoard();
        const cur = Number(next.visits_requested || 0);
        const target = Number(next.visits_target || cur || 1);
        const pct = Math.max(5, Math.min(100, Math.round((cur / target) * 100)));
        updateThinkProgress(pct, `KataGo analysis: ${cur}/${target} visits`);
      }
      if (msg.type === "done") {
        finished = true;
        closeAnalysisSocket();
        resolve(last);
      }
    };

    ws.onerror = () => {
      if (finished) return;
      finished = true;
      closeAnalysisSocket();
      reject(new Error("analysis websocket error"));
    };

    ws.onclose = () => {
      if (finished) return;
      finished = true;
      closeAnalysisSocket();
      reject(new Error("analysis websocket closed"));
    };
  });
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
    await runLiveAnalysis(state.ai_color);
    updateThinkProgress(78, "Analysis complete");
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
  closeAnalysisSocket();
  analysisData = null;
  selectedCandidateIndex = -1;
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
    closeAnalysisSocket();
    historyData = await api("/game/history");
    renderHistory();
    analysisData = null;
    selectedCandidateIndex = -1;
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
    closeAnalysisSocket();
    historyData = await api("/game/history");
    renderHistory();
    analysisData = null;
    selectedCandidateIndex = -1;
    renderAnalysis();
    drawBoard();
    updateInfo();
    await maybeAIMove();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
});

async function undoSteps(steps) {
  closeAnalysisSocket();
  state = await api("/game/undo", "POST", { steps });
  historyData = await api("/game/history");
  analysisData = null;
  selectedCandidateIndex = -1;
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
    await runLiveAnalysis(state.to_move);
    updateThinkProgress(100, "Live analysis complete");
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
