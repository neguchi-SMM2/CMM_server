"use strict";
/**
 * マリオメーカー風ゲーム クラウド変数サーバー v3
 */

const WebSocket = require("ws");
const http      = require("http");
const fs        = require("fs");
const path      = require("path");
const { Session, Cloud } = require("scratchcloud");

const db = require("./database");
const {
  encodeNum, decodeNum,
  encodeLen, decodeLen,
  encodeLenLen, decodeLenLen,
  encodeAlphabet, decodeAlphabet,
  encodeText, decodeText,
} = require("./encode");

const USERNAME      = process.env.SCRATCH_USERNAME;
const PASSWORD      = process.env.SCRATCH_PASSWORD;
const PROJECT_ID    = parseInt(process.env.SCRATCH_PROJECT_ID, 10);
const PORT          = parseInt(process.env.PORT || "3000", 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const REQUEST_VARS = ["☁ request1", "☁ request2"];
const CLOUD_VARS   = [
  "☁ cloud1","☁ cloud2","☁ cloud3","☁ cloud4",
  "☁ cloud5","☁ cloud6","☁ cloud7","☁ cloud8",
];

const CMD = {
  UPLOAD:        1,
  RANDOM:       10,
  WEEKLY:       11,
  ALL_TIME:     12,
  SEARCH_ID:    13,
  SEARCH_AUTHOR:14,
  LIKE:         20,
  PLAY:         21,
  ATTEMPT:      22,
  CLEAR:        23,
  GET_COURSE:   30,
  GET_NOTIFY:   40,
  BAN_USERNAME:600,
};

const SEND_INTERVAL = 120;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomCloud() { return CLOUD_VARS[Math.floor(Math.random() * CLOUD_VARS.length)]; }

function parseUserId(s, pos = 0) {
  const { value, next } = decodeLenLen(s, pos);
  return { userId: String(value), next };
}
function parseCmd(s, pos) {
  const { value, next } = decodeLen(s, pos);
  return { cmd: value, next };
}

async function sendCloud(setter, name, value) {
  await setter(name, String(value));
  await sleep(SEND_INTERVAL);
}

function encodeCourseInfo(row, index) {
  const clearRate = row.attempt_count > 0
    ? Math.round(row.clear_count / row.attempt_count * 10000) / 100
    : 0;
  const clearRateEncoded = Math.round(clearRate * 100);
  return encodeLen(index)
    + encodeLen(row.like_count)
    + encodeLen(row.play_count)
    + encodeLen(clearRateEncoded)
    + encodeText(row.title)
    + encodeAlphabet(row.id)
    + encodeAlphabet(row.author)
    + encodeLen(row.posted_at);
}

async function sendCourseList(setter, userId, cmd, rows) {
  const header = encodeLenLen(parseInt(userId)) + encodeLen(cmd);
  const maxLen = 1000;
  let buffer = "";
  let courseIndex = 1;
  for (const row of rows) {
    const courseEncoded = encodeCourseInfo(row, courseIndex);
    if (buffer.length > 0 && (header + buffer + courseEncoded).length > maxLen) {
      await sendCloud(setter, randomCloud(), header + buffer);
      buffer = "";
    }
    buffer += courseEncoded;
    courseIndex++;
  }
  if (buffer.length > 0) {
    await sendCloud(setter, randomCloud(), header + buffer);
  }
}

async function sendCourseData(setter, userId, stageData) {
  const headerBase = encodeLenLen(parseInt(userId)) + encodeLen(CMD.GET_COURSE);
  const maxLen = 1000;
  const overhead = headerBase.length + 2 + 2;
  const chunkSize = maxLen - overhead;
  const totalChunks = Math.ceil(stageData.length / chunkSize);
  const totalEnc = encodeLen(totalChunks);
  for (let i = 0; i < totalChunks; i++) {
    const seq = i + 1;
    const chunk = stageData.slice(i * chunkSize, (i + 1) * chunkSize);
    await sendCloud(setter, randomCloud(), headerBase + totalEnc + encodeLen(seq) + chunk);
  }
  await sendCloud(setter, randomCloud(), headerBase + totalEnc + encodeLen(0));
}

function isValidNum(value) { return typeof value === "number" && !isNaN(value) && isFinite(value); }
function isValidStr(value) { return typeof value === "string" && value.length > 0; }

async function handleRequest(s, setter) {
  let pos = 0;
  const { userId, next: p1 } = parseUserId(s, pos); pos = p1;
  if (!userId || isNaN(parseInt(userId))) { console.warn("⚠️ 不正なユーザーID:", userId); return; }
  const { cmd, next: p2 } = parseCmd(s, pos); pos = p2;
  if (!isValidNum(cmd)) { console.warn("⚠️ 不正なコマンドコード:", cmd); return; }

  // CMD=10〜12: ランキング・ランダム
  if (cmd === CMD.RANDOM || cmd === CMD.WEEKLY || cmd === CMD.ALL_TIME) {
    const { value: limit, next: p3 } = decodeLen(s, pos); pos = p3;
    if (!isValidNum(limit) || limit <= 0) { console.warn("⚠️ 不正なlimit:", limit); return; }
    let rows;
    if      (cmd === CMD.RANDOM)   rows = await db.getRandomCourses(limit);
    else if (cmd === CMD.WEEKLY)   rows = await db.getWeeklyRanking(limit);
    else                           rows = await db.getAllTimeRanking(limit);
    await sendCourseList(setter, userId, cmd, rows);
    return;
  }

  // CMD=13: コースID検索
  if (cmd === CMD.SEARCH_ID) {
    const { value: courseId } = decodeAlphabet(s, pos);
    if (!isValidStr(courseId)) { console.warn("⚠️ 不正なcourseId:", courseId); return; }
    const rows = await db.searchByCourseId(courseId);
    if (!rows.length) {
      await sendCloud(setter, randomCloud(), encodeLenLen(parseInt(userId)) + encodeLen(300));
      return;
    }
    await sendCourseList(setter, userId, cmd, rows);
    return;
  }

  // CMD=14: 作者名検索
  if (cmd === CMD.SEARCH_AUTHOR) {
    const { value: author, next: p3 } = decodeAlphabet(s, pos); pos = p3;
    if (!isValidStr(author)) { console.warn("⚠️ 不正なauthor:", author); return; }
    const { value: limit } = decodeLen(s, pos);
    if (!isValidNum(limit) || limit <= 0) { console.warn("⚠️ 不正なlimit:", limit); return; }
    const rows = await db.searchByAuthor(author, limit);
    if (!rows.length) {
      await sendCloud(setter, randomCloud(), encodeLenLen(parseInt(userId)) + encodeLen(300));
      return;
    }
    await sendCourseList(setter, userId, cmd, rows);
    return;
  }

  // CMD=20〜23: 統計更新
  if (cmd === CMD.LIKE || cmd === CMD.PLAY || cmd === CMD.ATTEMPT || cmd === CMD.CLEAR) {
    const { value: username, next: p3 } = decodeAlphabet(s, pos); pos = p3;
    const { value: courseId } = decodeAlphabet(s, pos);
    if (!isValidStr(username) || !isValidStr(courseId)) {
      console.warn("⚠️ 不正なusername/courseId:", username, courseId); return;
    }
    if (cmd === CMD.PLAY)    { await db.incrementPlay(courseId); await db.incrementAttempt(courseId); return; }
    if (cmd === CMD.ATTEMPT) { await db.incrementAttempt(courseId); return; }
    if (cmd === CMD.CLEAR)   { await db.incrementClear(courseId);   return; }
    if (cmd === CMD.LIKE) {
      const banned = await db.isUserBanned(username);
      if (banned) {
        await sendCloud(setter, randomCloud(), encodeLenLen(parseInt(userId)) + encodeLen(405));
        return;
      }
      const { alreadyLiked } = await db.addLike(username, courseId);
      if (alreadyLiked) {
        await sendCloud(setter, randomCloud(), encodeLenLen(parseInt(userId)) + encodeLen(200));
      } else {
        await sendCloud(setter, randomCloud(), encodeLenLen(parseInt(userId)) + encodeLen(201));
      }
      return;
    }
  }

  // CMD=30: コースデータ取得
  if (cmd === CMD.GET_COURSE) {
    const { value: courseId } = decodeAlphabet(s, pos);
    if (!isValidStr(courseId)) { console.warn("⚠️ 不正なcourseId:", courseId); return; }
    const row = await db.getCourseById(courseId);
    if (!row) return;
    await sendCourseData(setter, userId, row.stage_data);
    return;
  }

  // CMD=40: 通知取得
  if (cmd === CMD.GET_NOTIFY) {
    const { value: username } = decodeAlphabet(s, pos);
    if (!isValidStr(username)) { console.warn("⚠️ 不正なusername:", username); return; }
    const notification = await db.getAndDeleteNotification(username);
    if (notification) {
      await sendCloud(setter, randomCloud(), encodeLenLen(parseInt(userId)) + encodeLen(notification.cmd));
    } else {
      await sendCloud(setter, randomCloud(), encodeLenLen(parseInt(userId)) + encodeLen(500));
    }
    return;
  }

  // CMD=600: ユーザー名変更検知→自動BAN
  if (cmd === CMD.BAN_USERNAME) {
    const { value: username } = decodeAlphabet(s, pos);
    if (!isValidStr(username)) { console.warn("⚠️ 不正なusername:", username); return; }
    const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60; // 15分BAN
    await db.banUser(username, expiresAt);
    console.log(`🔨 自動BAN: ${username}`);
    return;
  }

  console.warn("⚠️ 未知のコマンドコード:", cmd);
}

const uploadBuffers = new Map();
const UPLOAD_TIMEOUT = 60 * 1000;

async function handleUploadChunk(s, setter) {
  let pos = 0;
  const { userId, next: p1 } = parseUserId(s, pos); pos = p1;
  const { cmd, next: p2 } = parseCmd(s, pos); pos = p2;
  if (cmd !== CMD.UPLOAD) return;

  // username取得
  const { value: username, next: p3 } = decodeAlphabet(s, pos); pos = p3;
  if (!isValidStr(username)) { console.warn("⚠️ 不正なusername:", username); return; }

  // BANチェック
  const banned = await db.isUserBanned(username);
  if (banned) {
    await sendCloud(setter, randomCloud(), encodeLenLen(parseInt(userId)) + encodeLen(103));
    return;
  }

  const { value: totalChunks, next: p4 } = decodeLen(s, pos); pos = p4;
  const { value: seq, next: p5 } = decodeLen(s, pos); pos = p5;

  if (!uploadBuffers.has(userId)) {
    const timer = setTimeout(() => uploadBuffers.delete(userId), UPLOAD_TIMEOUT);
    uploadBuffers.set(userId, { totalChunks, chunks: new Map(), timer, username });
  }
  const buf = uploadBuffers.get(userId);
  buf.totalChunks = totalChunks;
  buf.username = username;

  if (seq === 0) {
    const { value: title, next: p6 } = decodeText(s, pos); pos = p6;
    const { value: author } = decodeAlphabet(s, pos);
    buf.title  = title;
    buf.author = author;

    let allPresent = true;
    for (let i = 1; i <= buf.totalChunks; i++) {
      if (!buf.chunks.has(i)) { allPresent = false; break; }
    }
    clearTimeout(buf.timer);
    uploadBuffers.delete(userId);

    if (allPresent) {
      let stageData = "";
      for (let i = 1; i <= totalChunks; i++) stageData += buf.chunks.get(i);
      try {
        const result = await db.saveCourse(buf.title, buf.author, buf.username, stageData);
        if (result.duplicate) {
          await sendCloud(setter, randomCloud(), encodeLenLen(parseInt(userId)) + encodeLen(102));
        } else {
          await sendCloud(setter, randomCloud(), encodeLenLen(parseInt(userId)) + encodeLen(100) + encodeAlphabet(result.id));
        }
      } catch (e) {
        console.error("コース保存失敗:", e.message);
        await sendCloud(setter, randomCloud(), encodeLenLen(parseInt(userId)) + encodeLen(101));
      }
    } else {
      await sendCloud(setter, randomCloud(), encodeLenLen(parseInt(userId)) + encodeLen(101));
    }
  } else {
    buf.chunks.set(seq, s.slice(pos));
  }
}

async function onMessage(name, value, setter) {
  const s = String(value);
  if (!s || s.length < 3) return;
  try {
    const { next: p1 } = parseUserId(s, 0);
    const { cmd }      = parseCmd(s, p1);
    if (cmd === CMD.UPLOAD) {
      await handleUploadChunk(s, setter);
    } else if (REQUEST_VARS.includes(name)) {
      await handleRequest(s, setter);
    }
  } catch (e) {
    console.error(`❌ メッセージ処理エラー (${name}):`, e.message);
  }
}

// ─────────────────────────────────────────────
// 管理ページ用APIハンドラ
// ─────────────────────────────────────────────
function checkAuth(req) {
  const auth = req.headers["authorization"] || "";
  const b64  = auth.replace(/^Basic /, "");
  const decoded = Buffer.from(b64, "base64").toString("utf8");
  const [, pass] = decoded.split(":");
  return pass === ADMIN_PASSWORD;
}

async function handleManageAPI(req, res) {
  if (!checkAuth(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="manage"', "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  // POST /api/delete-course
  if (req.method === "POST" && pathname === "/api/delete-course") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", async () => {
      try {
        const { courseId, reason } = JSON.parse(body);
        if (!courseId || !reason) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "courseId, reason は必須です" }));
          return;
        }
        const deleted = await db.deleteCourse(courseId);
        if (!deleted) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "コースが見つかりません" }));
          return;
        }
        await db.upsertNotification(deleted.username, reason);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /api/ban-user
  if (req.method === "POST" && pathname === "/api/ban-user") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", async () => {
      try {
        const { username, duration } = JSON.parse(body);
        if (!username || !duration) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "username, duration は必須です" }));
          return;
        }
        const expiresAt = Math.floor(Date.now() / 1000) + parseInt(duration, 10);
        await db.banUser(username, expiresAt);
        await db.upsertNotification(username, 400);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

class CloudManager {
  constructor() {
    this.scratch    = { conn: null, isReconnecting: false, delay: 5000 };
    this.turbowarp  = { conn: null, isReconnecting: false, delay: 2000 };
    this.queue      = [];
    this.processing = false;
  }

  enqueue(name, value, setter) {
    this.queue.push({ name, value, setter });
    if (!this.processing) this.processQueue();
  }

  async processQueue() {
    this.processing = true;
    while (this.queue.length > 0) {
      const { name, value, setter } = this.queue.shift();
      await onMessage(name, value, setter);
    }
    this.processing = false;
  }

  async connectScratch() {
    if (this.scratch.conn || this.scratch.isReconnecting) return;
    this.scratch.isReconnecting = true;
    try {
      console.log("🔄 Scratch Cloud 接続中...");
      const timeout = ms => new Promise((_, r) => setTimeout(() => r(new Error("タイムアウト")), ms));
      const session = await Promise.race([Session.createAsync(USERNAME, PASSWORD), timeout(15000)]);
      const cloud   = await Promise.race([Cloud.createAsync(session, PROJECT_ID),  timeout(15000)]);
      this.scratch.conn  = cloud;
      this.scratch.delay = 5000;
      console.log("✅ Scratch Cloud 接続成功");
      const setter = (name, value) => { cloud.set(name, String(value)); return Promise.resolve(); };
      console.log("🔄 クラウド変数を初期化中...");
      for (const v of [...REQUEST_VARS, ...CLOUD_VARS]) { await setter(v, "0"); await sleep(SEND_INTERVAL); }
      console.log("✅ クラウド変数初期化完了");
      cloud.on("set", (name, value) => {
        const fullName = name.startsWith("☁ ") ? name : `☁ ${name}`;
        if ([...REQUEST_VARS, ...CLOUD_VARS].includes(fullName)) this.enqueue(fullName, value, setter);
      });
      cloud.on("close", () => { console.warn("⚠️ Scratch 切断"); this.scratch.conn = null; this.scheduleReconnect("scratch"); });
      cloud.on("error", e => { console.error("❌ Scratch エラー:", e.message); this.scratch.conn = null; this.scheduleReconnect("scratch"); });
    } catch (e) {
      console.error("❌ Scratch 接続失敗:", e.message);
      console.log("⚠️ Scratch接続をスキップ。TurboWarpのみで運用します。");
      this.scratch.conn = null;
      setTimeout(() => {
        this.scratch.isReconnecting = false;
        this.scheduleReconnect("scratch");
      }, 60000);
    }
  }

  connectTurboWarp() {
    if (this.turbowarp.conn?.readyState === WebSocket.OPEN || this.turbowarp.isReconnecting) return;
    this.turbowarp.isReconnecting = true;
    try {
      const ws = new WebSocket("wss://clouddata.turbowarp.org", { headers: { "User-Agent": "MarioMakerServer/1.0" } });
      const setter = (name, value) => {
        if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("TW切断"));
        ws.send(JSON.stringify({ method: "set", name, value: String(value), user: "server-bot", project_id: PROJECT_ID }));
        return Promise.resolve();
      };
      ws.on("open", async () => {
        ws.send(JSON.stringify({ method: "handshake", user: "server-bot", project_id: PROJECT_ID }));
        this.turbowarp.conn  = ws;
        this.turbowarp.delay = 2000;
        this.turbowarp.isReconnecting = false;
        console.log("✅ TurboWarp Cloud 接続成功");
        console.log("🔄 TurboWarp クラウド変数を初期化中...");
        for (const v of [...REQUEST_VARS, ...CLOUD_VARS]) { await setter(v, "0"); await sleep(SEND_INTERVAL); }
        console.log("✅ TurboWarp クラウド変数初期化完了");
      });
      ws.on("message", raw => {
        try {
          const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
          for (const line of text.trim().split("\n")) {
            if (!line) continue;
            const data = JSON.parse(line);
            if (data.method === "set" && [...REQUEST_VARS, ...CLOUD_VARS].includes(data.name))
              this.enqueue(data.name, data.value, setter);
          }
        } catch (e) { console.warn("⚠️ TW メッセージ解析失敗:", e.message); }
      });
      ws.on("close", () => { console.warn("⚠️ TurboWarp 切断"); this.turbowarp.conn = null; this.turbowarp.isReconnecting = false; this.scheduleReconnect("turbowarp"); });
      ws.on("error", e => { console.error("❌ TurboWarp エラー:", e.message); this.turbowarp.conn = null; this.turbowarp.isReconnecting = false; this.scheduleReconnect("turbowarp"); });
    } catch (e) {
      console.error("❌ TurboWarp 接続作成失敗:", e.message);
      this.turbowarp.isReconnecting = false;
      this.scheduleReconnect("turbowarp");
    }
  }

  scheduleReconnect(mode) {
    const data = this[mode];
    if (data.isReconnecting) return;
    const delay = Math.min(data.delay, 30000);
    console.log(`⏰ ${mode} 再接続 ${delay}ms 後`);
    data.delay = Math.min(data.delay * 1.5, 30000);
    setTimeout(() => { if (mode === "scratch") this.connectScratch(); else this.connectTurboWarp(); }, delay);
  }

  scheduleWeeklyReset() {
    setInterval(async () => {
      await db.deleteOldLikes().catch(e => console.error("いいねクリーンアップ失敗:", e));
      console.log("🗑️ いいねクリーンアップ実行");
    }, 60 * 60 * 1000);
    console.log("📅 いいねクリーンアップ: 1時間ごとに実行");
  }

  async start() {
    process.on("uncaughtException", e => {
      console.error("❌ uncaughtException:", e.message);
    });
    process.on("unhandledRejection", e => {
      console.error("❌ unhandledRejection:", e);
    });
    await db.initDB();
    await Promise.allSettled([this.connectScratch(), Promise.resolve(this.connectTurboWarp())]);
    this.scheduleWeeklyReset();

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost`);

      // 管理ページ HTML
      if (url.pathname === "/manage") {
        const html = fs.readFileSync(path.join(__dirname, "manage.html"), "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // 管理API
      if (url.pathname.startsWith("/api/")) {
        await handleManageAPI(req, res);
        return;
      }

      // ヘルスチェック
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status:    "ok",
        scratch:   !!this.scratch.conn ? "connected" : "disconnected",
        turbowarp: this.turbowarp.conn?.readyState === WebSocket.OPEN ? "connected" : "disconnected",
        queue:     this.queue.length,
        uptime:    process.uptime(),
      }));
    });
    server.listen(PORT, () => console.log(`🌐 ヘルスチェック: http://0.0.0.0:${PORT}`));
    setInterval(() => {
      const s = this.scratch.conn    ? "✅" : "❌";
      const t = this.turbowarp.conn?.readyState === WebSocket.OPEN ? "✅" : "❌";
      console.log(`💡 Health - Scratch:${s} TurboWarp:${t} Queue:${this.queue.length}`);
    }, 5 * 60 * 1000);
    const shutdown = () => {
      console.log("🛑 シャットダウン...");
      try { this.scratch.conn?.close();   } catch (_) {}
      try { this.turbowarp.conn?.close(); } catch (_) {}
      server.close();
      db.pool.end();
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT",  shutdown);
    console.log("🚀 サーバー起動完了");
  }
}

if (require.main === module) {
  new CloudManager().start().catch(e => { console.error("❌ 起動失敗:", e); process.exit(1); });
}

module.exports = { CloudManager };
