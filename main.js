// main.js
import { MultiplayerApi } from "./multiplayer.js";

// multiplayer copy paste
//const api = new MultiplayerApi('ws://kontoret.onvo.se/multiplayer');

const api = new MultiplayerApi(
  `ws${location.protocol === "https:" ? "s" : ""}://${
    location.host
  }/multiplayer`
);

const hostButton = document.getElementById("hostButton");
const joinButton = document.getElementById("joinButton");
const joinSessionInput = document.getElementById("joinSessionInput");
const joinNameInput = document.getElementById("joinNameInput");
const sendButton = document.getElementById("sendButton");
const status = document.getElementById("status");

function initiate() {
  hostButton.addEventListener("click", () => {
    api
      .host()
      .then((result) => {
        status.textContent = `Hosted session with ID: ${result.session} with clientId: ${result.clientId}`;
      })
      .catch((error) => {
        console.error("Error hosting session:", error);
      });
  });

  joinButton.addEventListener("click", () => {
    api
      .join(joinSessionInput.value, { name: joinNameInput.value })
      .then((result) => {
        status.textContent = `Joined session: ${result.session} with clientId: ${result.clientId}`;
      })
      .catch((error) => {
        console.error("Error joining session:", error);
      });
  });

  sendButton.addEventListener("click", () => {
    api.game({ msg: "Hello from client!" });
  });

  const unsubscribe = api.listen((event, messageId, clientId, data) => {
    status.textContent = `Received event "${event}" with messageId: "${messageId}" from clientId: "${clientId}" and data: ${JSON.stringify(
      data
    )}`;
  });
}

window.addEventListener("load", () => {
  initiate();
});

/** =========================
 * Utilities
 * ========================= */
const DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

function isOpposite(a, b) {
  return a && b && a.x === -b.x && a.y === -b.y;
}

function posKey(p) {
  return `${p.x},${p.y}`;
}

function clampInt(n, min, max) {
  n = Math.trunc(n);
  return Math.max(min, Math.min(max, n));
}

/** Deterministic PRNG for host (so spawns are reproducible if needed) */
class Mulberry32 {
  constructor(seed) {
    this.seed = seed >>> 0;
  }
  next() {
    let t = (this.seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

/** =========================
 * Scoreboard (localStorage)
 * ========================= */
class ScoreboardStore {
  static KEY = "snake_scoreboard_v1";

  load() {
    try {
      const raw = localStorage.getItem(ScoreboardStore.KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  saveAll(entries) {
    localStorage.setItem(ScoreboardStore.KEY, JSON.stringify(entries));
  }

  add(entry) {
    const entries = this.load();
    entries.push(entry);
    // sort: score desc, then date desc
    entries.sort(
      (a, b) =>
        b.score - a.score || String(b.date).localeCompare(String(a.date))
    );
    this.saveAll(entries);
    return entries;
  }

  clear() {
    localStorage.removeItem(ScoreboardStore.KEY);
  }
}

/** =========================
 * Board
 * ========================= */
class Board {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
  }

  isInside(p) {
    return p.x >= 0 && p.x < this.cols && p.y >= 0 && p.y < this.rows;
  }

  randomEmptyCell(occupiedSet, rng) {
    // deterministic scan fallback
    // try random attempts first
    for (let i = 0; i < 200; i++) {
      const x = Math.floor(rng.next() * this.cols);
      const y = Math.floor(rng.next() * this.rows);
      const k = `${x},${y}`;
      if (!occupiedSet.has(k)) return { x, y };
    }
    // fallback: first empty cell
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const k = `${x},${y}`;
        if (!occupiedSet.has(k)) return { x, y };
      }
    }
    // should never happen unless board full
    return { x: 0, y: 0 };
  }
}

/** =========================
 * Snake
 * ========================= */
class Snake {
  constructor(id, name, color, startSegments, startDir) {
    this.id = id;
    this.name = name || `P${id}`;
    this.color = color || "#7cf7c2";
    this.segments = startSegments; // [{x,y}, ...] head first
    this.dir = startDir;
    this.nextDir = startDir;
    this.pendingGrow = 0;
    this.lastDeathTick = -1;
  }

  queueDirection(dirVec) {
    // requirement: direction change must take effect next tick
    // block 180-degree reversal
    if (!isOpposite(dirVec, this.dir)) {
      this.nextDir = dirVec;
    }
  }

  computeNextHead() {
    const head = this.segments[0];
    const d = this.nextDir || this.dir;
    return { x: head.x + d.x, y: head.y + d.y };
  }

  commitStep(nextHead) {
    // apply queued direction for this tick
    if (this.nextDir && !isOpposite(this.nextDir, this.dir)) {
      this.dir = this.nextDir;
    }

    // add new head
    this.segments.unshift(nextHead);

    // remove tail unless growing
    if (this.pendingGrow > 0) {
      this.pendingGrow -= 1;
    } else {
      this.segments.pop();
    }
  }

  grow(n = 1) {
    this.pendingGrow += n;
  }

  length() {
    return this.segments.length;
  }

  occupySet() {
    const s = new Set();
    for (const seg of this.segments) s.add(posKey(seg));
    return s;
  }

  resetTo(startSegments, startDir, tickNo) {
    this.segments = startSegments;
    this.dir = startDir;
    this.nextDir = startDir;
    this.pendingGrow = 0;
    this.lastDeathTick = tickNo;
  }
}

/** =========================
 * World / Game rules (host-authoritative)
 * ========================= */
class World {
  constructor({ board, rng }) {
    this.board = board;
    this.rng = rng;

    this.snakes = new Map(); // id -> Snake
    this.food = { x: 5, y: 5 };

    this.tickNo = 0;
    this.matchMsTotal = 60_000; // match duration requirement 5.1 (ändlig)
    this.matchMsLeft = this.matchMsTotal;

    this.status = "menu"; // menu | running | paused | over
    this.winnerText = "";
  }

  getOccupied() {
    const occ = new Set();
    for (const s of this.snakes.values()) {
      for (const seg of s.segments) occ.add(posKey(seg));
    }
    occ.add(posKey(this.food));
    return occ;
  }

  spawnFood() {
    const occ = new Set();
    for (const s of this.snakes.values()) {
      for (const seg of s.segments) occ.add(posKey(seg));
    }
    this.food = this.board.randomEmptyCell(occ, this.rng);
  }

  ensureFoodNotOnSnake() {
    const occ = new Set();
    for (const s of this.snakes.values()) {
      for (const seg of s.segments) occ.add(posKey(seg));
    }
    if (occ.has(posKey(this.food))) this.spawnFood();
  }

  addOrUpdateSnake(id, name, color) {
    const existing = this.snakes.get(id);
    if (existing) {
      existing.name = name || existing.name;
      existing.color = color || existing.color;
      return existing;
    }
    const start = this.randomValidSpawnSegments();
    const s = new Snake(id, name, color, start.segments, start.dir);
    this.snakes.set(id, s);
    this.ensureFoodNotOnSnake();
    return s;
  }

  randomValidSpawnSegments() {
    // Spawn length=2, horizontal
    // pick a head such that tail inside board too
    const tries = 400;
    for (let i = 0; i < tries; i++) {
      const dir = this.rng.next() < 0.5 ? DIRS.right : DIRS.left;
      const head = {
        x: Math.floor(this.rng.next() * this.board.cols),
        y: Math.floor(this.rng.next() * this.board.rows),
      };
      const tail = { x: head.x - dir.x, y: head.y - dir.y };
      if (!this.board.isInside(head) || !this.board.isInside(tail)) continue;

      const k1 = posKey(head);
      const k2 = posKey(tail);
      // ensure no overlap with other snakes
      const occ = new Set();
      for (const s of this.snakes.values()) {
        for (const seg of s.segments) occ.add(posKey(seg));
      }
      if (occ.has(k1) || occ.has(k2)) continue;

      return { segments: [head, tail], dir };
    }
    // fallback
    return {
      segments: [
        { x: 2, y: 2 },
        { x: 1, y: 2 },
      ],
      dir: DIRS.right,
    };
  }

  startNewMatch() {
    this.tickNo = 0;
    this.matchMsLeft = this.matchMsTotal;
    this.winnerText = "";
    this.status = "running";

    // reset snakes to valid spawns
    for (const s of this.snakes.values()) {
      const sp = this.randomValidSpawnSegments();
      s.resetTo(sp.segments, sp.dir, this.tickNo);
    }

    this.spawnFood();
  }

  togglePause() {
    if (this.status === "running") this.status = "paused";
    else if (this.status === "paused") this.status = "running";
  }

  update(dtMs) {
    if (this.status !== "running") return;

    this.matchMsLeft = Math.max(0, this.matchMsLeft - dtMs);
    if (this.matchMsLeft === 0) {
      this.endMatchByTime();
      return;
    }

    this.tickNo += 1;

    // 1) compute next heads
    const nextHeads = new Map(); // id -> {x,y}
    for (const [id, s] of this.snakes) {
      nextHeads.set(id, s.computeNextHead());
    }

    // 2) build occupancy map of current positions (before move)
    const occupancy = new Map(); // key -> { snakeId, segmentIndex }
    for (const [id, s] of this.snakes) {
      s.segments.forEach((seg, idx) => {
        // if two segments same cell (should not), keep first
        const k = posKey(seg);
        if (!occupancy.has(k))
          occupancy.set(k, { snakeId: id, segmentIndex: idx });
      });
    }

    // 3) determine deaths deterministically
    const deaths = new Set();

    // 3a) wall collisions + self/body collisions + snake-vs-snake
    // Deterministic: iterate snake ids sorted asc
    const idsSorted = [...this.snakes.keys()].sort((a, b) =>
      String(a).localeCompare(String(b))
    );

    for (const id of idsSorted) {
      const s = this.snakes.get(id);
      const nh = nextHeads.get(id);
      const nhKey = posKey(nh);

      // Wall
      if (!this.board.isInside(nh)) {
        deaths.add(id);
        continue;
      }

      // Collision into any existing cell (including other snakes, or own body)
      // NOTE: This defines "kör in" as head goes into a cell occupied BEFORE the tick.
      // Deterministic and consistent with spec 4.3.
      if (occupancy.has(nhKey)) {
        const hit = occupancy.get(nhKey);
        // if it's own head moving into its current tail cell in same tick?
        // We keep it simple & deterministic: any occupied cell => death.
        // (You can relax tail-rule, but this passes kraven.)
        deaths.add(id);
        continue;
      }
    }

    // 3b) head-on-head (both moving into same empty cell)
    // tie-break deterministic: both die
    const headTargets = new Map(); // cellKey -> [snakeId...]
    for (const id of idsSorted) {
      const k = posKey(nextHeads.get(id));
      if (!headTargets.has(k)) headTargets.set(k, []);
      headTargets.get(k).push(id);
    }
    for (const [cell, list] of headTargets.entries()) {
      if (list.length >= 2) {
        // both die deterministically
        for (const id of list) deaths.add(id);
      }
    }

    // 4) apply movement for survivors
    for (const id of idsSorted) {
      if (deaths.has(id)) continue;
      const s = this.snakes.get(id);
      const nh = nextHeads.get(id);
      s.commitStep(nh);
    }

    // 5) food consumption & growth
    for (const id of idsSorted) {
      if (deaths.has(id)) continue;
      const s = this.snakes.get(id);
      const head = s.segments[0];
      if (head.x === this.food.x && head.y === this.food.y) {
        s.grow(1); // length increase
        this.spawnFood();
      }
    }

    // 6) respawn deaths (4.2)
    for (const id of idsSorted) {
      if (!deaths.has(id)) continue;
      const s = this.snakes.get(id);
      const sp = this.randomValidSpawnSegments();
      s.resetTo(sp.segments, sp.dir, this.tickNo);
    }

    this.ensureFoodNotOnSnake();
  }

  endMatchByTime() {
    this.status = "over";

    // winner: longest length (5.3), tie-break: deterministic draw
    const snakesArr = [...this.snakes.values()];
    snakesArr.sort((a, b) => b.length() - a.length());
    if (snakesArr.length === 0) {
      this.winnerText = "No players";
      return;
    }

    const bestLen = snakesArr[0].length();
    const tied = snakesArr.filter((s) => s.length() === bestLen);

    if (tied.length >= 2) {
      this.winnerText = `Draw (${bestLen})`;
    } else {
      this.winnerText = `${snakesArr[0].name} wins (${bestLen})`;
    }
  }

  snapshot() {
    // minimal state to render on clients
    return {
      tickNo: this.tickNo,
      status: this.status,
      matchMsLeft: this.matchMsLeft,
      board: { cols: this.board.cols, rows: this.board.rows },
      food: { ...this.food },
      snakes: [...this.snakes.values()].map((s) => ({
        id: s.id,
        name: s.name,
        color: s.color,
        dir: s.dir,
        segments: s.segments.map((p) => ({ ...p })),
      })),
      winnerText: this.winnerText,
    };
  }

  applySnapshot(state) {
    // client-side: replace state (render only)
    this.tickNo = state.tickNo;
    this.status = state.status;
    this.matchMsLeft = state.matchMsLeft;
    this.food = { ...state.food };
    this.winnerText = state.winnerText || "";

    // sync snakes
    this.snakes.clear();
    for (const sn of state.snakes) {
      const s = new Snake(sn.id, sn.name, sn.color, sn.segments, sn.dir);
      this.snakes.set(sn.id, s);
    }
  }
}

/** =========================
 * Renderer (canvas)
 * ========================= */
class Renderer {
  constructor(canvas, overlayEls) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.overlayEls = overlayEls;

    this.cellSize = 20; // computed later
    this.padding = 16;
  }

  setGrid(cols, rows) {
    // choose cell size based on canvas pixel size
    const w = this.canvas.width - this.padding * 2;
    const h = this.canvas.height - this.padding * 2;
    this.cellSize = Math.floor(Math.min(w / cols, h / rows));
  }

  clear() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  drawWorld(world) {
    const { ctx, canvas } = this;
    const cols = world.board.cols;
    const rows = world.board.rows;
    this.setGrid(cols, rows);

    const gridW = cols * this.cellSize;
    const gridH = rows * this.cellSize;

    const ox = Math.floor((canvas.width - gridW) / 2);
    const oy = Math.floor((canvas.height - gridH) / 2);

    // board background
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(ox - 8, oy - 8, gridW + 16, gridH + 16);

    // subtle grid
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= cols; x++) {
      ctx.beginPath();
      ctx.moveTo(ox + x * this.cellSize, oy);
      ctx.lineTo(ox + x * this.cellSize, oy + gridH);
      ctx.stroke();
    }
    for (let y = 0; y <= rows; y++) {
      ctx.beginPath();
      ctx.moveTo(ox, oy + y * this.cellSize);
      ctx.lineTo(ox + gridW, oy + y * this.cellSize);
      ctx.stroke();
    }

    // food
    this.drawCell(ox, oy, world.food, "rgba(255, 230, 120, 0.95)", 8);

    // snakes
    for (const s of world.snakes.values()) {
      for (let i = s.segments.length - 1; i >= 0; i--) {
        const seg = s.segments[i];
        const isHead = i === 0;
        const alpha = isHead ? 0.98 : 0.78;
        const radius = isHead ? 6 : 10;

        this.drawCell(ox, oy, seg, this.withAlpha(s.color, alpha), radius);

        if (isHead) {
          // head marker
          ctx.save();
          ctx.fillStyle = "rgba(0,0,0,0.25)";
          ctx.beginPath();
          const cx = ox + seg.x * this.cellSize + this.cellSize / 2;
          const cy = oy + seg.y * this.cellSize + this.cellSize / 2;
          ctx.arc(cx, cy, Math.max(2, this.cellSize * 0.12), 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    }

    // border
    ctx.strokeStyle = "rgba(255,255,255,0.20)";
    ctx.lineWidth = 2;
    ctx.strokeRect(ox, oy, gridW, gridH);

    ctx.restore();
  }

  drawCell(ox, oy, p, color, radiusPx = 10) {
    const { ctx } = this;
    const x = ox + p.x * this.cellSize;
    const y = oy + p.y * this.cellSize;
    const r = Math.min(radiusPx, this.cellSize / 2);

    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    this.roundRect(ctx, x + 1, y + 1, this.cellSize - 2, this.cellSize - 2, r);
    ctx.fill();
    ctx.restore();
  }

  roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  withAlpha(hexOrCss, a) {
    // If it's hex like #RRGGBB, convert
    if (
      typeof hexOrCss === "string" &&
      hexOrCss.startsWith("#") &&
      hexOrCss.length === 7
    ) {
      const r = parseInt(hexOrCss.slice(1, 3), 16);
      const g = parseInt(hexOrCss.slice(3, 5), 16);
      const b = parseInt(hexOrCss.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${a})`;
    }
    return hexOrCss;
  }

  showOverlay(show) {
    this.overlayEls.overlay.classList.toggle("show", !!show);
  }

  setOverlay(title, msg) {
    this.overlayEls.title.textContent = title;
    this.overlayEls.msg.textContent = msg;
  }
}

/** =========================
 * Multiplayer Controller (host-authority)
 * ========================= */
class MultiplayerController {
  constructor(wsUrl) {
    this.api = new MultiplayerApi(wsUrl);

    this.isHost = false;
    this.sessionId = "";
    this.clientId = "";
    this.unsub = null;

    this.expectedMsgId = 0;
    this.buffer = new Map(); // msgId -> {event, clientId, data}
    this.onJoined = () => {};
    this.onGame = () => {};
    this.onError = () => {};
  }

  async host() {
    this.isHost = true;
    this.sessionId = await this.api.host();
    this.listen();
    return this.sessionId;
  }

  async join(sessionId, data) {
    this.isHost = false;
    this.sessionId = sessionId;
    await this.api.join(sessionId, data);
    this.listen();
  }

  listen() {
    if (this.unsub) this.unsub();
    this.expectedMsgId = 0;
    this.buffer.clear();

    this.unsub = this.api.listen((event, messageId, clientId, data) => {
      // store then process in order (8.4 requirement)
      this.buffer.set(messageId, { event, clientId, data });

      while (this.buffer.has(this.expectedMsgId)) {
        const msg = this.buffer.get(this.expectedMsgId);
        this.buffer.delete(this.expectedMsgId);

        if (msg.event === "joined") {
          this.onJoined(msg.clientId, msg.data);
        } else if (msg.event === "game") {
          this.onGame(msg.clientId, msg.data);
        }
        this.expectedMsgId += 1;
      }
    });
  }

  sendGame(data) {
    return this.api.game(data);
  }

  close() {
    if (this.unsub) this.unsub();
    this.unsub = null;
  }
}

/** =========================
 * App glue
 * ========================= */
class App {
  constructor() {
    // --- UI refs
    this.canvas = document.getElementById("game");
    this.statusText = document.getElementById("statusText");
    this.timeText = document.getElementById("timeText");
    this.p1Text = document.getElementById("p1Text");
    this.p2Text = document.getElementById("p2Text");

    this.overlay = document.getElementById("overlay");
    this.overlayTitle = document.getElementById("overlayTitle");
    this.overlayMsg = document.getElementById("overlayMsg");
    this.btnNewMatch = document.getElementById("btnNewMatch");
    this.btnTogglePause = document.getElementById("btnTogglePause");

    this.playerNameInput = document.getElementById("playerName");
    this.btnHost = document.getElementById("btnHost");
    this.btnJoin = document.getElementById("btnJoin");
    this.sessionIdInput = document.getElementById("sessionId");

    this.btnVote = document.getElementById("btnVote");
    this.studentNumberEl = document.getElementById("studentNumber");

    this.scoreList = document.getElementById("scoreList");
    this.btnClearScores = document.getElementById("btnClearScores");

    // --- Config
    this.STUDENT_NUMBER = "42"; // <-- ÄNDRA till numret du får av läraren (krav 10.3)
    this.VOTE_LINK = "https://example.com/vote"; // <-- ÄNDRA till riktiga omröstningslänken (krav 10.4)
    this.WS_URL = "ws://localhost:8080"; // <-- enligt spec-exempel. Byt om utbildaren använder annan.

    // --- Core instances
    const board = new Board(24, 16);
    const rng = new Mulberry32(123456789);
    this.world = new World({ board, rng });

    this.renderer = new Renderer(this.canvas, {
      overlay: this.overlay,
      title: this.overlayTitle,
      msg: this.overlayMsg,
    });

    this.scoreboard = new ScoreboardStore();

    this.mp = new MultiplayerController(this.WS_URL);

    // --- Identity
    this.localPlayer = {
      name: "Player",
      color: "#7cf7c2",
      // In this architecture, clientId comes from mp events.
      clientId: "",
      snakeId: "",
    };

    // --- Host input buffer (from clients)
    this.latestInputByClient = new Map(); // clientId -> dirName

    // --- Timers
    this.tickHz = 10; // fixed tick (3.5)
    this.tickMs = Math.floor(1000 / this.tickHz);
    this.accMs = 0;
    this.lastTs = performance.now();
    this.running = false;

    // --- init
    this.studentNumberEl.textContent = this.STUDENT_NUMBER;
    this.btnVote.addEventListener("click", () =>
      window.open(this.VOTE_LINK, "_blank")
    );

    this.btnNewMatch.addEventListener("click", () => this.requestNewMatch());
    this.btnTogglePause.addEventListener("click", () =>
      this.requestTogglePause()
    );

    this.btnHost.addEventListener("click", () => this.doHost());
    this.btnJoin.addEventListener("click", () => this.doJoin());

    this.btnClearScores.addEventListener("click", () => {
      // dev helper
      this.scoreboard.clear();
      this.renderScoreboard();
    });

    window.addEventListener("keydown", (e) => this.onKey(e));

    // MP event wiring
    this.mp.onJoined = (clientId, data) => this.onClientJoined(clientId, data);
    this.mp.onGame = (clientId, data) => this.onGameMessage(clientId, data);

    // Local singleplayer fallback: create two snakes locally so UI always has P1/P2
    this.setupLocalTwoPlayers();

    this.renderScoreboard();
    this.startLoop();
  }

  setupLocalTwoPlayers() {
    // Use fixed ids for local mode
    this.world.addOrUpdateSnake("local-1", "P1", "#7cf7c2");
    this.world.addOrUpdateSnake("local-2", "P2", "#788cff");
    this.world.startNewMatch();
    this.updateHudAndRender();
  }

  startLoop() {
    this.running = true;
    requestAnimationFrame((ts) => this.loop(ts));
  }

  loop(ts) {
    if (!this.running) return;

    const dt = ts - this.lastTs;
    this.lastTs = ts;
    this.accMs += dt;

    // Host runs simulation; clients only render snapshots
    // In local mode (not connected), we simulate too.
    const simulate = this.mp.sessionId ? this.mp.isHost : true;

    if (simulate) {
      while (this.accMs >= this.tickMs) {
        this.world.update(this.tickMs);
        this.accMs -= this.tickMs;

        // If host: broadcast state periodically (here: every tick)
        if (this.mp.sessionId && this.mp.isHost) {
          this.mp.sendGame({ type: "state", state: this.world.snapshot() });
        }

        // If match ended: write scoreboard once (host or local)
        if (this.world.status === "over") {
          this.onMatchEndedMaybePersist();
        }
      }
    }

    this.updateHudAndRender();
    requestAnimationFrame((t) => this.loop(t));
  }

  updateHudAndRender() {
    this.statusText.textContent = this.world.status;
    this.timeText.textContent = this.formatMs(this.world.matchMsLeft);

    // show two first snakes as P1/P2 (for HUD)
    const snakes = [...this.world.snakes.values()];
    const p1 = snakes[0];
    const p2 = snakes[1];

    this.p1Text.textContent = p1 ? String(p1.length()) : "-";
    this.p2Text.textContent = p2 ? String(p2.length()) : "-";

    this.renderer.drawWorld(this.world);

    if (this.world.status === "over") {
      this.renderer.showOverlay(true);
      this.renderer.setOverlay(
        "Match Over",
        this.world.winnerText || "Match ended"
      );
    } else if (this.world.status === "paused") {
      this.renderer.showOverlay(true);
      this.renderer.setOverlay("Paused", "Press P to resume.");
    } else {
      this.renderer.showOverlay(false);
    }
  }

  formatMs(ms) {
    const s = Math.ceil(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  renderScoreboard() {
    const entries = this.scoreboard.load();
    if (entries.length === 0) {
      this.scoreList.innerHTML = `<div class="small">No scores yet. Finish a match.</div>`;
      return;
    }
    this.scoreList.innerHTML = entries
      .slice(0, 30)
      .map(
        (e) => `
        <div class="scoreitem">
          <div><b>${escapeHtml(e.name)}</b> <span>(${new Date(
          e.date
        ).toLocaleString()})</span></div>
          <div><b>${e.score}</b></div>
        </div>`
      )
      .join("");
  }

  onMatchEndedMaybePersist() {
    // Persist only once per match end
    if (this._persistedAtTick === this.world.tickNo) return;
    this._persistedAtTick = this.world.tickNo;

    // If host or local: write scoreboard entry for winner if not draw
    const txt = this.world.winnerText || "";
    if (txt.startsWith("Draw")) {
      // tie-break chosen: draw (deterministic)
      this.renderScoreboard();
      return;
    }

    const winnerName = txt.split(" wins")[0]?.trim() || "Winner";
    const winnerSnake = [...this.world.snakes.values()].find(
      (s) => s.name === winnerName
    );
    const score = winnerSnake ? winnerSnake.length() : 0;

    this.scoreboard.add({
      name: winnerName,
      score,
      date: new Date().toISOString(),
    });
    this.renderScoreboard();
  }

  /** ========= Input ========= */
  onKey(e) {
    const k = e.key.toLowerCase();

    if (k === "p") {
      this.requestTogglePause();
      return;
    }
    if (k === "r") {
      this.requestNewMatch();
      return;
    }

    const dirName =
      k === "arrowup"
        ? "up"
        : k === "arrowdown"
        ? "down"
        : k === "arrowleft"
        ? "left"
        : k === "arrowright"
        ? "right"
        : null;

    if (!dirName) return;
    e.preventDefault();

    // If connected:
    // - host applies to local snake directly and receives others via messages
    // - client sends input to host
    if (this.mp.sessionId) {
      if (this.mp.isHost) {
        // host: apply to the snake belonging to this client (if known)
        const myId = this.localPlayer.snakeId;
        const s = myId ? this.world.snakes.get(myId) : null;
        if (s) s.queueDirection(DIRS[dirName]);

        // broadcast input is not required, host will broadcast state
      } else {
        this.mp.sendGame({ type: "input", dir: dirName });
      }
      return;
    }

    // Local mode: control snake 1
    const s1 = this.world.snakes.get("local-1");
    if (s1) s1.queueDirection(DIRS[dirName]);
  }

  requestTogglePause() {
    if (this.mp.sessionId) {
      if (this.mp.isHost) {
        this.world.togglePause();
        this.mp.sendGame({ type: "state", state: this.world.snapshot() });
      } else {
        // clients can't pause host; you can disable or send request
        this.mp.sendGame({ type: "req", action: "pause" });
      }
    } else {
      this.world.togglePause();
    }
  }

  requestNewMatch() {
    if (this.mp.sessionId) {
      if (this.mp.isHost) {
        this.world.startNewMatch();
        this._persistedAtTick = -1;
        this.mp.sendGame({ type: "state", state: this.world.snapshot() });
      } else {
        this.mp.sendGame({ type: "req", action: "newMatch" });
      }
    } else {
      this.world.startNewMatch();
      this._persistedAtTick = -1;
    }
  }

  /** ========= Multiplayer ========= */
  async doHost() {
    const name = (this.playerNameInput.value || "Host").trim();
    this.localPlayer.name = name;

    // Host creates session
    const sessionId = await this.mp.host();
    this.sessionIdInput.value = sessionId;

    // Host creates its own snake with snakeId = clientId once we know it.
    // We'll create immediately with a placeholder id; update on joined event.
    // Many implementations send joined to host too; we handle both cases.
    // Start match clean:
    this.world.snakes.clear();
    this.latestInputByClient.clear();

    // add host snake now (temp id)
    this.localPlayer.snakeId = "host";
    this.world.addOrUpdateSnake(this.localPlayer.snakeId, name, "#7cf7c2");

    // Optionally add a CPU snake in host mode? Not needed.
    this.world.startNewMatch();
    this._persistedAtTick = -1;

    // Broadcast initial state
    this.mp.sendGame({ type: "state", state: this.world.snapshot() });
  }

  async doJoin() {
    const name = (this.playerNameInput.value || "Client").trim();
    const sessionId = (this.sessionIdInput.value || "").trim();
    if (!sessionId) {
      alert("Fyll i Session ID först.");
      return;
    }
    this.localPlayer.name = name;

    // join
    await this.mp.join(sessionId, { name, color: "#788cff" });

    // client: clear local simulation snakes; wait for host state
    this.world.snakes.clear();
    this.world.status = "menu";
  }

  onClientJoined(clientId, data) {
    // Host gets this when someone joins.
    // Deterministic mapping: snakeId = clientId
    if (!this.mp.isHost) return;

    const name = data?.name ? String(data.name) : `Player-${clientId}`;
    const color = data?.color ? String(data.color) : "#788cff";

    // create snake for the joining client
    this.world.addOrUpdateSnake(clientId, name, color);

    // If this joined event is actually host itself, align ids
    // (depends on how server/API works)
    if (!this.localPlayer.snakeId || this.localPlayer.snakeId === "host") {
      // If the joined event corresponds to us, some APIs will include our own join too.
      // We can't know for sure, but if host currently uses "host" id, we can keep it.
      // If you'd rather force host id to be clientId, do it here (requires migrating snake).
    }

    // Broadcast updated state
    this.mp.sendGame({ type: "state", state: this.world.snapshot() });
  }

  onGameMessage(clientId, data) {
    if (!data || typeof data !== "object") return;

    // Host receives input from clients, applies to their snake
    if (this.mp.isHost) {
      if (data.type === "input") {
        const dirName = data.dir;
        if (!DIRS[dirName]) return;

        const snake = this.world.snakes.get(clientId);
        if (snake) snake.queueDirection(DIRS[dirName]);
        return;
      }

      if (data.type === "req") {
        // Deterministic handling for requests
        if (data.action === "newMatch") {
          this.world.startNewMatch();
          this._persistedAtTick = -1;
          this.mp.sendGame({ type: "state", state: this.world.snapshot() });
        }
        if (data.action === "pause") {
          this.world.togglePause();
          this.mp.sendGame({ type: "state", state: this.world.snapshot() });
        }
        return;
      }

      return;
    }

    // Client receives state snapshots from host
    if (data.type === "state" && data.state) {
      this.world.applySnapshot(data.state);
    }
  }
}

/** Simple HTML escape for scoreboard rendering */
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Boot
new App();
