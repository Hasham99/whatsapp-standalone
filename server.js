// Load .env file if present (production secrets)
try { require("fs").readFileSync(".env","utf8").split("\n").forEach(l=>{const[k,...v]=l.split("=");if(k&&v.length)process.env[k.trim()]=v.join("=").trim();}); } catch {}

const express  = require("express");
const http     = require("http");
const { Server } = require("socket.io");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode   = require("qrcode");
const path     = require("path");
const fs       = require("fs");
const crypto   = require("crypto");
const { spawnSync } = require("child_process");
const jwt      = require("jsonwebtoken");

// Use env variable in production: JWT_SECRET=<strong-secret> node server.js
const JWT_SECRET        = process.env.JWT_SECRET || "whatsapp-platform-secret-change-in-prod";
const ACCESS_EXPIRES    = "1h";   // access token lifetime
const REFRESH_EXPIRES   = "30d";  // refresh token lifetime

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Persistence ────────────────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, "data.json");
let db = { users: [], apps: [], schedules: [], recurring: [] };

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {}
  }
  if (!Array.isArray(db.users))         db.users         = [];
  if (!Array.isArray(db.apps))          db.apps          = [];
  if (!Array.isArray(db.schedules))     db.schedules     = [];
  if (!Array.isArray(db.recurring))     db.recurring     = [];
  if (!Array.isArray(db.refreshTokens)) db.refreshTokens = [];
  // Purge expired refresh tokens
  const now = new Date();
  db.refreshTokens = db.refreshTokens.filter(t => new Date(t.expiresAt) > now);

  // Seed default admin if no admin user exists
  if (!db.users.find(u => u.role === "admin")) {
    db.users.unshift({
      username:  "admin",
      name:      "Administrator",
      email:     "admin@platform.local",
      password:  "admin123",
      role:      "admin",
      createdAt: new Date().toISOString(),
    });
    saveData();
  }
}

function saveData() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ── JWT Helpers ────────────────────────────────────────────────────────────────
function generateTokens(user) {
  const jti = crypto.randomBytes(16).toString("hex");

  const accessToken = jwt.sign(
    { username: user.username, role: user.role, type: "access" },
    JWT_SECRET,
    { expiresIn: ACCESS_EXPIRES }
  );
  const refreshToken = jwt.sign(
    { username: user.username, jti, type: "refresh" },
    JWT_SECRET,
    { expiresIn: REFRESH_EXPIRES }
  );

  if (!Array.isArray(db.refreshTokens)) db.refreshTokens = [];
  db.refreshTokens.push({
    jti,
    username:  user.username,
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
  });
  saveData();
  return { accessToken, refreshToken };
}

function verifyAccessToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  if (payload.type !== "access") throw new Error("Not an access token");
  return payload;
}

// ── WhatsApp Client Registry ───────────────────────────────────────────────────
const clients = new Map(); // appId → { client, status, lastQR }

// ── Schedule Timer Registry ────────────────────────────────────────────────────
const timers          = new Map(); // scheduleId → timeoutHandle
const recurringTimers = new Map(); // recurringId → timeoutHandle

// ── Auth Helpers ───────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers["x-auth-token"] || req.headers["authorization"];
  const token  = header?.startsWith("Bearer ") ? header.slice(7) : header;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const payload = verifyAccessToken(token);
    req.username  = payload.username;
    req.role      = payload.role;
    next();
  } catch {
    return res.status(401).json({ error: "Token expired or invalid" });
  }
}

function requireAdmin(req, res, next) {
  const header = req.headers["x-auth-token"] || req.headers["authorization"];
  const token  = header?.startsWith("Bearer ") ? header.slice(7) : header;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const payload = verifyAccessToken(token);
    if (payload.role !== "admin") return res.status(403).json({ error: "Admin access required" });
    req.username = payload.username;
    req.role     = payload.role;
    next();
  } catch {
    return res.status(401).json({ error: "Token expired or invalid" });
  }
}

function requireApiKey(req, res, next) {
  const key   = req.headers["x-api-key"];
  const appId = req.params.appId;
  const waApp = db.apps.find(a => a.id === appId);
  if (!waApp)               return res.status(404).json({ error: "App not found" });
  if (waApp.apiKey !== key) return res.status(401).json({ error: "Invalid API key" });
  req.waApp = waApp;
  next();
}

// Admin can access any app; users can only access their own
function getOwnedApp(appId, username, role) {
  const waApp = db.apps.find(a => a.id === appId);
  if (!waApp) return null;
  if (role === "admin" || waApp.owner === username) return waApp;
  return null;
}

// ── Timezone Helper ────────────────────────────────────────────────────────────
// "YYYY-MM-DDTHH:mm" (PKT = UTC+5) → UTC milliseconds
function karachiStringToMs(localStr) {
  return Date.parse(localStr + ":00.000Z") - 5 * 60 * 60 * 1000;
}

// ── WhatsApp Helpers ───────────────────────────────────────────────────────────
function destroySingletonLock(clientId) {
  const userDataDir = path.join(__dirname, ".wwebjs_auth", `session-${clientId}`);
  const lockPath    = path.join(userDataDir, "SingletonLock");

  try {
    const result = spawnSync("pgrep", ["-f", userDataDir], { encoding: "utf8" });
    if (result.stdout) {
      const pids = result.stdout.trim().split("\n").filter(Boolean);
      for (const pid of pids) {
        try { process.kill(Number(pid), "SIGKILL"); } catch {}
      }
      const wait = Date.now() + 1500;
      while (Date.now() < wait) { /* spin */ }
    }
  } catch {}

  if (fs.existsSync(lockPath)) {
    try { fs.unlinkSync(lockPath); } catch (e) { console.warn("Lock remove failed:", e.message); }
  }
}

function createWhatsAppClient(waApp) {
  destroySingletonLock(waApp.id);

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: waApp.id,
      dataPath: path.join(__dirname, ".wwebjs_auth"),
    }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas", "--no-first-run", "--no-zygote",
        "--disable-gpu", "--disable-extensions", "--disable-software-rasterizer", "--mute-audio",
      ],
      timeout: 60000,
    },
  });

  const state = { client, status: "INITIALIZING", lastQR: null };
  clients.set(waApp.id, state);

  client.on("qr", async (qr) => {
    const img    = await QRCode.toDataURL(qr);
    state.lastQR = img;
    state.status = "INITIALIZING";
    io.to(`app:${waApp.id}`).emit(`wa_qr_${waApp.id}`, { qr: img });
    console.log(`📱 QR generated for app "${waApp.name}" (${waApp.id})`);
  });

  client.on("authenticated", () => {
    io.to(`app:${waApp.id}`).emit(`wa_authenticated_${waApp.id}`);
  });

  client.on("ready", () => {
    state.status = "READY";
    state.lastQR = null;
    const info   = client.info;
    io.to(`app:${waApp.id}`).emit(`wa_ready_${waApp.id}`, {
      number: info?.wid?.user || "unknown",
      name:   info?.pushname  || "WhatsApp",
    });
    console.log(`✅ App "${waApp.name}" ready — ${info?.wid?.user}`);
  });

  client.on("auth_failure", (msg) => {
    state.status = "DISCONNECTED";
    io.to(`app:${waApp.id}`).emit(`wa_error_${waApp.id}`, { message: msg });
    clients.delete(waApp.id);
    console.error(`❌ Auth failure for "${waApp.name}":`, msg);
  });

  client.on("disconnected", (reason) => {
    state.status = "DISCONNECTED";
    state.lastQR  = null;
    io.to(`app:${waApp.id}`).emit(`wa_disconnected_${waApp.id}`, { reason });
    clients.delete(waApp.id);
    console.warn(`⚠️  App "${waApp.name}" disconnected:`, reason);
  });

  client.initialize();
  return state;
}

function waitForReady(appId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const state = clients.get(appId);
    if (!state) return reject(new Error("Client not found"));
    if (state.status === "READY") return resolve(state);

    const timer = setTimeout(() => {
      state.client.removeListener("ready", onReady);
      state.client.removeListener("auth_failure", onFail);
      state.client.removeListener("disconnected", onFail);
      reject(new Error("Timeout waiting for WhatsApp ready"));
    }, timeoutMs);

    function onReady() {
      clearTimeout(timer);
      state.client.removeListener("auth_failure", onFail);
      state.client.removeListener("disconnected", onFail);
      resolve(state);
    }
    function onFail(reason) {
      clearTimeout(timer);
      state.client.removeListener("ready", onReady);
      reject(new Error(`Client failed during restart: ${reason}`));
    }

    state.client.once("ready", onReady);
    state.client.once("auth_failure", onFail);
    state.client.once("disconnected", onFail);
  });
}

async function reinitializeClient(waApp) {
  const existing = clients.get(waApp.id);
  if (existing?.client) {
    try { await existing.client.destroy(); } catch {}
    clients.delete(waApp.id);
  }
  createWhatsAppClient(waApp);
  return waitForReady(waApp.id, 30000);
}

async function sendViaApp(appId, number, message) {
  const state = clients.get(appId);
  if (!state || state.status !== "READY") {
    const status = state?.status || "DISCONNECTED";
    throw new Error(`WhatsApp not ready (status: ${status})`);
  }
  const clean  = number.replace(/\D/g, "");
  const chatId = `${clean}@c.us`;
  const waApp  = db.apps.find(a => a.id === appId);
  const body   = waApp ? `*[${waApp.name}]*\n\n${message}` : message;

  try {
    await state.client.sendMessage(chatId, body);
  } catch (e) {
    if (e.message && e.message.includes("detached Frame")) {
      console.warn(`⚠️  Detached frame for app ${appId}, restarting client…`);
      await reinitializeClient(waApp);
      const fresh = clients.get(appId);
      await fresh.client.sendMessage(chatId, body);
    } else {
      throw e;
    }
  }
}

// ── PKT (UTC+5) Helpers ────────────────────────────────────────────────────────
function utcToPKT(d) { return new Date(d.getTime() + 5 * 3600000); }
function pktToUtc(d) { return new Date(d.getTime() - 5 * 3600000); }

function calcNextFire(rec) {
  const nowUtc = new Date();
  const pktNow = utcToPKT(nowUtc);

  if (rec.frequency === "daily") {
    const f = new Date(pktNow);
    f.setUTCHours(rec.timeHour, rec.timeMinute, 0, 0);
    if (pktToUtc(f).getTime() <= nowUtc.getTime()) f.setUTCDate(f.getUTCDate() + 1);
    return pktToUtc(f);
  }

  if (rec.frequency === "weekly") {
    const f = new Date(pktNow);
    f.setUTCHours(rec.timeHour, rec.timeMinute, 0, 0);
    let diff = rec.weekday - f.getUTCDay();
    if (diff < 0 || (diff === 0 && pktToUtc(f).getTime() <= nowUtc.getTime())) diff += 7;
    f.setUTCDate(f.getUTCDate() + diff);
    return pktToUtc(f);
  }

  // every_n_minutes or hourly
  const mins       = rec.frequency === "hourly" ? 60 : (rec.intervalMinutes || 30);
  const fireUtc    = new Date(nowUtc.getTime() + mins * 60000);
  const firePKT    = utcToPKT(fireUtc);
  const [wsh, wsm] = rec.windowStart.split(":").map(Number);
  const [weh, wem] = rec.windowEnd.split(":").map(Number);
  const fireMins   = firePKT.getUTCHours() * 60 + firePKT.getUTCMinutes();
  if (fireMins >= wsh * 60 + wsm && fireMins < weh * 60 + wem) return fireUtc;

  const windowOpen = new Date(firePKT);
  windowOpen.setUTCHours(wsh, wsm, 0, 0);
  if (windowOpen.getTime() <= firePKT.getTime()) windowOpen.setUTCDate(windowOpen.getUTCDate() + 1);
  return pktToUtc(windowOpen);
}

function scheduleRecurring(rec) {
  if (rec.status !== "active") return;
  const nextFire = calcNextFire(rec);
  rec.nextFireAt = nextFire.toISOString();
  // Do NOT call saveData() here — writing data.json triggers nodemon restarts

  const handle = setTimeout(async () => {
    recurringTimers.delete(rec.id);

    if (rec.frequency === "every_n_minutes" || rec.frequency === "hourly") {
      const p = utcToPKT(new Date());
      const [wsh, wsm] = rec.windowStart.split(":").map(Number);
      const [weh, wem] = rec.windowEnd.split(":").map(Number);
      const nowMins = p.getUTCHours() * 60 + p.getUTCMinutes();
      if (nowMins < wsh * 60 + wsm || nowMins >= weh * 60 + wem) {
        scheduleRecurring(rec);
        return;
      }
    }

    const logEntry = { firedAt: new Date().toISOString(), results: [] };
    for (const r of rec.recipients) {
      try {
        await sendViaApp(rec.appId, r.number, r.message);
        logEntry.results.push({ number: r.number, status: "sent" });
      } catch (e) {
        logEntry.results.push({ number: r.number, status: "failed", error: e.message });
      }
    }

    if (!rec.logs) rec.logs = [];
    rec.logs.unshift(logEntry);
    if (rec.logs.length > 30) rec.logs.length = 30;
    saveData();

    io.to(`app:${rec.appId}`).emit(`recurring_fired_${rec.appId}`, { id: rec.id, log: logEntry });
    scheduleRecurring(rec);
  }, Math.max(nextFire.getTime() - Date.now(), 1000));

  recurringTimers.set(rec.id, handle);
}

// ── Scheduled Messages ─────────────────────────────────────────────────────────
function scheduleMessage(sched) {
  const fireAt = karachiStringToMs(sched.scheduledTime);
  const delay  = fireAt - Date.now();

  if (delay <= 0) {
    sched.status = "expired";
    saveData();
    return;
  }

  const handle = setTimeout(async () => {
    try {
      await sendViaApp(sched.appId, sched.number, sched.message);
      sched.status = "sent";
    } catch (e) {
      sched.status = "failed";
      console.error(`Scheduled msg ${sched.id} failed:`, e.message);
    }
    timers.delete(sched.id);
    saveData();
    io.to(`app:${sched.appId}`).emit(`schedule_fired_${sched.appId}`, {
      id:     sched.id,
      status: sched.status,
    });
  }, delay);

  timers.set(sched.id, handle);
}

// ── Socket.IO ──────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`);

  // External apps (e.g. bookable) authenticate with their API key
  socket.on("subscribe_external", ({ apiKey, appId }) => {
    const waApp = db.apps.find(a => a.id === appId && a.apiKey === apiKey);
    if (!waApp) { socket.emit("auth_error", { error: "Invalid API key" }); return; }

    socket.join(`app:${appId}`);
    const state  = clients.get(appId);
    const status = state?.status || "DISCONNECTED";
    socket.emit(`wa_status_${appId}`, { status, hasQR: !!(state?.lastQR) });
    if (state?.lastQR) socket.emit(`wa_qr_${appId}`, { qr: state.lastQR });
    if (status === "READY") {
      const info = state.client.info;
      socket.emit(`wa_ready_${appId}`, {
        number: info?.wid?.user || "unknown",
        name:   info?.pushname  || "WhatsApp",
      });
    }
  });

  socket.on("subscribe", ({ token, appIds }) => {
    let session;
    try { session = verifyAccessToken(token); } catch {
      socket.emit("auth_error", { error: "Bad token" }); return;
    }

    for (const appId of (appIds || [])) {
      const waApp = db.apps.find(a =>
        a.id === appId && (session.role === "admin" || a.owner === session.username)
      );
      if (!waApp) continue;
      socket.join(`app:${appId}`);

      const state  = clients.get(appId);
      const status = state?.status || "DISCONNECTED";
      socket.emit(`wa_status_${appId}`, { status, hasQR: !!(state?.lastQR) });
      if (state?.lastQR) socket.emit(`wa_qr_${appId}`, { qr: state.lastQR });
      if (status === "READY") {
        const info = state.client.info;
        socket.emit(`wa_ready_${appId}`, {
          number: info?.wid?.user || "unknown",
          name:   info?.pushname  || "WhatsApp",
        });
      }
    }
  });
});

// ── Auth Routes ────────────────────────────────────────────────────────────────
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const user = db.users.find(u =>
    (u.username === username || u.email === username) && u.password === password
  );
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const { accessToken, refreshToken } = generateTokens(user);
  res.json({ accessToken, refreshToken, username: user.username, name: user.name, role: user.role });
});

app.post("/api/auth/refresh", (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: "refreshToken required" });
  try {
    const payload = jwt.verify(refreshToken, JWT_SECRET);
    if (payload.type !== "refresh") return res.status(401).json({ error: "Invalid token type" });

    const stored = db.refreshTokens.find(t => t.jti === payload.jti && t.username === payload.username);
    if (!stored) return res.status(401).json({ error: "Token revoked or not found" });

    const user = db.users.find(u => u.username === payload.username);
    if (!user) return res.status(401).json({ error: "User not found" });

    // Rotate: remove old, issue new pair
    db.refreshTokens = db.refreshTokens.filter(t => t.jti !== payload.jti);
    const tokens = generateTokens(user);
    res.json({ ...tokens, username: user.username, name: user.name, role: user.role });
  } catch {
    return res.status(401).json({ error: "Refresh token expired or invalid" });
  }
});

app.post("/api/logout", requireAuth, (req, res) => {
  const { refreshToken } = req.body || {};
  if (refreshToken) {
    try {
      const payload = jwt.verify(refreshToken, JWT_SECRET, { ignoreExpiration: true });
      db.refreshTokens = db.refreshTokens.filter(t => t.jti !== payload.jti);
      saveData();
    } catch {}
  }
  res.json({ success: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  const user = db.users.find(u => u.username === req.username);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ username: user.username, name: user.name, email: user.email, role: user.role });
});

app.post("/api/signup", (req, res) => {
  const { username, name, email, password } = req.body;
  if (!username?.trim()) return res.status(400).json({ error: "Username required" });
  if (!name?.trim())     return res.status(400).json({ error: "Name required" });
  if (!email?.trim())    return res.status(400).json({ error: "Email required" });
  if (!password)         return res.status(400).json({ error: "Password required" });

  if (db.users.find(u => u.username === username.trim()))
    return res.status(409).json({ error: "Username already taken" });
  if (db.users.find(u => u.email === email.trim()))
    return res.status(409).json({ error: "Email already registered" });

  const newUser = {
    username:  username.trim(),
    name:      name.trim(),
    email:     email.trim(),
    password,
    role:      "user",
    createdAt: new Date().toISOString(),
  };
  db.users.push(newUser);
  saveData();

  const { accessToken, refreshToken } = generateTokens(newUser);
  res.json({ accessToken, refreshToken, username: newUser.username, name: newUser.name, role: newUser.role });
});

// ── Admin — User Management ────────────────────────────────────────────────────
app.get("/api/admin/users", requireAdmin, (req, res) => {
  res.json(db.users.map(u => ({
    username:  u.username,
    name:      u.name,
    email:     u.email,
    role:      u.role,
    createdAt: u.createdAt,
    appCount:  db.apps.filter(a => a.owner === u.username).length,
  })));
});

app.post("/api/admin/users", requireAdmin, (req, res) => {
  const { username, name, email, password, role } = req.body;
  if (!username?.trim()) return res.status(400).json({ error: "Username required" });
  if (!name?.trim())     return res.status(400).json({ error: "Name required" });
  if (!email?.trim())    return res.status(400).json({ error: "Email required" });
  if (!password)         return res.status(400).json({ error: "Password required" });

  if (db.users.find(u => u.username === username.trim()))
    return res.status(409).json({ error: "Username already taken" });
  if (db.users.find(u => u.email === email.trim()))
    return res.status(409).json({ error: "Email already registered" });

  const newUser = {
    username:  username.trim(),
    name:      name.trim(),
    email:     email.trim(),
    password,
    role:      role === "admin" ? "admin" : "user",
    createdAt: new Date().toISOString(),
  };
  db.users.push(newUser);
  saveData();
  res.json({ success: true, user: { ...newUser, password: undefined } });
});

app.put("/api/admin/users/:uname", requireAdmin, (req, res) => {
  const user = db.users.find(u => u.username === req.params.uname);
  if (!user) return res.status(404).json({ error: "User not found" });

  const { name, email, password, role } = req.body;
  if (name)     user.name     = name.trim();
  if (email)    user.email    = email.trim();
  if (password) user.password = password;
  if (role && (role === "admin" || role === "user")) {
    // Prevent removing the last admin
    if (user.role === "admin" && role === "user") {
      const adminCount = db.users.filter(u => u.role === "admin").length;
      if (adminCount <= 1) return res.status(400).json({ error: "Cannot remove the last admin" });
    }
    user.role = role;
  }
  saveData();
  res.json({ success: true, user: { username: user.username, name: user.name, email: user.email, role: user.role } });
});

app.delete("/api/admin/users/:uname", requireAdmin, async (req, res) => {
  const uname = req.params.uname;
  if (uname === req.username) return res.status(400).json({ error: "Cannot delete your own account" });

  const idx = db.users.findIndex(u => u.username === uname);
  if (idx === -1) return res.status(404).json({ error: "User not found" });

  const user = db.users[idx];
  if (user.role === "admin") {
    const adminCount = db.users.filter(u => u.role === "admin").length;
    if (adminCount <= 1) return res.status(400).json({ error: "Cannot delete the last admin" });
  }

  // Destroy all apps and sessions owned by this user
  const userApps = db.apps.filter(a => a.owner === uname);
  for (const waApp of userApps) {
    db.schedules.filter(s => s.appId === waApp.id).forEach(s => {
      if (timers.has(s.id)) { clearTimeout(timers.get(s.id)); timers.delete(s.id); }
    });
    db.recurring.filter(r => r.appId === waApp.id).forEach(r => {
      if (recurringTimers.has(r.id)) { clearTimeout(recurringTimers.get(r.id)); recurringTimers.delete(r.id); }
    });
    const state = clients.get(waApp.id);
    if (state?.client) {
      try { await state.client.destroy(); } catch {}
      clients.delete(waApp.id);
    }
    const authPath = path.join(__dirname, ".wwebjs_auth", `session-${waApp.id}`);
    if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });
  }

  db.apps      = db.apps.filter(a => a.owner !== uname);
  db.schedules = db.schedules.filter(s => !userApps.find(a => a.id === s.appId));
  db.recurring = db.recurring.filter(r => !userApps.find(a => a.id === r.appId));
  db.users.splice(idx, 1);
  saveData();
  res.json({ success: true });
});

// ── App Management ─────────────────────────────────────────────────────────────
app.get("/api/apps", requireAuth, (req, res) => {
  const list = req.role === "admin"
    ? db.apps
    : db.apps.filter(a => a.owner === req.username);

  res.json(list.map(a => ({
    ...a,
    status:    clients.get(a.id)?.status || "DISCONNECTED",
    ownerName: db.users.find(u => u.username === a.owner)?.name || a.owner,
  })));
});

app.post("/api/apps", requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "App name required" });

  const newApp = {
    id:        crypto.randomBytes(4).toString("hex"),
    name:      name.trim(),
    owner:     req.username,
    apiKey:    "sk-" + crypto.randomBytes(24).toString("hex"),
    createdAt: new Date().toISOString(),
  };
  db.apps.push(newApp);
  saveData();
  res.json({ ...newApp, status: "DISCONNECTED" });
});

app.delete("/api/apps/:appId", requireAuth, async (req, res) => {
  const waApp = getOwnedApp(req.params.appId, req.username, req.role);
  if (!waApp) return res.status(404).json({ error: "App not found" });

  db.schedules.filter(s => s.appId === waApp.id).forEach(s => {
    if (timers.has(s.id)) { clearTimeout(timers.get(s.id)); timers.delete(s.id); }
  });
  db.recurring.filter(r => r.appId === waApp.id).forEach(r => {
    if (recurringTimers.has(r.id)) { clearTimeout(recurringTimers.get(r.id)); recurringTimers.delete(r.id); }
  });

  const state = clients.get(waApp.id);
  if (state?.client) {
    try { await state.client.logout();  } catch {}
    try { await state.client.destroy(); } catch {}
    clients.delete(waApp.id);
  }

  const authPath = path.join(__dirname, ".wwebjs_auth", `session-${waApp.id}`);
  if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });

  db.apps      = db.apps.filter(a => a.id !== waApp.id);
  db.schedules = db.schedules.filter(s => s.appId !== waApp.id);
  db.recurring = db.recurring.filter(r => r.appId !== waApp.id);
  saveData();
  res.json({ success: true });
});

// ── WhatsApp Control ───────────────────────────────────────────────────────────
app.post("/api/apps/:appId/init", requireAuth, (req, res) => {
  const waApp = getOwnedApp(req.params.appId, req.username, req.role);
  if (!waApp) return res.status(404).json({ error: "App not found" });

  const state = clients.get(waApp.id);
  if (state?.status === "READY")        return res.json({ success: true, status: "ALREADY_READY" });
  if (state?.status === "INITIALIZING") return res.json({ success: true, status: "INITIALIZING" });

  createWhatsAppClient(waApp);
  res.json({ success: true, status: "INITIALIZING" });
});

app.post("/api/apps/:appId/logout", requireAuth, async (req, res) => {
  const waApp = getOwnedApp(req.params.appId, req.username, req.role);
  if (!waApp) return res.status(404).json({ error: "App not found" });

  const state = clients.get(waApp.id);
  if (state?.client) {
    try { await state.client.logout();  } catch {}
    try { await state.client.destroy(); } catch {}
    clients.delete(waApp.id);
  }

  const authPath = path.join(__dirname, ".wwebjs_auth", `session-${waApp.id}`);
  if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });

  io.to(`app:${waApp.id}`).emit(`wa_disconnected_${waApp.id}`, { reason: "logout" });
  res.json({ success: true });
});

// ── Send Route (dashboard) ─────────────────────────────────────────────────────
app.post("/api/apps/:appId/send", requireAuth, async (req, res) => {
  const waApp = getOwnedApp(req.params.appId, req.username, req.role);
  if (!waApp) return res.status(404).json({ error: "App not found" });

  const { number, message } = req.body;
  if (!number || !message) return res.status(400).json({ error: "number and message required" });

  try {
    await sendViaApp(waApp.id, number, message);
    res.json({ success: true });
  } catch (e) {
    res.status(503).json({ success: false, error: e.message });
  }
});

// ── Schedule Routes ────────────────────────────────────────────────────────────
app.get("/api/apps/:appId/schedules", requireAuth, (req, res) => {
  const waApp = getOwnedApp(req.params.appId, req.username, req.role);
  if (!waApp) return res.status(404).json({ error: "App not found" });
  res.json(db.schedules.filter(s => s.appId === waApp.id));
});

app.post("/api/apps/:appId/schedules", requireAuth, (req, res) => {
  const waApp = getOwnedApp(req.params.appId, req.username, req.role);
  if (!waApp) return res.status(404).json({ error: "App not found" });

  const { number, message, scheduledTime } = req.body;
  if (!number || !message || !scheduledTime)
    return res.status(400).json({ error: "number, message and scheduledTime required" });

  const fireAt = karachiStringToMs(scheduledTime);
  if (isNaN(fireAt))        return res.status(400).json({ error: "Invalid scheduledTime" });
  if (fireAt <= Date.now()) return res.status(400).json({ error: "scheduledTime must be in the future" });

  const sched = {
    id:            crypto.randomBytes(6).toString("hex"),
    appId:         waApp.id,
    number,
    message,
    scheduledTime,
    status:        "pending",
    createdAt:     new Date().toISOString(),
  };

  db.schedules.push(sched);
  saveData();
  scheduleMessage(sched);
  res.json(sched);
});

app.delete("/api/apps/:appId/schedules/:schedId", requireAuth, (req, res) => {
  const waApp = getOwnedApp(req.params.appId, req.username, req.role);
  if (!waApp) return res.status(404).json({ error: "App not found" });

  const idx = db.schedules.findIndex(s => s.id === req.params.schedId && s.appId === waApp.id);
  if (idx === -1) return res.status(404).json({ error: "Schedule not found" });

  const [sched] = db.schedules.splice(idx, 1);
  if (timers.has(sched.id)) { clearTimeout(timers.get(sched.id)); timers.delete(sched.id); }
  saveData();
  res.json({ success: true });
});

// ── Recurring Schedule Routes ──────────────────────────────────────────────────
app.get("/api/apps/:appId/recurring", requireAuth, (req, res) => {
  const waApp = getOwnedApp(req.params.appId, req.username, req.role);
  if (!waApp) return res.status(404).json({ error: "App not found" });
  res.json(db.recurring.filter(r => r.appId === waApp.id));
});

app.post("/api/apps/:appId/recurring", requireAuth, (req, res) => {
  const waApp = getOwnedApp(req.params.appId, req.username, req.role);
  if (!waApp) return res.status(404).json({ error: "App not found" });

  const { frequency, intervalMinutes, timeHour, timeMinute, weekday,
          windowStart, windowEnd, recipients } = req.body;

  if (!frequency) return res.status(400).json({ error: "frequency required" });
  if (!Array.isArray(recipients) || recipients.length === 0)
    return res.status(400).json({ error: "recipients must be a non-empty array" });
  for (const r of recipients) {
    if (!r.number || !r.message)
      return res.status(400).json({ error: "each recipient needs number and message" });
  }
  if ((frequency === "every_n_minutes" || frequency === "hourly") && (!windowStart || !windowEnd))
    return res.status(400).json({ error: "windowStart and windowEnd required for this frequency" });

  const rec = {
    id:              crypto.randomBytes(6).toString("hex"),
    appId:           waApp.id,
    frequency,
    intervalMinutes: frequency === "every_n_minutes" ? (Number(intervalMinutes) || 30) : undefined,
    timeHour:        (frequency === "daily" || frequency === "weekly") ? Number(timeHour) : undefined,
    timeMinute:      (frequency === "daily" || frequency === "weekly") ? Number(timeMinute) : undefined,
    weekday:         frequency === "weekly" ? Number(weekday) : undefined,
    windowStart:     windowStart || "08:00",
    windowEnd:       windowEnd   || "22:00",
    recipients,
    status:          "active",
    logs:            [],
    nextFireAt:      null,
    createdAt:       new Date().toISOString(),
  };

  db.recurring.push(rec);
  saveData();
  scheduleRecurring(rec);
  res.json(rec);
});

app.put("/api/apps/:appId/recurring/:recId", requireAuth, (req, res) => {
  const waApp = getOwnedApp(req.params.appId, req.username, req.role);
  if (!waApp) return res.status(404).json({ error: "App not found" });

  const rec = db.recurring.find(r => r.id === req.params.recId && r.appId === waApp.id);
  if (!rec) return res.status(404).json({ error: "Recurring schedule not found" });

  if (recurringTimers.has(rec.id)) { clearTimeout(recurringTimers.get(rec.id)); recurringTimers.delete(rec.id); }

  const { frequency, intervalMinutes, timeHour, timeMinute, weekday,
          windowStart, windowEnd, recipients, status } = req.body;

  if (frequency)                                              rec.frequency       = frequency;
  if (intervalMinutes !== undefined)                          rec.intervalMinutes = Number(intervalMinutes);
  if (timeHour        !== undefined)                          rec.timeHour        = Number(timeHour);
  if (timeMinute      !== undefined)                          rec.timeMinute      = Number(timeMinute);
  if (weekday         !== undefined)                          rec.weekday         = Number(weekday);
  if (windowStart)                                            rec.windowStart     = windowStart;
  if (windowEnd)                                              rec.windowEnd       = windowEnd;
  if (recipients && Array.isArray(recipients) && recipients.length > 0) rec.recipients = recipients;
  if (status && (status === "active" || status === "paused")) rec.status          = status;

  saveData();
  if (rec.status === "active") scheduleRecurring(rec);
  res.json(rec);
});

app.delete("/api/apps/:appId/recurring/:recId", requireAuth, (req, res) => {
  const waApp = getOwnedApp(req.params.appId, req.username, req.role);
  if (!waApp) return res.status(404).json({ error: "App not found" });

  const idx = db.recurring.findIndex(r => r.id === req.params.recId && r.appId === waApp.id);
  if (idx === -1) return res.status(404).json({ error: "Recurring schedule not found" });

  const [rec] = db.recurring.splice(idx, 1);
  if (recurringTimers.has(rec.id)) { clearTimeout(recurringTimers.get(rec.id)); recurringTimers.delete(rec.id); }
  saveData();
  res.json({ success: true });
});

// ── External API Webhook ───────────────────────────────────────────────────────

// Create a sub-slot for an admin user inside an app (returns a child appId + apiKey)
// Body: { adminId: "unique-string-per-admin" }
// Returns existing slot if adminId already registered under this app
app.post("/webhook/:appId/slots", requireApiKey, (req, res) => {
  const { adminId } = req.body;
  if (!adminId?.toString().trim()) return res.status(400).json({ error: "adminId required" });

  const parentApp = req.waApp;
  const slotName  = `${parentApp.name}__${String(adminId).trim()}`;

  // Return existing slot if already created
  const existing = db.apps.find(a => a.parentAppId === parentApp.id && a.adminId === String(adminId).trim());
  if (existing) {
    return res.json({
      slotId:  existing.id,
      apiKey:  existing.apiKey,
      adminId: existing.adminId,
      status:  clients.get(existing.id)?.status || "DISCONNECTED",
    });
  }

  const slot = {
    id:          crypto.randomBytes(4).toString("hex"),
    name:        slotName,
    owner:       parentApp.owner,
    parentAppId: parentApp.id,
    adminId:     String(adminId).trim(),
    apiKey:      "sk-" + crypto.randomBytes(24).toString("hex"),
    createdAt:   new Date().toISOString(),
  };
  db.apps.push(slot);
  saveData();
  res.json({
    slotId:  slot.id,
    apiKey:  slot.apiKey,
    adminId: slot.adminId,
    status:  "DISCONNECTED",
  });
});

// List all slots created under a parent app
app.get("/webhook/:appId/slots", requireApiKey, (req, res) => {
  const slots = db.apps
    .filter(a => a.parentAppId === req.waApp.id)
    .map(a => ({
      slotId:    a.id,
      adminId:   a.adminId,
      status:    clients.get(a.id)?.status || "DISCONNECTED",
      createdAt: a.createdAt,
    }));
  res.json(slots);
});

// Delete a slot
app.delete("/webhook/:appId/slots/:slotId", requireApiKey, async (req, res) => {
  const slot = db.apps.find(a => a.id === req.params.slotId && a.parentAppId === req.waApp.id);
  if (!slot) return res.status(404).json({ error: "Slot not found" });

  const state = clients.get(slot.id);
  if (state?.client) {
    try { await state.client.destroy(); } catch {}
    clients.delete(slot.id);
  }
  const authPath = path.join(__dirname, ".wwebjs_auth", `session-${slot.id}`);
  if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });

  db.apps      = db.apps.filter(a => a.id !== slot.id);
  db.schedules = db.schedules.filter(s => s.appId !== slot.id);
  db.recurring = db.recurring.filter(r => r.appId !== slot.id);
  saveData();
  res.json({ success: true });
});

// Allow an external app to trigger WhatsApp init (start QR process) via API key
app.post("/webhook/:appId/init", requireApiKey, (req, res) => {
  const state = clients.get(req.waApp.id);
  if (state?.status === "READY")        return res.json({ success: true, status: "ALREADY_READY" });
  if (state?.status === "INITIALIZING") return res.json({ success: true, status: "INITIALIZING" });
  createWhatsAppClient(req.waApp);
  res.json({ success: true, status: "INITIALIZING" });
});

app.post("/webhook/:appId/send", requireApiKey, async (req, res) => {
  const { number, message } = req.body;
  if (!number || !message) return res.status(400).json({ error: "number and message required" });

  try {
    await sendViaApp(req.waApp.id, number, message);
    res.json({ success: true });
  } catch (e) {
    res.status(503).json({ success: false, error: e.message });
  }
});

// ── Health ─────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  const clientStates = {};
  for (const [appId, state] of clients.entries()) {
    clientStates[appId] = state.status;
  }
  res.json({ status: "ok", clients: clientStates });
});

app.get("/webhook/:appId/health", requireApiKey, (req, res) => {
  const state = clients.get(req.waApp.id);
  res.json({
    appId:  req.waApp.id,
    name:   req.waApp.name,
    status: state?.status || "DISCONNECTED",
  });
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3500;

loadData();

server.listen(PORT, () => {
  console.log(`🚀 WhatsApp Multi-App running at http://localhost:${PORT}`);

  for (const waApp of db.apps) {
    const sessionPath = path.join(__dirname, ".wwebjs_auth", `session-${waApp.id}`);
    if (fs.existsSync(sessionPath)) {
      console.log(`💾 Restoring session for "${waApp.name}" (${waApp.id})`);
      createWhatsAppClient(waApp);
    }
  }

  for (const sched of db.schedules) {
    if (sched.status === "pending") scheduleMessage(sched);
  }

  for (const rec of db.recurring) {
    if (rec.status === "active") scheduleRecurring(rec);
  }
});
