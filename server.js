"use strict";
/**
 * マリオメーカー風ゲーム クラウド変数サーバー v3
 * =====================================================
 * 環境変数:
 *   SCRATCH_USERNAME    Scratch ユーザー名
 *   SCRATCH_PASSWORD    Scratch パスワード
 *   SCRATCH_PROJECT_ID  プロジェクトID
 *   DATABASE_URL        Supabase 接続文字列
 *   PORT                ヘルスチェック用ポート (default: 3000)
 */

const WebSocket = require("ws");
const http      = require("http");
const { Session, Cloud } = require("scratchcloud");

const db = require("./database");
const {
  encodeNum, decodeNum,
  encodeLen, decodeLen,
  encodeLenLen, decodeLenLen,
  encodeAlphabet, decodeAlphabet,
  encodeText, decodeText,
} = require("./encode");

const USERNAME   = process.env.SCRATCH_USERNAME;
const PASSWORD   = process.env.SCRATCH_PASSWORD;
const PROJECT_ID = parseInt(process.env.SCRATCH_PROJECT_ID, 10);
const PORT       = parseInt(process.env.PORT || "3000", 10);

// クラウド変数名
const REQUEST_VARS = ["☁ request1", "☁ request2"];
const CLOUD_VARS   = [
  "☁ cloud1","☁ cloud2","☁ cloud3","☁ cloud4",
  "☁ cloud5","☁ cloud6","☁ cloud7","☁ cloud8",
];

// コマンドコード
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
};

// 送信間隔（Scratch レート制限対策）
const SEND_INTERVAL = 120; // ms

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ランダムなcloud変数を選ぶ
function randomCloud() {
  return CLOUD_VARS[Math.floor(Math.random() * CLOUD_VARS.length)];
}

// ─────────────────────────────────────────────
// リクエスト解析
// ─────────────────────────────────────────────

/**
 * ユーザーIDを先頭から読む（LenLen式）
 * @returns {{ userId: string, next: number }}
 */
function parseUserId(s, pos = 0) {
  const { value, next } = decodeLenLen(s, pos);
  return { userId: String(value), next };
}

/**
 * コマンドコードを読む（Len式）
 */
function parseCmd(s, pos) {
  const { value, next } = decodeLen(s, pos);
  return { cmd: value, next };
}

// ─────────────────────────────────────────────
// レスポンス送信
// ─────────────────────────────────────────────

/**
 * cloud変数に値をセットする（setter経由）
 */
async function sendCloud(setter, name, value) {
  await setter(name, String(value));
  await sleep(SEND_INTERVAL);
}

/**
 * コース情報1件をエンコードして返す
 */
function encodeCourseInfo(row, index) {
  const clearRate = row.attempt_count > 0
    ? Math.round(row.clear_count / row.attempt_count * 10000) / 100
    : 0;
  const clearRateEncoded = Math.round(clearRate * 100);

  return encodeNum(index)
    + encodeNum(row.like_count)
    + encodeNum(row.play_count)
    + encodeNum(clearRateEncoded)
    + encodeText(row.title)
    + encodeAlphabet(row.id)
    + encodeAlphabet(row.author)
    + encodeNum(row.posted_at);
}

/**
 * コース一覧をcloud1〜8に分割して送信（1000文字制限）
 */
async function sendCourseList(setter, userId, cmd, rows) {
  const header = encodeLenLen(parseInt(userId)) + encodeLen(cmd);
  const maxLen = 1000;

  let buffer = "";
  let courseIndex = 1;

  for (const row of rows) {
    const courseEncoded = encodeCourseInfo(row, courseIndex);
    // バッファ + ヘッダ + このコースで1000文字を超えるなら送信
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

/**
 * コースデータ（生データ）を分割して送信
 */
async function sendCourseData(setter, userId, stageData) {
  const headerBase = encodeLenLen(parseInt(userId)) + encodeLen(CMD.GET_COURSE);
  const maxLen = 1000;
  // オーバーヘッド: headerBase + 分割回数(最大2桁Len式) + 何番目(最大2桁Len式)
  const overhead = headerBase.length + 2 + 2;
  const chunkSize = maxLen - overhead;

  const totalChunks = Math.ceil(stageData.length / chunkSize);
  const totalEnc = encodeLen(totalChunks);
  for (let i = 0; i < totalChunks; i++) {
    const seq = i + 1;
    const chunk = stageData.slice(i * chunkSize, (i + 1) * chunkSize);
    await sendCloud(setter, randomCloud(), headerBase + totalEnc + encodeLen(seq) + chunk);
  }
  // 終了合図（何番目=0）
  await sendCloud(setter, randomCloud(), headerBase + totalEnc + encodeLen(0));
}

// ─────────────────────────────────────────────
// コマンドハンドラ
// ─────────────────────────────────────────────

// デコード結果のバリデーションヘルパー
function isValidNum(value) {
  return typeof value === "number" && !isNaN(value) && isFinite(value);
}
function isValidStr(value) {
  return typeof value === "string" && value.length > 0;
}

async function handleRequest(s, setter) {
  let pos = 0;

  // ユーザーID
  const { userId, next: p1 } = parseUserId(s, pos);
  pos = p1;
  if (!userId || isNaN(parseInt(userId))) {
    console.warn("⚠️ 不正なユーザーID:", userId);
    return;
  }

  // コマンドコード
  const { cmd, next: p2 } = parseCmd(s, pos);
  pos = p2;
  if (!isValidNum(cmd)) {
    console.warn("⚠️ 不正なコマンドコード:", cmd);
    return;
  }

  // ─── CMD=1: コース投稿 ───
  // コース投稿はcloud1〜8経由で別途受信するのでここでは処理しない
  // （handleUploadChunkで処理）

  // ─── CMD=10〜14: コース取得 ───
  if (cmd === CMD.RANDOM || cmd === CMD.WEEKLY || cmd === CMD.ALL_TIME) {
    const { value: limit } = decodeLen(s, pos);
    if (!isValidNum(limit) || limit <= 0) {
      console.warn("⚠️ 不正なlimit:", limit);
      return;
    }
    let rows;
    if      (cmd === CMD.RANDOM)    rows = await db.getRandomCourses(limit);
    else if (cmd === CMD.WEEKLY)    rows = await db.getWeeklyRanking(limit);
    else                            rows = await db.getAllTimeRanking(limit);
    await sendCourseList(setter, userId, cmd, rows);
    return;
  }

  if (cmd === CMD.SEARCH_ID) {
    const { value: courseId } = decodeAlphabet(s, pos);
    if (!isValidStr(courseId)) {
      console.warn("⚠️ 不正なcourseId:", courseId);
      return;
    }
    const rows = await db.searchByCourseId(courseId);
    await sendCourseList(setter, userId, cmd, rows);
    return;
  }

  if (cmd === CMD.SEARCH_AUTHOR) {
    const { value: author, next: p3 } = decodeAlphabet(s, pos);
    pos = p3;
    if (!isValidStr(author)) {
      console.warn("⚠️ 不正なauthor:", author);
      return;
    }
    const { value: limit } = decodeLen(s, pos);
    if (!isValidNum(limit) || limit <= 0) {
      console.warn("⚠️ 不正なlimit:", limit);
      return;
    }
    const rows = await db.searchByAuthor(author, limit);
    await sendCourseList(setter, userId, cmd, rows);
    return;
  }

  // ─── CMD=20〜23: 統計更新 ───
  if (cmd === CMD.LIKE || cmd === CMD.PLAY || cmd === CMD.ATTEMPT || cmd === CMD.CLEAR) {
    const { value: username, next: p3 } = decodeAlphabet(s, pos);
    pos = p3;
    const { value: courseId } = decodeAlphabet(s, pos);

    if (!isValidStr(username) || !isValidStr(courseId)) {
      console.warn("⚠️ 不正なusername/courseId:", username, courseId);
      return;
    }

    if (cmd === CMD.PLAY)    { await db.incrementPlay(courseId);    return; }
    if (cmd === CMD.ATTEMPT) { await db.incrementAttempt(courseId); return; }
    if (cmd === CMD.CLEAR)   { await db.incrementClear(courseId);   return; }

    if (cmd === CMD.LIKE) {
      const { alreadyLiked } = await db.addLike(userId, courseId);
      if (alreadyLiked) {
        // いいね済み通知
        const res = encodeLenLen(parseInt(userId)) + encodeLen(200);
        await sendCloud(setter, randomCloud(), res);
      } else {
        // いいね成功通知
        const res = encodeLenLen(parseInt(userId)) + encodeLen(201);
        await sendCloud(setter, randomCloud(), res);
      }
      return;
    }
  }

  // ─── CMD=30: コースデータ取得 ───
  if (cmd === CMD.GET_COURSE) {
    const { value: courseId } = decodeAlphabet(s, pos);
    if (!isValidStr(courseId)) {
      console.warn("⚠️ 不正なcourseId:", courseId);
      return;
    }
    const row = await db.getCourseById(courseId);
    if (!row) return;
    await sendCourseData(setter, userId, row.stage_data);
    return;
  }

  console.warn("⚠️ 未知のコマンドコード:", cmd);
}

// ─────────────────────────────────────────────
// コース投稿バッファ管理
// ─────────────────────────────────────────────
// Map<userId, { totalChunks, chunks: Map<seq, data>, timer, title?, author? }>
const uploadBuffers = new Map();
const UPLOAD_TIMEOUT = 60 * 1000; // 1分タイムアウト

async function handleUploadChunk(s, setter) {
  let pos = 0;

  // ユーザーID
  const { userId, next: p1 } = parseUserId(s, pos);
  pos = p1;

  // CMD=1確認
  const { cmd, next: p2 } = parseCmd(s, pos);
  pos = p2;
  if (cmd !== CMD.UPLOAD) return;

  // 分割回数（Len式）
  const { value: totalChunks, next: p3 } = decodeLen(s, pos);
  pos = p3;

  // 何番目か（Len式）
  const { value: seq, next: p4 } = decodeLen(s, pos);
  pos = p4;

  // バッファを取得または作成
  if (!uploadBuffers.has(userId)) {
    const timer = setTimeout(() => uploadBuffers.delete(userId), UPLOAD_TIMEOUT);
    uploadBuffers.set(userId, { totalChunks, chunks: new Map(), timer });
  }
  const buf = uploadBuffers.get(userId);
  buf.totalChunks = totalChunks;

  if (seq === 0) {
    // 最終チャンク: タイトル(text) + 作者名(alphabet)
    const { value: title, next: p5 } = decodeText(s, pos);
    pos = p5;
    const { value: author } = decodeAlphabet(s, pos);
    buf.title  = title;
    buf.author = author;

    // チャンクが全部揃っているか確認
    let allPresent = true;
    for (let i = 1; i <= buf.totalChunks; i++) {
      if (!buf.chunks.has(i)) { allPresent = false; break; }
    }

    clearTimeout(buf.timer);
    uploadBuffers.delete(userId);

    if (allPresent) {
      // チャンクを結合
      let stageData = "";
      for (let i = 1; i <= totalChunks; i++) stageData += buf.chunks.get(i);

      try {
        const result = await db.saveCourse(buf.title, buf.author, stageData);
        if (result.duplicate) {
          // 重複コース通知（102）
          const res = encodeLenLen(parseInt(userId)) + encodeLen(102);
          await sendCloud(setter, randomCloud(), res);
        } else {
          // 投稿成功通知（ユーザーID + 100 + コースID）
          const res = encodeLenLen(parseInt(userId)) + encodeLen(100) + encodeAlphabet(result.id);
          await sendCloud(setter, randomCloud(), res);
        }
      } catch (e) {
        console.error("コース保存失敗:", e.message);
        // 投稿失敗通知
        const res = encodeLenLen(parseInt(userId)) + encodeLen(101);
        await sendCloud(setter, randomCloud(), res);
      }
    } else {
      // チャンク不足 → 失敗通知
      const res = encodeLenLen(parseInt(userId)) + encodeLen(101);
      await sendCloud(setter, randomCloud(), res);
    }
  } else {
    // データチャンクを保存（残り全部がステージデータ）
    const chunkData = s.slice(pos);
    buf.chunks.set(seq, chunkData);
  }
}

// ─────────────────────────────────────────────
// メッセージ振り分け
// ─────────────────────────────────────────────

async function onMessage(name, value, setter) {
  const s = String(value);
  if (!s || s.length < 3) return;

  try {
    // CMDを先読み（ユーザーIDのサイズを読んでからCMDを取得）
    const { next: p1 } = parseUserId(s, 0);
    const { cmd }      = parseCmd(s, p1);

    if (cmd === CMD.UPLOAD) {
      // cloud1〜8 経由のコース投稿
      await handleUploadChunk(s, setter);
    } else if (REQUEST_VARS.includes(name)) {
      // request1/2 経由のその他コマンド
      await handleRequest(s, setter);
    }
  } catch (e) {
    console.error(`❌ メッセージ処理エラー (${name}):`, e.message);
  }
}

// ─────────────────────────────────────────────
// Scratch / TurboWarp 接続管理
// ─────────────────────────────────────────────
class CloudManager {
  constructor() {
    this.scratch   = { conn: null, isReconnecting: false, delay: 5000 };
    this.turbowarp = { conn: null, isReconnecting: false, delay: 2000 };
    this.queue     = [];
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

  // ── Scratch 接続 ──
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

      const setter = (name, value) => {
        cloud.set(name, String(value));
        return Promise.resolve();
      };

      // 起動時にすべてのクラウド変数を0で初期化
      console.log("🔄 クラウド変数を初期化中...");
      for (const v of [...REQUEST_VARS, ...CLOUD_VARS]) {
        await setter(v, "0");
        await sleep(SEND_INTERVAL);
      }
      console.log("✅ クラウド変数初期化完了");

      // cloud1〜8 と request1〜2 を監視
      cloud.on("set", (name, value) => {
        const fullName = name.startsWith("☁ ") ? name : `☁ ${name}`;
        const allVars  = [...REQUEST_VARS, ...CLOUD_VARS];
        if (allVars.includes(fullName)) {
          this.enqueue(fullName, value, setter);
        }
      });

      cloud.on("close", () => {
        console.warn("⚠️ Scratch 切断");
        this.scratch.conn = null;
        this.scheduleReconnect("scratch");
      });
      cloud.on("error", e => {
        console.error("❌ Scratch エラー:", e.message);
        this.scratch.conn = null;
        this.scheduleReconnect("scratch");
      });
    } catch (e) {
      console.error("❌ Scratch 接続失敗:", e.message);
      this.scratch.conn = null;
      this.scheduleReconnect("scratch");
    } finally {
      this.scratch.isReconnecting = false;
    }
  }

  // ── TurboWarp 接続 ──
  connectTurboWarp() {
    if (this.turbowarp.conn?.readyState === WebSocket.OPEN ||
        this.turbowarp.isReconnecting) return;
    this.turbowarp.isReconnecting = true;

    try {
      const ws = new WebSocket("wss://clouddata.turbowarp.org", {
        headers: { "User-Agent": "MarioMakerServer/1.0" }
      });

      const setter = (name, value) => {
        if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("TW切断"));
        ws.send(JSON.stringify({
          method: "set", name, value: String(value),
          user: "server-bot", project_id: PROJECT_ID
        }));
        return Promise.resolve();
      };

      ws.on("open", async () => {
        ws.send(JSON.stringify({
          method: "handshake", user: "server-bot", project_id: PROJECT_ID
        }));
        this.turbowarp.conn  = ws;
        this.turbowarp.delay = 2000;
        this.turbowarp.isReconnecting = false;
        console.log("✅ TurboWarp Cloud 接続成功");

        // 起動時にすべてのクラウド変数を0で初期化
        console.log("🔄 TurboWarp クラウド変数を初期化中...");
        for (const v of [...REQUEST_VARS, ...CLOUD_VARS]) {
          await setter(v, "0");
          await sleep(SEND_INTERVAL);
        }
        console.log("✅ TurboWarp クラウド変数初期化完了");
      });

      ws.on("message", raw => {
        try {
          const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
          for (const line of text.trim().split("\n")) {
            if (!line) continue;
            const data = JSON.parse(line);
            if (data.method === "set") {
              const allVars = [...REQUEST_VARS, ...CLOUD_VARS];
              if (allVars.includes(data.name)) {
                this.enqueue(data.name, data.value, setter);
              }
            }
          }
        } catch (e) {
          console.warn("⚠️ TW メッセージ解析失敗:", e.message);
        }
      });

      ws.on("close", () => {
        console.warn("⚠️ TurboWarp 切断");
        this.turbowarp.conn = null;
        this.turbowarp.isReconnecting = false;
        this.scheduleReconnect("turbowarp");
      });
      ws.on("error", e => {
        console.error("❌ TurboWarp エラー:", e.message);
        this.turbowarp.conn = null;
        this.turbowarp.isReconnecting = false;
        this.scheduleReconnect("turbowarp");
      });
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
    setTimeout(() => {
      if (mode === "scratch") this.connectScratch();
      else                    this.connectTurboWarp();
    }, delay);
  }

  // ── 週間いいねリセット（毎週月曜）──
  scheduleWeeklyReset() {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(0, 0, 0, 0);
    const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
    next.setDate(next.getDate() + daysUntilMonday);
    const ms = next - now;
    console.log(`📅 週間リセット予定: ${next.toLocaleString("ja-JP")}`);
    setTimeout(async () => {
      await db.resetWeeklyLikes().catch(e => console.error("週間リセット失敗:", e));
      this.scheduleWeeklyReset();
    }, ms);
  }

  async start() {
    process.on("uncaughtException",  e => console.error("❌ uncaughtException:", e));
    process.on("unhandledRejection", e => console.error("❌ unhandledRejection:", e));

    await db.initDB();

    await Promise.allSettled([
      this.connectScratch(),
      Promise.resolve(this.connectTurboWarp()),
    ]);

    this.scheduleWeeklyReset();

    // ヘルスチェック用HTTPサーバー
    const server = http.createServer((req, res) => {
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
  new CloudManager().start().catch(e => {
    console.error("❌ 起動失敗:", e);
    process.exit(1);
  });
}

module.exports = { CloudManager };
