"use strict";
/**
 * DB層 - Supabase (PostgreSQL)
 * 環境変数: DATABASE_URL
 */

const { Pool } = require("pg");
const crypto   = require("crypto");
const bcrypt   = require("bcryptjs");
const zlib     = require("zlib");

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
    ALTER TABLE courses ADD COLUMN IF NOT EXISTS red INT NOT NULL DEFAULT 0;

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

    CREATE TABLE IF NOT EXISTS chat_sessions (
      token      TEXT    PRIMARY KEY,
      author     TEXT    NOT NULL,
      created_at BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_author ON chat_sessions(author);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id         SERIAL  PRIMARY KEY,
      author     TEXT    NOT NULL,
      body       BYTEA   NOT NULL,
      created_at BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at DESC);

    CREATE TABLE IF NOT EXISTS chat_dm (
      id          SERIAL  PRIMARY KEY,
      from_author TEXT    NOT NULL,
      to_author   TEXT    NOT NULL,
      body        BYTEA   NOT NULL,
      created_at  BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_dm_from ON chat_dm(from_author, to_author, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_dm_to   ON chat_dm(to_author, from_author, created_at DESC);

    CREATE TABLE IF NOT EXISTS chat_bans (
      author     TEXT    PRIMARY KEY,
      expires_at BIGINT  NOT NULL,
      reason     TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_reports (
      id            SERIAL  PRIMARY KEY,
      reporter      TEXT    NOT NULL,
      target_author TEXT    NOT NULL,
      reason        TEXT    NOT NULL,
      created_at    BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      resolved      BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_reports_resolved ON chat_reports(resolved, created_at DESC);

    CREATE TABLE IF NOT EXISTS chat_blocks (
      blocker    TEXT    NOT NULL,
      blocked    TEXT    NOT NULL,
      created_at BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      PRIMARY KEY (blocker, blocked)
    );

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

async function isOfficialMaker(name) {
  const { rows } = await pool.query(
    "SELECT 1 FROM official_makers WHERE name=$1", [name]
  );
  return rows.length > 0;
}

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
  const { rows: dupRows } = await pool.query(
    "SELECT 1 FROM courses WHERE stage_data=$1", [stageData]
  );
  if (dupRows.length) return { duplicate: true };

  let safeAuthor = author;
  const official = await isOfficialMaker(author);
  if (official) {
    const alreadyPostedAsThis = await hasPostedAsAuthor(author, username);
    if (!alreadyPostedAsThis) {
      safeAuthor = `${author}_temp`;
    }
  }

  const postedAt = minutesSince2000();

  const { rows: lastRows } = await pool.query(
    "SELECT posted_at FROM courses WHERE author=$1 ORDER BY posted_at DESC LIMIT 1",
    [safeAuthor]
  );
  if (lastRows.length && (postedAt - lastRows[0].posted_at) < 10) {
    return { tooSoon: true };
  }

  let id = generateCourseId();
  for (let i = 0; i < 5; i++) {
    const { rows } = await pool.query("SELECT 1 FROM courses WHERE id=$1", [id]);
    if (!rows.length) break;
    id = generateCourseId();
  }

  // このコースが何番目の投稿になるか（累計コース数+1）を求め、500の倍数ならred=1
  const { rows: countRows } = await pool.query("SELECT COUNT(*) FROM courses");
  const courseNumber = parseInt(countRows[0].count, 10) + 1;
  const red = courseNumber % 500 === 0 ? 1 : 0;

  await pool.query(
    `INSERT INTO courses (id, title, author, username, stage_data, posted_at, ip_address, red)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, title, safeAuthor, username, stageData, postedAt, ipAddress || null, red]
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
const INFO_COLS = `id, title, author, like_count, play_count, attempt_count, clear_count, posted_at, red`;

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
            c.attempt_count, c.clear_count, c.posted_at, c.red,
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

async function getNewArrivalCourses(limit) {
  const { rows } = await pool.query(
    `SELECT ${INFO_COLS} FROM courses ORDER BY posted_at DESC LIMIT $1`, [limit]
  );
  return rows;
}

// ─────────────────────────────────────────────
// 職人（メーカー）ランキング・情報
// ─────────────────────────────────────────────

// 職人ポイント計算のパラメータ
const MAKER_POINT_LIKE_WEIGHT = 65;
const MAKER_POINT_PLAY_WEIGHT = 6.5;
const MAKER_POINT_EXPONENT    = 0.3;

/**
 * 職人ポイント計算（全期間）
 * (総いいね数 × 65 + 総プレイ数 × 6.5) / (投稿数 + 1)^0.3
 */
function calcMakerPointAllTime(totalLikes, totalPlays, courseCount) {
  if (courseCount === 0) return 0;
  const base  = totalLikes * MAKER_POINT_LIKE_WEIGHT + totalPlays * MAKER_POINT_PLAY_WEIGHT;
  const bonus = Math.pow(courseCount + 1, MAKER_POINT_EXPONENT);
  return base / bonus;
}

/**
 * 職人ポイント計算（週間）
 * (週間いいね数 × 65 + 週間投稿コースのプレイ数合計 × 6.5) ÷ (週間投稿数 + 1)^0.3
 * ただし全期間ポイントを超えない
 */
function calcMakerPointWeekly(weeklyLikes, weeklyPlays, weeklyCourseCount, allTimePoint) {
  if (weeklyCourseCount === 0) return 0;
  const base  = weeklyLikes * MAKER_POINT_LIKE_WEIGHT + weeklyPlays * MAKER_POINT_PLAY_WEIGHT;
  const bonus = Math.pow(weeklyCourseCount + 1, MAKER_POINT_EXPONENT);
  const raw = base / bonus;
  return Math.min(raw, allTimePoint);
}

// CMD=16: 職人ランキング（週間）
// パフォーマンス改善: N+1クエリを排除し、official_makersを1回だけ取得してSetで判定する
async function getMakerRankingWeek(limit) {
  const since = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const sinceMinutes = minutesSince2000() - 7 * 24 * 60;

  const [allTimeResult, weeklyLikeResult, weeklyCourseResult, officialResult] = await Promise.all([
    pool.query(
      `SELECT author,
              COALESCE(SUM(like_count), 0) AS total_likes,
              COALESCE(SUM(play_count), 0) AS total_plays,
              COUNT(*)                     AS total_courses,
              MAX(posted_at)               AS latest_posted_at
       FROM courses
       GROUP BY author`
    ),
    pool.query(
      `SELECT c.author, COUNT(l.id) AS weekly_likes
       FROM courses c
       JOIN likes l ON l.course_id = c.id AND l.created_at >= $1
       GROUP BY c.author`,
      [since]
    ),
    pool.query(
      `SELECT author, COUNT(*) AS weekly_courses, COALESCE(SUM(play_count), 0) AS weekly_plays
       FROM courses
       WHERE posted_at >= $1
       GROUP BY author`,
      [sinceMinutes]
    ),
    pool.query(`SELECT name FROM official_makers`),
  ]);

  const officialSet = new Set(officialResult.rows.map(r => r.name));
  const allTimeMap = new Map();
  const latestMap  = new Map();
  for (const r of allTimeResult.rows) {
    const point = calcMakerPointAllTime(
      parseInt(r.total_likes, 10), parseInt(r.total_plays, 10), parseInt(r.total_courses, 10)
    );
    allTimeMap.set(r.author, point);
    latestMap.set(r.author, parseInt(r.latest_posted_at, 10));
  }
  const weeklyLikeMap   = new Map(weeklyLikeResult.rows.map(r => [r.author, parseInt(r.weekly_likes, 10)]));
  const weeklyCourseMap = new Map(weeklyCourseResult.rows.map(r => [r.author, parseInt(r.weekly_courses, 10)]));
  const weeklyPlayMap   = new Map(weeklyCourseResult.rows.map(r => [r.author, parseInt(r.weekly_plays, 10)]));

  const authors = new Set([...weeklyLikeMap.keys(), ...weeklyCourseMap.keys()]);

  const results = [];
  for (const author of authors) {
    const weeklyLikes = weeklyLikeMap.get(author) || 0;
    const weeklyCourses = weeklyCourseMap.get(author) || 0;
    const weeklyPlays = weeklyPlayMap.get(author) || 0;
    const allTimePoint = allTimeMap.get(author) || 0;
    const effectiveWeeklyCourses = weeklyCourses > 0 ? weeklyCourses : (weeklyLikes > 0 ? 1 : 0);
    const point = calcMakerPointWeekly(weeklyLikes, weeklyPlays, effectiveWeeklyCourses, allTimePoint);
    if (point <= 0) continue;

    results.push({
      author,
      point,
      latest_posted_at: latestMap.get(author) || 0,
      is_official: officialSet.has(author),
    });
  }

  results.sort((a, b) => b.point - a.point);
  return results.slice(0, limit);
}

// CMD=17: 職人ランキング（累計）
// パフォーマンス改善: official_makersを1回だけ取得してSetで判定する（N+1クエリ排除）
async function getMakerRankingAllTime(limit) {
  const [courseResult, officialResult] = await Promise.all([
    pool.query(
      `SELECT author,
              COALESCE(SUM(like_count), 0) AS like_count,
              COALESCE(SUM(play_count), 0) AS play_count,
              COUNT(*)                     AS course_count,
              MAX(posted_at)                AS latest_posted_at
       FROM courses
       GROUP BY author`
    ),
    pool.query(`SELECT name FROM official_makers`),
  ]);

  const officialSet = new Set(officialResult.rows.map(r => r.name));

  const results = courseResult.rows.map(r => {
    const totalLikes  = parseInt(r.like_count, 10);
    const totalPlays  = parseInt(r.play_count, 10);
    const courseCount = parseInt(r.course_count, 10);
    const point = calcMakerPointAllTime(totalLikes, totalPlays, courseCount);
    return {
      author: r.author,
      point,
      latest_posted_at: parseInt(r.latest_posted_at, 10),
      is_official: officialSet.has(r.author),
    };
  });

  results.sort((a, b) => b.point - a.point);
  return results.slice(0, limit);
}

// CMD=18: 職人情報（author指定）
// 送信するのは 職人ポイント(全期間) + 総いいね数 + 総プレイ数 + 全体順位 + 週間順位 + 公式フラグ
// コース投稿実績がなくても、職人登録(maker_accounts)されていれば0実績として情報を返す
async function getMakerInfo(author) {
  const [courseAggResult, officialRow, registeredRow] = await Promise.all([
    pool.query(
      `SELECT author,
              COALESCE(SUM(like_count), 0) AS total_likes,
              COALESCE(SUM(play_count), 0) AS total_plays,
              COUNT(*)                     AS total_courses,
              MAX(posted_at)               AS latest_posted_at
       FROM courses
       WHERE author = $1
       GROUP BY author`,
      [author]
    ),
    pool.query(`SELECT 1 FROM official_makers WHERE name=$1`, [author]),
    pool.query(
      `SELECT 1 FROM maker_accounts WHERE author=$1 AND status='confirmed' LIMIT 1`,
      [author]
    ),
  ]);

  const hasCourses = courseAggResult.rows.length > 0;
  const isRegistered = registeredRow.rows.length > 0;

  // コース投稿実績がなく、職人登録もされていない場合のみnullを返す
  if (!hasCourses && !isRegistered) return null;

  const r = hasCourses ? courseAggResult.rows[0] : null;
  const totalLikes   = r ? parseInt(r.total_likes, 10) : 0;
  const totalPlays   = r ? parseInt(r.total_plays, 10) : 0;
  const totalCourses = r ? parseInt(r.total_courses, 10) : 0;
  const latestPostedAt = r ? parseInt(r.latest_posted_at, 10) : 0;
  const allTimePoint = calcMakerPointAllTime(totalLikes, totalPlays, totalCourses);

  const allTimeRanking = await getMakerRankingAllTime(Number.MAX_SAFE_INTEGER);
  const allTimeIdx = allTimeRanking.findIndex(x => x.author === author);
  const allTimeRank = allTimeIdx >= 0 ? allTimeIdx + 1 : allTimeRanking.length + 1;

  const weeklyRanking = await getMakerRankingWeek(Number.MAX_SAFE_INTEGER);
  const weeklyIdx = weeklyRanking.findIndex(x => x.author === author);
  const weeklyRank = weeklyIdx >= 0 ? weeklyIdx + 1 : weeklyRanking.length + 1;

  return {
    author,
    maker_point: Math.round(allTimePoint),
    total_likes: totalLikes,
    total_plays: totalPlays,
    total_courses: totalCourses,
    all_time_rank: allTimeRank,
    weekly_rank: weeklyRank,
    is_official: !!officialRow.rows.length,
    latest_posted_at: latestPostedAt,
  };
}

// CMD=19: 公式職人一覧（ソートなし・登録順、CMD=16,17と同じフィールド構成）
async function getOfficialMakers(limit) {
  const { rows } = await pool.query(
    `SELECT om.name                              AS author,
            COALESCE(SUM(c.like_count), 0)        AS like_count,
            COALESCE(SUM(c.play_count), 0)        AS play_count,
            COUNT(c.id)                           AS course_count,
            COALESCE(MAX(c.posted_at), 0)         AS latest_posted_at
     FROM official_makers om
     LEFT JOIN courses c ON c.author = om.name
     GROUP BY om.name, om.added_at
     ORDER BY om.added_at ASC
     LIMIT $1`,
    [limit]
  );
  return rows.map(r => {
    const totalLikes  = parseInt(r.like_count, 10);
    const totalPlays  = parseInt(r.play_count, 10);
    const courseCount = parseInt(r.course_count, 10);
    const point = calcMakerPointAllTime(totalLikes, totalPlays, courseCount);
    return {
      author: r.author,
      point,
      latest_posted_at: parseInt(r.latest_posted_at, 10),
      is_official: true,
    };
  });
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

const CUTOFF_POSTED_AT = (() => {
  const epoch2000 = Date.UTC(2000, 0, 1, 0, 0, 0);
  const cutoffUtcMs = Date.UTC(2026, 7, 13, 0, 0, 0) - 9 * 60 * 60 * 1000;
  return Math.floor((cutoffUtcMs - epoch2000) / 60000);
})();

async function isAuthorConfirmed(author) {
  const { rows } = await pool.query(
    "SELECT 1 FROM maker_accounts WHERE author=$1 AND status='confirmed'", [author]
  );
  return rows.length > 0;
}

async function isAuthorUsedBeforeCutoff(author) {
  const { rows } = await pool.query(
    "SELECT 1 FROM courses WHERE author=$1 AND posted_at < $2 LIMIT 1",
    [author, CUTOFF_POSTED_AT]
  );
  return rows.length > 0;
}

async function hasUsernameUsedAuthorBeforeCutoff(author, username) {
  const { rows } = await pool.query(
    "SELECT 1 FROM courses WHERE author=$1 AND username=$2 AND posted_at < $3 LIMIT 1",
    [author, username, CUTOFF_POSTED_AT]
  );
  return rows.length > 0;
}

async function getMakerStatus(author) {
  const { rows } = await pool.query(
    `SELECT status FROM maker_accounts WHERE author=$1
     ORDER BY (status='confirmed') DESC, created_at DESC LIMIT 1`,
    [author]
  );
  return rows[0]?.status || null;
}

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

async function registerMakerPending(author, username, password) {
  const passwordHash = await bcrypt.hash(password, 10);
  await pool.query(
    "INSERT INTO maker_accounts (author, username, password_hash, status) VALUES ($1,$2,$3,'pending')",
    [author, username, passwordHash]
  );
}

async function verifyMakerPassword(author, password) {
  const { rows } = await pool.query(
    "SELECT password_hash FROM maker_accounts WHERE author=$1 AND status='confirmed'", [author]
  );
  if (!rows.length) return false;
  return bcrypt.compare(password, rows[0].password_hash);
}

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

async function approvePendingMaker(id) {
  const { rows } = await pool.query(
    "SELECT author FROM maker_accounts WHERE id=$1 AND status='pending'", [id]
  );
  if (!rows.length) return false;
  const author = rows[0].author;
  try {
    await pool.query("UPDATE maker_accounts SET status='confirmed' WHERE id=$1", [id]);
  } catch (e) {
    return false;
  }
  await pool.query(
    "DELETE FROM maker_accounts WHERE author=$1 AND status='pending' AND id<>$2", [author, id]
  );
  return true;
}

async function rejectPendingMaker(id) {
  const { rowCount } = await pool.query(
    "DELETE FROM maker_accounts WHERE id=$1 AND status='pending'", [id]
  );
  return rowCount > 0;
}

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
  await pool.query(
    `INSERT INTO bans (username, expires_at) VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
    [username, expiresAt]
  );
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
  const { rows } = await pool.query(
    "SELECT 1 FROM bans WHERE username=$1 AND expires_at > $2", [username, now]
  );
  if (rows.length > 0) return true;
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
  return rows[0] || null;
}

async function getStats() {
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

// ─────────────────────────────────────────────
// 職人チャット
// ─────────────────────────────────────────────

function compressText(text) {
  return zlib.gzipSync(Buffer.from(text, "utf8"));
}
function decompressText(buf) {
  return zlib.gunzipSync(buf).toString("utf8");
}

/** ログイン: 本登録済み職人のみ。トークンを発行してchat_sessionsに保存する */
async function chatLogin(author, password) {
  const confirmed = await isAuthorConfirmed(author);
  if (!confirmed) return { error: "not_registered" };
  const ok = await verifyMakerPassword(author, password);
  if (!ok) return { error: "invalid_password" };
  const banned = await isChatBanned(author);
  if (banned) return { error: "banned" };
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO chat_sessions (token, author) VALUES ($1, $2)", [token, author]
  );
  return { token, author };
}

/** トークンからauthorを取得（無効なら null） */
async function getAuthorByToken(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    "SELECT author FROM chat_sessions WHERE token=$1", [token]
  );
  return rows[0]?.author || null;
}

async function chatLogout(token) {
  await pool.query("DELETE FROM chat_sessions WHERE token=$1", [token]);
}

/** 全体チャットへ投稿 */
async function saveChatMessage(author, text) {
  const body = compressText(text);
  const { rows } = await pool.query(
    "INSERT INTO chat_messages (author, body) VALUES ($1, $2) RETURNING id, created_at",
    [author, body]
  );
  return rows[0];
}

/** 全体チャットの取得（idが afterId より大きいものを古い順、最大limit件） */
async function getChatMessages(afterId, limit) {
  const { rows } = await pool.query(
    "SELECT id, author, body, created_at FROM chat_messages WHERE id > $1 ORDER BY id ASC LIMIT $2",
    [afterId || 0, limit]
  );
  return rows.map(r => ({
    id: r.id, author: r.author, text: decompressText(r.body), created_at: parseInt(r.created_at, 10),
  }));
}

/** DM送信 */
async function saveDM(fromAuthor, toAuthor, text) {
  const body = compressText(text);
  const { rows } = await pool.query(
    "INSERT INTO chat_dm (from_author, to_author, body) VALUES ($1, $2, $3) RETURNING id, created_at",
    [fromAuthor, toAuthor, body]
  );
  return rows[0];
}

/** 2者間のDM取得 */
async function getDMMessages(authorA, authorB, afterId, limit) {
  const { rows } = await pool.query(
    `SELECT id, from_author, to_author, body, created_at FROM chat_dm
     WHERE ((from_author=$1 AND to_author=$2) OR (from_author=$2 AND to_author=$1))
       AND id > $3
     ORDER BY id ASC LIMIT $4`,
    [authorA, authorB, afterId || 0, limit]
  );
  return rows.map(r => ({
    id: r.id, from: r.from_author, to: r.to_author,
    text: decompressText(r.body), created_at: parseInt(r.created_at, 10),
  }));
}

/** DM相手一覧（最新メッセージ時刻順） */
async function getDMPartners(author) {
  const { rows } = await pool.query(
    `SELECT partner, MAX(created_at) AS last_at FROM (
       SELECT to_author AS partner, created_at FROM chat_dm WHERE from_author=$1
       UNION ALL
       SELECT from_author AS partner, created_at FROM chat_dm WHERE to_author=$1
     ) t
     GROUP BY partner
     ORDER BY last_at DESC`,
    [author]
  );
  return rows.map(r => ({ author: r.partner, last_at: parseInt(r.last_at, 10) }));
}

// ─────────────────────────────────────────────
// チャットBAN・通報
// ─────────────────────────────────────────────

async function banChatAuthor(author, expiresAt, reason = null) {
  await pool.query(
    `INSERT INTO chat_bans (author, expires_at, reason) VALUES ($1, $2, $3)
     ON CONFLICT (author) DO UPDATE SET expires_at = EXCLUDED.expires_at, reason = EXCLUDED.reason`,
    [author, expiresAt, reason]
  );
  // BAN対象の既存セッションを全て無効化
  await pool.query("DELETE FROM chat_sessions WHERE author=$1", [author]);
}

async function isChatBanned(author) {
  const now = Math.floor(Date.now() / 1000);
  const { rows } = await pool.query(
    "SELECT 1 FROM chat_bans WHERE author=$1 AND expires_at > $2", [author, now]
  );
  return rows.length > 0;
}

async function createChatReport(reporter, targetAuthor, reason) {
  await pool.query(
    "INSERT INTO chat_reports (reporter, target_author, reason) VALUES ($1, $2, $3)",
    [reporter, targetAuthor, reason]
  );
}

async function listChatReports() {
  const { rows } = await pool.query(
    "SELECT id, reporter, target_author, reason, created_at FROM chat_reports WHERE resolved=FALSE ORDER BY created_at ASC"
  );
  return rows;
}

async function resolveChatReport(id) {
  const { rowCount } = await pool.query(
    "UPDATE chat_reports SET resolved=TRUE WHERE id=$1", [id]
  );
  return rowCount > 0;
}

// ─────────────────────────────────────────────
// メッセージ削除（自分が送ったものだけ）
// ─────────────────────────────────────────────

async function deleteChatMessage(id, author) {
  const { rowCount } = await pool.query(
    "DELETE FROM chat_messages WHERE id=$1 AND author=$2", [id, author]
  );
  return rowCount > 0;
}

async function deleteDMMessage(id, author) {
  const { rowCount } = await pool.query(
    "DELETE FROM chat_dm WHERE id=$1 AND from_author=$2", [id, author]
  );
  return rowCount > 0;
}

// ─────────────────────────────────────────────
// ブロック
// ─────────────────────────────────────────────

async function blockAuthor(blocker, blocked) {
  await pool.query(
    `INSERT INTO chat_blocks (blocker, blocked) VALUES ($1, $2)
     ON CONFLICT (blocker, blocked) DO NOTHING`,
    [blocker, blocked]
  );
}

async function unblockAuthor(blocker, blocked) {
  await pool.query(
    "DELETE FROM chat_blocks WHERE blocker=$1 AND blocked=$2", [blocker, blocked]
  );
}

async function getBlockedAuthors(blocker) {
  const { rows } = await pool.query(
    "SELECT blocked FROM chat_blocks WHERE blocker=$1 ORDER BY created_at DESC", [blocker]
  );
  return rows.map(r => r.blocked);
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
  calcMakerPointAllTime, calcMakerPointWeekly,
  chatLogin, getAuthorByToken, chatLogout,
  saveChatMessage, getChatMessages, saveDM, getDMMessages, getDMPartners,
  banChatAuthor, isChatBanned, createChatReport, listChatReports, resolveChatReport,
  deleteChatMessage, deleteDMMessage,
  blockAuthor, unblockAuthor, getBlockedAuthors,
};
