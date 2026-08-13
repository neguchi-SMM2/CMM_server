"use strict";
/**
 * DB層 - Supabase (PostgreSQL)
 * 環境変数: DATABASE_URL
 */

const { Pool } = require("pg");
const crypto   = require("crypto");
const bcrypt   = require("bcryptjs");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});

// ─────────────────────────────────────────────
// 初期化
// ─────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS courses (
      id            TEXT    PRIMARY KEY,
      title         TEXT    NOT NULL,
      author        TEXT    NOT NULL,
      username      TEXT    NOT NULL DEFAULT '',
      stage_data    TEXT    NOT NULL,
      posted_at     BIGINT  NOT NULL,
      play_count    INT     NOT NULL DEFAULT 0,
      attempt_count INT     NOT NULL DEFAULT 0,
      clear_count   INT     NOT NULL DEFAULT 0,
      like_count    INT     NOT NULL DEFAULT 0
    );
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS username TEXT NOT NULL DEFAULT '';
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS ip_address TEXT;

    CREATE TABLE IF NOT EXISTS likes (
      id         SERIAL  PRIMARY KEY,
      username   TEXT    NOT NULL,
      course_id  TEXT    NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      created_at BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE (username, course_id)
    );
    ALTER TABLE likes ADD COLUMN IF NOT EXISTS
      created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT;

    CREATE TABLE IF NOT EXISTS notifications (
      username   TEXT    PRIMARY KEY,
      cmd        INT     NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bans (
      username   TEXT    PRIMARY KEY,
      expires_at BIGINT  NOT NULL
    );

    CREATE TABLE IF NOT EXISTS official_makers (
      name       TEXT    PRIMARY KEY,
      added_at   BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id         SERIAL  PRIMARY KEY,
      title      TEXT    NOT NULL,
      body       TEXT    NOT NULL,
      created_at BIGINT  NOT NULL DEFAULT FLOOR(
        (EXTRACT(EPOCH FROM NOW()) - EXTRACT(EPOCH FROM TIMESTAMP '2000-01-01 00:00:00 UTC')) / 60
      )
    );

    CREATE TABLE IF NOT EXISTS maker_accounts (
      id            SERIAL  PRIMARY KEY,
      author        TEXT    NOT NULL,
      username      TEXT    NOT NULL,
      password_hash TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'pending',
      created_at    BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_maker_accounts_confirmed_author
      ON maker_accounts(author) WHERE status = 'confirmed';
    CREATE INDEX IF NOT EXISTS idx_maker_accounts_author ON maker_accounts(author);

    CREATE INDEX IF NOT EXISTS idx_courses_likes   ON courses(like_count DESC);
    CREATE INDEX IF NOT EXISTS idx_courses_posted  ON courses(posted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_courses_author  ON courses(author);
    CREATE INDEX IF NOT EXISTS idx_courses_title   ON courses(title);
    CREATE INDEX IF NOT EXISTS idx_likes_course    ON likes(course_id);
    CREATE INDEX IF NOT EXISTS idx_likes_created   ON likes(created_at DESC);
  `);
  console.log("✅ DB初期化完了");
}

// ─────────────────────────────────────────────
// コースID生成（a〜z, 0〜9の3文字×3ブロック）
// ─────────────────────────────────────────────
const COURSE_ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function generateCourseId() {
  const seg = () => Array.from(
    { length: 3 },
    () => COURSE_ID_CHARS[Math.floor(Math.random() * COURSE_ID_CHARS.length)]
  ).join("");
  return `${seg()}-${seg()}-${seg()}`;
}

// 2000年1月1日からの分数
function minutesSince2000() {
  const epoch2000 = Date.UTC(2000, 0, 1, 0, 0, 0);
  return Math.floor((Date.now() - epoch2000) / 60000);
}

// ─────────────────────────────────────────────
// 公式ユーザー
// ─────────────────────────────────────────────

/** 指定した名前(author)が公式ユーザーとして登録されているか（完全一致） */
async function isOfficialMaker(name) {
  const { rows } = await pool.query(
    "SELECT 1 FROM official_makers WHERE name=$1", [name]
  );
  return rows.length > 0;
}

/** 指定したusernameが、過去にそのauthor名で（_temp無しで）投稿したことがあるか */
async function hasPostedAsAuthor(author, username) {
  const { rows } = await pool.query(
    "SELECT 1 FROM courses WHERE author=$1 AND username=$2 LIMIT 1",
    [author, username]
  );
  return rows.length > 0;
}

// ─────────────────────────────────────────────
// コース保存
// ─────────────────────────────────────────────
async function saveCourse(title, author, username, stageData, ipAddress = null) {
  // 同一ステージデータの重複チェック
  const { rows: dupRows } = await pool.query(
    "SELECT 1 FROM courses WHERE stage_data=$1", [stageData]
  );
  if (dupRows.length) return { duplicate: true };

  // 作者名が公式ユーザー名と完全一致する場合、なりすまし防止のため "_temp" を付与
  // ただし、そのauthor名で過去に投稿実績がある(=本人とみなせる)usernameなら付与しない
  let safeAuthor = author;
  const official = await isOfficialMaker(author);
  if (official) {
    const alreadyPostedAsThis = await hasPostedAsAuthor(author, username);
    if (!alreadyPostedAsThis) {
      safeAuthor = `${author}_temp`;
    }
  }

  // コースID衝突回避（最大5回リトライ）
  let id = generateCourseId();
  for (let i = 0; i < 5; i++) {
    const { rows } = await pool.query("SELECT 1 FROM courses WHERE id=$1", [id]);
    if (!rows.length) break;
    id = generateCourseId();
  }
  const postedAt = minutesSince2000();
  await pool.query(
    `INSERT INTO courses (id, title, author, username, stage_data, posted_at, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, title, safeAuthor, username, stageData, postedAt, ipAddress || null]
  );
  return { id };
}

// ─────────────────────────────────────────────
// コース取得
// ─────────────────────────────────────────────
async function getCourseById(id) {
  const { rows } = await pool.query("SELECT * FROM courses WHERE id=$1", [id]);
  return rows[0] || null;
}

// ─────────────────────────────────────────────
// ランキング・検索
// ─────────────────────────────────────────────
const INFO_COLS = `id, title, author, like_count, play_count, attempt_count, clear_count, posted_at`;

async function getRandomCourses(limit) {
  const { rows } = await pool.query(
    `SELECT ${INFO_COLS} FROM courses ORDER BY posted_at + (RANDOM() * 2880) DESC LIMIT $1`, [limit]
  );
  return rows;
}

async function getWeeklyRanking(limit) {
  const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.author, c.like_count, c.play_count,
            c.attempt_count, c.clear_count, c.posted_at,
            COUNT(l.id) AS weekly_count
     FROM courses c
     LEFT JOIN likes l ON l.course_id = c.id AND l.created_at >= $1
     GROUP BY c.id
     ORDER BY weekly_count DESC, c.like_count DESC, c.play_count DESC
     LIMIT $2`,
    [since, limit]
  );
  return rows.map(r => ({ ...r, like_count: parseInt(r.weekly_count), total_like_count: parseInt(r.like_count) }));
}

async function getAllTimeRanking(limit) {
  const { rows } = await pool.query(
    `SELECT ${INFO_COLS} FROM courses ORDER BY like_count DESC, play_count DESC LIMIT $1`, [limit]
  );
  return rows;
}

async function searchByCourseId(courseId) {
  const { rows } = await pool.query(
    `SELECT ${INFO_COLS} FROM courses WHERE id=$1`, [courseId]
  );
  return rows;
}

async function searchByAuthor(author, limit) {
  const { rows } = await pool.query(
    `SELECT ${INFO_COLS} FROM courses WHERE author=$1 ORDER BY posted_at DESC LIMIT $2`,
    [author, limit]
  );
  return rows;
}

// CMD=15: 新着コース（posted_at 降順）
async function getNewArrivalCourses(limit) {
  const { rows } = await pool.query(
    `SELECT ${INFO_COLS} FROM courses ORDER BY posted_at DESC LIMIT $1`, [limit]
  );
  return rows;
}

// ─────────────────────────────────────────────
// 職人（メーカー）ランキング・情報
// ─────────────────────────────────────────────

// CMD=16: 職人ランキング（週間いいね数）
async function getMakerRankingWeek(limit) {
  const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const { rows } = await pool.query(
    `WITH course_agg AS (
       SELECT author,
              COALESCE(SUM(play_count), 0) AS play_count,
              MAX(posted_at)               AS latest_posted_at
       FROM courses
       GROUP BY author
     ),
     weekly_likes AS (
       SELECT c.author, COUNT(l.id) AS like_count
       FROM courses c
       LEFT JOIN likes l ON l.course_id = c.id AND l.created_at >= $1
       GROUP BY c.author
     )
     SELECT ca.author,
            COALESCE(wl.like_count, 0) AS like_count,
            ca.play_count,
            ca.latest_posted_at,
            EXISTS (
              SELECT 1 FROM official_makers om WHERE om.name = ca.author
            ) AS is_official
     FROM course_agg ca
     LEFT JOIN weekly_likes wl ON wl.author = ca.author
     ORDER BY like_count DESC, ca.play_count DESC
     LIMIT $2`,
    [since, limit]
  );
  return rows.map(r => ({
    author: r.author,
    like_count: parseInt(r.like_count, 10),
    play_count: parseInt(r.play_count, 10),
    latest_posted_at: parseInt(r.latest_posted_at, 10),
    is_official: r.is_official,
  }));
}

// CMD=17: 職人ランキング（累計いいね数）
async function getMakerRankingAllTime(limit) {
  const { rows } = await pool.query(
    `SELECT c.author,
            COALESCE(SUM(c.like_count), 0)    AS like_count,
            COALESCE(SUM(c.play_count), 0)    AS play_count,
            MAX(c.posted_at)                  AS latest_posted_at,
            EXISTS (
              SELECT 1 FROM official_makers om WHERE om.name = c.author
            )                                  AS is_official
     FROM courses c
     GROUP BY c.author
     ORDER BY like_count DESC, play_count DESC
     LIMIT $1`,
    [limit]
  );
  return rows.map(r => ({
    author: r.author,
    like_count: parseInt(r.like_count, 10),
    play_count: parseInt(r.play_count, 10),
    latest_posted_at: parseInt(r.latest_posted_at, 10),
    is_official: r.is_official,
  }));
}

// CMD=18: 職人情報（author指定）
async function getMakerInfo(author) {
  const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const { rows } = await pool.query(
    `WITH agg AS (
       SELECT author,
              COALESCE(SUM(like_count), 0) AS total_likes,
              COALESCE(SUM(play_count), 0) AS total_plays,
              COUNT(*)                     AS total_courses,
              MAX(posted_at)               AS latest_posted_at
       FROM courses
       GROUP BY author
     ),
     ranked AS (
       SELECT *,
              RANK() OVER (ORDER BY total_likes DESC, total_plays DESC) AS all_time_rank
       FROM agg
     ),
     weekly_agg AS (
       SELECT c.author, COUNT(l.id) AS weekly_likes
       FROM courses c
       LEFT JOIN likes l ON l.course_id = c.id AND l.created_at >= $2
       GROUP BY c.author
     ),
     weekly_ranked AS (
       SELECT *,
              RANK() OVER (ORDER BY weekly_likes DESC) AS weekly_rank
       FROM weekly_agg
     )
     SELECT r.author, r.total_likes, r.total_plays, r.total_courses,
            r.all_time_rank, r.latest_posted_at, wr.weekly_rank
     FROM ranked r
     JOIN weekly_ranked wr ON wr.author = r.author
     WHERE r.author = $1`,
    [author, since]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    author: r.author,
    total_likes: parseInt(r.total_likes, 10),
    total_plays: parseInt(r.total_plays, 10),
    total_courses: parseInt(r.total_courses, 10),
    all_time_rank: parseInt(r.all_time_rank, 10),
    weekly_rank: parseInt(r.weekly_rank, 10),
    latest_posted_at: parseInt(r.latest_posted_at, 10),
  };
}

// CMD=19: 公式職人一覧（ソートなし・登録順、CMD=16,17と同じフィールド構成）
async function getOfficialMakers(limit) {
  const { rows } = await pool.query(
    `SELECT om.name                              AS author,
            COALESCE(SUM(c.like_count), 0)        AS like_count,
            COALESCE(SUM(c.play_count), 0)        AS play_count,
            COALESCE(MAX(c.posted_at), 0)         AS latest_posted_at
     FROM official_makers om
     LEFT JOIN courses c ON c.author = om.name
     GROUP BY om.name, om.added_at
     ORDER BY om.added_at ASC
     LIMIT $1`,
    [limit]
  );
  return rows.map(r => ({
    author: r.author,
    like_count: parseInt(r.like_count, 10),
    play_count: parseInt(r.play_count, 10),
    latest_posted_at: parseInt(r.latest_posted_at, 10),
    is_official: true,
  }));
}

// CMD=91: 公式お知らせ（最新1件）
async function getLatestAnnouncement() {
  const { rows } = await pool.query(
    "SELECT title, body, created_at FROM announcements ORDER BY created_at DESC LIMIT 1"
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────
// 職人名アカウント（なりすまし対策: author名にパスワードを紐付ける）
// ─────────────────────────────────────────────

// 「事前投稿」判定基準日: 2026-08-13 00:00:00 (JST)
const CUTOFF_POSTED_AT = (() => {
  const epoch2000 = Date.UTC(2000, 0, 1, 0, 0, 0);
  const cutoffUtcMs = Date.UTC(2026, 7, 13, 0, 0, 0) - 9 * 60 * 60 * 1000; // JST→UTC
  return Math.floor((cutoffUtcMs - epoch2000) / 60000);
})();

/** authorが既に本登録済みか */
async function isAuthorConfirmed(author) {
  const { rows } = await pool.query(
    "SELECT 1 FROM maker_accounts WHERE author=$1 AND status='confirmed'", [author]
  );
  return rows.length > 0;
}

/** authorが基準日より前に投稿されたコースで使われているか */
async function isAuthorUsedBeforeCutoff(author) {
  const { rows } = await pool.query(
    "SELECT 1 FROM courses WHERE author=$1 AND posted_at < $2 LIMIT 1",
    [author, CUTOFF_POSTED_AT]
  );
  return rows.length > 0;
}

/** そのusernameが基準日より前に、そのauthor名で投稿していたか */
async function hasUsernameUsedAuthorBeforeCutoff(author, username) {
  const { rows } = await pool.query(
    "SELECT 1 FROM courses WHERE author=$1 AND username=$2 AND posted_at < $3 LIMIT 1",
    [author, username, CUTOFF_POSTED_AT]
  );
  return rows.length > 0;
}

/** authorの登録状態: 'confirmed' | 'pending' | null */
async function getMakerStatus(author) {
  const { rows } = await pool.query(
    `SELECT status FROM maker_accounts WHERE author=$1
     ORDER BY (status='confirmed') DESC, created_at DESC LIMIT 1`,
    [author]
  );
  return rows[0]?.status || null;
}

/** 本登録: パスワードをハッシュ化して保存し、同名authorの仮登録は自動で削除(却下)する */
async function registerMakerConfirmed(author, username, password) {
  const passwordHash = await bcrypt.hash(password, 10);
  await pool.query(
    "INSERT INTO maker_accounts (author, username, password_hash, status) VALUES ($1,$2,$3,'confirmed')",
    [author, username, passwordHash]
  );
  await pool.query(
    "DELETE FROM maker_accounts WHERE author=$1 AND status='pending'", [author]
  );
}

/** 仮登録: 審査待ちとして保存する */
async function registerMakerPending(author, username, password) {
  const passwordHash = await bcrypt.hash(password, 10);
  await pool.query(
    "INSERT INTO maker_accounts (author, username, password_hash, status) VALUES ($1,$2,$3,'pending')",
    [author, username, passwordHash]
  );
}

/** 本登録済みauthorのパスワード照合 */
async function verifyMakerPassword(author, password) {
  const { rows } = await pool.query(
    "SELECT password_hash FROM maker_accounts WHERE author=$1 AND status='confirmed'", [author]
  );
  if (!rows.length) return false;
  return bcrypt.compare(password, rows[0].password_hash);
}

/** そのusernameが本日中(JST)に既に職人登録(仮登録含む)を行ったか */
async function hasRegisteredToday(username) {
  const now = new Date();
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = jstNow.getUTCFullYear(), mo = jstNow.getUTCMonth(), d = jstNow.getUTCDate();
  const startOfDayJstMs = Date.UTC(y, mo, d, 0, 0, 0) - 9 * 60 * 60 * 1000;
  const startOfDaySec = Math.floor(startOfDayJstMs / 1000);
  const { rows } = await pool.query(
    "SELECT 1 FROM maker_accounts WHERE username=$1 AND created_at >= $2 LIMIT 1",
    [username, startOfDaySec]
  );
  return rows.length > 0;
}

// ── 管理サイト用 ──

/** 仮登録一覧（審査待ち）。そのusernameの過去投稿実績・最新タイトルも付与する */
async function listPendingMakers() {
  const { rows } = await pool.query(
    "SELECT id, author, username, created_at FROM maker_accounts WHERE status='pending' ORDER BY created_at ASC"
  );
  const enriched = await Promise.all(rows.map(async r => {
    const { rows: courseRows } = await pool.query(
      "SELECT title FROM courses WHERE author=$1 AND username=$2 ORDER BY posted_at DESC LIMIT 1",
      [r.author, r.username]
    );
    return {
      ...r,
      hasPosted: courseRows.length > 0,
      latestTitle: courseRows.length > 0 ? courseRows[0].title : null,
    };
  }));
  return enriched;
}

/** 仮登録を承認: 本登録に切り替え、同名authorの他の仮登録は自動で削除(却下)する */
async function approvePendingMaker(id) {
  const { rows } = await pool.query(
    "SELECT author FROM maker_accounts WHERE id=$1 AND status='pending'", [id]
  );
  if (!rows.length) return false;
  const author = rows[0].author;
  try {
    await pool.query("UPDATE maker_accounts SET status='confirmed' WHERE id=$1", [id]);
  } catch (e) {
    // 既に別の申請が先に本登録済み(ユニーク制約違反)などの場合
    return false;
  }
  await pool.query(
    "DELETE FROM maker_accounts WHERE author=$1 AND status='pending' AND id<>$2", [author, id]
  );
  return true;
}

/** 仮登録を却下: 該当行を削除する */
async function rejectPendingMaker(id) {
  const { rowCount } = await pool.query(
    "DELETE FROM maker_accounts WHERE id=$1 AND status='pending'", [id]
  );
  return rowCount > 0;
}

/**
 * 登録後30日以内に1コースも投稿されなかった本登録職人を削除する。
 * ただし、その職人名で(いつでも)コースを投稿したことがある場合は対象外。
 */
async function cleanupInactiveMakers() {
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
  const { rows } = await pool.query(
    `DELETE FROM maker_accounts
     WHERE status = 'confirmed'
       AND created_at <= $1
       AND author NOT IN (SELECT DISTINCT author FROM courses)
     RETURNING author`,
    [cutoff]
  );
  return rows.map(r => r.author);
}

// ─────────────────────────────────────────────
// 統計更新
// ─────────────────────────────────────────────
async function incrementPlay(courseId) {
  await pool.query(
    "UPDATE courses SET play_count=play_count+1 WHERE id=$1", [courseId]
  );
}

async function incrementAttempt(courseId) {
  await pool.query(
    "UPDATE courses SET attempt_count=attempt_count+1 WHERE id=$1", [courseId]
  );
}

async function incrementClear(courseId) {
  await pool.query(
    "UPDATE courses SET clear_count=clear_count+1 WHERE id=$1", [courseId]
  );
}

const LIKES_MAX = 50000;

async function addLike(username, courseId) {
  const { rows } = await pool.query(
    "SELECT 1 FROM likes WHERE username=$1 AND course_id=$2", [username, courseId]
  );
  if (rows.length) return { alreadyLiked: true };

  const now = Math.floor(Date.now() / 1000);
  await pool.query(
    "INSERT INTO likes (username, course_id, created_at) VALUES ($1,$2,$3)",
    [username, courseId, now]
  );
  await pool.query(
    "UPDATE courses SET like_count=like_count+1 WHERE id=$1", [courseId]
  );

  const { rows: countRows } = await pool.query("SELECT COUNT(*) FROM likes");
  const count = parseInt(countRows[0].count, 10);
  if (count > LIKES_MAX) {
    const excess = count - LIKES_MAX;
    await pool.query(
      `DELETE FROM likes WHERE id IN (
         SELECT id FROM likes ORDER BY id ASC LIMIT $1
       )`, [excess]
    );
    console.log(`🗑️ 古いいいねを ${excess} 件削除しました`);
  }

  return { alreadyLiked: false };
}

async function deleteOldLikes() {
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const { rowCount } = await pool.query(
    "DELETE FROM likes WHERE created_at < $1", [cutoff]
  );
  if (rowCount > 0) console.log(`🗑️ 古いいいねを ${rowCount} 件削除しました`);
}

/** 指定usernameが、直近sinceSeconds秒以内に同一author名のコースへ何件いいねしたか */
async function countRecentLikesForAuthor(username, author, sinceTimestamp) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FROM likes l
     JOIN courses c ON c.id = l.course_id
     WHERE l.username = $1 AND c.author = $2 AND l.created_at >= $3`,
    [username, author, sinceTimestamp]
  );
  return parseInt(rows[0].count, 10);
}

async function resetWeeklyLikes() {
  await deleteOldLikes();
}

// ─────────────────────────────────────────────
// 通知
// ─────────────────────────────────────────────
async function upsertNotification(username, cmd) {
  await pool.query(
    `INSERT INTO notifications (username, cmd) VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET cmd = EXCLUDED.cmd`,
    [username, cmd]
  );
}

async function getAndDeleteNotification(username) {
  const { rows } = await pool.query(
    "DELETE FROM notifications WHERE username=$1 RETURNING cmd", [username]
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────
// BAN
// ─────────────────────────────────────────────
async function banUser(username, expiresAt) {
  // usernameをBAN
  await pool.query(
    `INSERT INTO bans (username, expires_at) VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
    [username, expiresAt]
  );
  // そのユーザーが過去に投稿したコースのIPアドレスも全てBAN
  const { rows: ipRows } = await pool.query(
    "SELECT DISTINCT ip_address FROM courses WHERE username=$1 AND ip_address IS NOT NULL",
    [username]
  );
  for (const { ip_address } of ipRows) {
    await pool.query(
      `INSERT INTO bans (username, expires_at) VALUES ($1, $2)
       ON CONFLICT (username) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [ip_address, expiresAt]
    );
  }
}

async function isUserBanned(username, ipAddress = null) {
  const now = Math.floor(Date.now() / 1000);
  // usernameチェック
  const { rows } = await pool.query(
    "SELECT 1 FROM bans WHERE username=$1 AND expires_at > $2", [username, now]
  );
  if (rows.length > 0) return true;
  // IPアドレスチェック
  if (ipAddress) {
    const { rows: ipRows } = await pool.query(
      "SELECT 1 FROM bans WHERE username=$1 AND expires_at > $2", [ipAddress, now]
    );
    if (ipRows.length > 0) return true;
  }
  return false;
}

async function deleteCourse(courseId) {
  const { rows } = await pool.query(
    "DELETE FROM courses WHERE id=$1 RETURNING username", [courseId]
  );
  return rows[0] || null; // { username } or null
}

async function getStats() {
  // posted_atは2000年1月1日からの分数なので7日分は60*24*7=10080分
  const weekAgo = minutesSince2000() - 10080;
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)                                          AS total_courses,
      COALESCE(SUM(play_count), 0)                      AS total_plays,
      COALESCE(SUM(like_count), 0)                      AS total_likes,
      COALESCE(SUM(clear_count), 0)                     AS total_clears,
      COALESCE(SUM(attempt_count), 0)                   AS total_attempts,
      COUNT(*) FILTER (WHERE posted_at >= $1)           AS weekly_courses,
      (SELECT id FROM courses ORDER BY posted_at DESC LIMIT 1) AS latest_course_id
    FROM courses
  `, [weekAgo]);
  return rows[0];
}

module.exports = {
  initDB, pool,
  saveCourse, getCourseById,
  getRandomCourses, getWeeklyRanking, getAllTimeRanking,
  searchByCourseId, searchByAuthor, getNewArrivalCourses,
  incrementPlay, incrementAttempt, incrementClear, addLike,
  resetWeeklyLikes, deleteOldLikes, minutesSince2000, countRecentLikesForAuthor,
  upsertNotification, getAndDeleteNotification,
  banUser, isUserBanned, deleteCourse, getStats,
  isOfficialMaker, hasPostedAsAuthor,
  getMakerRankingWeek, getMakerRankingAllTime, getMakerInfo, getOfficialMakers,
  getLatestAnnouncement,
  isAuthorConfirmed, isAuthorUsedBeforeCutoff, hasUsernameUsedAuthorBeforeCutoff,
  getMakerStatus, registerMakerConfirmed, registerMakerPending, verifyMakerPassword, hasRegisteredToday,
  listPendingMakers, approvePendingMaker, rejectPendingMaker, cleanupInactiveMakers,
};
