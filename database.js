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
      ip_address TEXT,
      created_at BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS ip_address TEXT;
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_author ON chat_sessions(author);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id         SERIAL  PRIMARY KEY,
      author     TEXT    NOT NULL,
      body       BYTEA   NOT NULL,
      created_at BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      deleted    BOOLEAN NOT NULL DEFAULT FALSE,
      deleted_at BIGINT
    );
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_at BIGINT;
    CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_deleted ON chat_messages(deleted, deleted_at);

    CREATE TABLE IF NOT EXISTS chat_dm (
      id          SERIAL  PRIMARY KEY,
      from_author TEXT    NOT NULL,
      to_author   TEXT    NOT NULL,
      body        BYTEA   NOT NULL,
      created_at  BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      deleted     BOOLEAN NOT NULL DEFAULT FALSE,
      deleted_at  BIGINT
    );
    ALTER TABLE chat_dm ADD COLUMN IF NOT EXISTS deleted BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE chat_dm ADD COLUMN IF NOT EXISTS deleted_at BIGINT;
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
      resolved      BOOLEAN NOT NULL DEFAULT FALSE,
      message_kind  TEXT,
      message_id    INT,
      message_text  TEXT
    );
    ALTER TABLE chat_reports ADD COLUMN IF NOT EXISTS message_kind TEXT;
    ALTER TABLE chat_reports ADD COLUMN IF NOT EXISTS message_id INT;
    ALTER TABLE chat_reports ADD COLUMN IF NOT EXISTS message_text TEXT;
    CREATE INDEX IF NOT EXISTS idx_chat_reports_resolved ON chat_reports(resolved, created_at DESC);
    -- ユニークインデックス作成前に、既存の重複通報（同じ人が同じメッセージを複数回通報したもの）を
    -- 一番古い1件だけ残して削除しておく（重複が残っているとユニークインデックスの作成に失敗するため）
    -- message_kindがNULL同士の行も正しく重複とみなせるよう IS NOT DISTINCT FROM を使う
    DELETE FROM chat_reports a
    USING chat_reports b
    WHERE a.message_id IS NOT NULL
      AND a.reporter = b.reporter
      AND a.message_kind IS NOT DISTINCT FROM b.message_kind
      AND a.message_id = b.message_id
      AND a.id > b.id;

    -- 同じ人が同じメッセージを二重に通報できないようにする（message_idがある場合のみ）
    -- 万が一まだ重複が残っていて作成に失敗しても、サーバー起動自体は止めずに警告だけ出す
    DO $do$
    BEGIN
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_reports_unique_msg
        ON chat_reports (reporter, message_kind, message_id)
        WHERE message_id IS NOT NULL;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'idx_chat_reports_unique_msg の作成に失敗しました（重複データが残っている可能性があります）: %', SQLERRM;
    END;
    $do$;

    CREATE TABLE IF NOT EXISTS chat_blocks (
      blocker    TEXT    NOT NULL,
      blocked    TEXT    NOT NULL,
      created_at BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      PRIMARY KEY (blocker, blocked)
    );

    CREATE TABLE IF NOT EXISTS chat_banned_words (
      word       TEXT    PRIMARY KEY,
      created_at BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

    CREATE TABLE IF NOT EXISTS chat_dm_reads (
      author       TEXT    NOT NULL,
      partner      TEXT    NOT NULL,
      last_read_id INT     NOT NULL DEFAULT 0,
      PRIMARY KEY (author, partner)
    );

    CREATE TABLE IF NOT EXISTS chat_daily_usage (
      author      TEXT    NOT NULL,
      usage_date  TEXT    NOT NULL,
      char_count  INT     NOT NULL DEFAULT 0,
      PRIMARY KEY (author, usage_date)
    );

    CREATE TABLE IF NOT EXISTS daily_active_users (
      username     TEXT    NOT NULL,
      business_day TEXT    NOT NULL,
      first_seen_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      PRIMARY KEY (username, business_day)
    );
    CREATE INDEX IF NOT EXISTS idx_dau_business_day ON daily_active_users(business_day);

    CREATE INDEX IF NOT EXISTS idx_courses_likes   ON courses(like_count DESC);
    CREATE INDEX IF NOT EXISTS idx_courses_posted  ON courses(posted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_courses_author  ON courses(author);
    CREATE INDEX IF NOT EXISTS idx_courses_title   ON courses(title);
    CREATE INDEX IF NOT EXISTS idx_likes_course    ON likes(course_id);
    CREATE INDEX IF NOT EXISTS idx_likes_created   ON likes(created_at DESC);

    CREATE TABLE IF NOT EXISTS like_fraud_incidents (
      id                   SERIAL  PRIMARY KEY,
      course_id            TEXT    NOT NULL,
      author               TEXT    NOT NULL,
      removed_count        INT     NOT NULL,
      action               TEXT    NOT NULL,
      disposable_ratio     REAL,
      prior_incident_count INT     NOT NULL DEFAULT 0,
      ban_days             INT,
      detected_at          BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    ALTER TABLE like_fraud_incidents ADD COLUMN IF NOT EXISTS disposable_ratio REAL;
    ALTER TABLE like_fraud_incidents ADD COLUMN IF NOT EXISTS prior_incident_count INT NOT NULL DEFAULT 0;
    ALTER TABLE like_fraud_incidents ADD COLUMN IF NOT EXISTS ban_days INT;
    CREATE INDEX IF NOT EXISTS idx_fraud_detected ON like_fraud_incidents(detected_at DESC);
  `);

  // Supabaseの自動REST API(PostgREST)経由でのアクセスを塞ぐため、
  // publicスキーマの全テーブルでRLSを有効化する（ポリシーは追加しない=全面拒否）。
  // このアプリはDATABASE_URL経由の直接接続のみを使用しており、テーブル所有者ロールは
  // RLSを自動的にバイパスするため、サーバー自身の動作には影響しない。
  await pool.query(`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.tablename);
      END LOOP;
    END $$;
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

  // 1職人あたり最大100コースまで
  const MAX_COURSES_PER_AUTHOR = 100;
  const { rows: authorCountRows } = await pool.query(
    "SELECT COUNT(*) FROM courses WHERE author=$1", [safeAuthor]
  );
  if (parseInt(authorCountRows[0].count, 10) >= MAX_COURSES_PER_AUTHOR) {
    return { limitReached: true };
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
// 不正いいね検知・自動修復
// ─────────────────────────────────────────────

const LIKE_FRAUD_BURST_GAP_SECONDS       = 120;  // この秒数以内の間隔で連続していれば同じ"塊(バースト)"とみなす
const LIKE_FRAUD_MIN_BURST_SIZE          = 6;    // 通常、1つの塊がこの件数以上なら不正とみなす
const LIKE_FRAUD_SUSPICIOUS_MIN_SIZE     = 3;    // 使い捨てユーザー名比率が高い場合、この件数まで閾値を下げる
const LIKE_FRAUD_DISPOSABLE_RATIO_THRESHOLD = 0.7; // 塊の中でこの割合以上が「使い捨てユーザー名」なら閾値緩和の対象にする
const LIKE_FRAUD_LOOKBACK_HOURS          = 6;    // 直近何時間分のいいねを対象に検査するか
const LIKE_FRAUD_REPEAT_WINDOW_DAYS      = 30;   // 常習犯判定に使う「過去何日以内の検知件数」

// 常習犯エスカレーション設定（今回が何回目の検知かによって、重大判定の基準と対応を厳しくする）
// priorCount: このコース作者が過去LIKE_FRAUD_REPEAT_WINDOW_DAYS日以内に検知された回数
const LIKE_FRAUD_ESCALATION_LEVELS = [
  { minPriorCount: 0, extremeSize: 50, banDays: 7,  alwaysBan: false }, // 1回目
  { minPriorCount: 1, extremeSize: 20, banDays: 14, alwaysBan: false }, // 2回目
  { minPriorCount: 2, extremeSize: 10, banDays: 30, alwaysBan: true  }, // 3回目以降: 小規模でも即BAN
];

function getEscalationLevel(priorCount) {
  let level = LIKE_FRAUD_ESCALATION_LEVELS[0];
  for (const l of LIKE_FRAUD_ESCALATION_LEVELS) {
    if (priorCount >= l.minPriorCount) level = l;
  }
  return level;
}

/** 過去LIKE_FRAUD_REPEAT_WINDOW_DAYS日以内に、その職人が検知された回数を取得する */
async function countRecentFraudIncidents(author) {
  const since = Math.floor(Date.now() / 1000) - LIKE_FRAUD_REPEAT_WINDOW_DAYS * 24 * 60 * 60;
  const { rows } = await pool.query(
    "SELECT COUNT(*) FROM like_fraud_incidents WHERE author=$1 AND detected_at >= $2",
    [author, since]
  );
  return parseInt(rows[0].count, 10);
}

/**
 * 塊(cluster)内のユーザー名のうち、「そのいいね以外に一度も他のいいね履歴がない」
 * ＝使い捨てユーザー名とみなせる割合を計算する
 */
async function calcDisposableUsernameRatio(cluster) {
  const usernames = [...new Set(cluster.map(r => r.username))];
  const ids = cluster.map(r => r.id);
  if (!usernames.length) return 0;

  const { rows } = await pool.query(
    `SELECT username, COUNT(*) AS other_count
     FROM likes
     WHERE username = ANY($1::text[]) AND id <> ALL($2::int[])
     GROUP BY username`,
    [usernames, ids]
  );
  const hasOtherHistory = new Set(rows.filter(r => parseInt(r.other_count, 10) > 0).map(r => r.username));
  const disposableCount = usernames.filter(u => !hasOtherHistory.has(u)).length;
  return disposableCount / usernames.length;
}

/**
 * 「同じコースに、短時間で・複数の異なるユーザー名から・連続していいねが押される」パターン
 * （＝ユーザー名を変えながらの自作自演いいね連打）を検知し、自動で修復する。
 *
 * - 検知した不正いいねの塊はlikesテーブルから削除し、courses.like_countも実態に合わせて補正する。
 * - 塊のサイズが基準（常習度に応じて変動）以上という重大な規模だった場合は、
 *   該当コースのいいね数を実カウントにリセットし、投稿者(職人)のチャットログインを一定期間停止する。
 * - 塊が使い捨てユーザー名ばかりで構成されている場合、通常より小さい塊でも不正と判定する。
 * - 過去に何度も検知されている職人（常習犯）ほど、判定基準を厳しくする。
 */
async function detectAndCleanSuspiciousLikes() {
  const since = Math.floor(Date.now() / 1000) - LIKE_FRAUD_LOOKBACK_HOURS * 3600;
  const { rows } = await pool.query(
    `SELECT id, username, course_id, created_at FROM likes
     WHERE created_at >= $1
     ORDER BY course_id, created_at ASC`,
    [since]
  );

  // コースごとにグループ化する
  const byCourse = new Map();
  for (const r of rows) {
    if (!byCourse.has(r.course_id)) byCourse.set(r.course_id, []);
    byCourse.get(r.course_id).push(r);
  }

  // 時系列順に並んだいいねを、間隔がLIKE_FRAUD_BURST_GAP_SECONDS以内なら同じ塊としてまとめる
  const candidateClusters = [];
  for (const [courseId, likeRows] of byCourse) {
    let clusterStart = 0;
    for (let i = 1; i <= likeRows.length; i++) {
      const prev = likeRows[i - 1];
      const cur = likeRows[i];
      const isBoundary = !cur || (cur.created_at - prev.created_at) > LIKE_FRAUD_BURST_GAP_SECONDS;
      if (isBoundary) {
        const cluster = likeRows.slice(clusterStart, i);
        if (cluster.length >= LIKE_FRAUD_SUSPICIOUS_MIN_SIZE) {
          candidateClusters.push({ courseId, cluster });
        }
        clusterStart = i;
      }
    }
  }

  // ② 使い捨てユーザー名比率をもとに、不正とみなす塊を確定する
  const incidents = [];
  for (const { courseId, cluster } of candidateClusters) {
    const size = cluster.length;
    if (size >= LIKE_FRAUD_MIN_BURST_SIZE) {
      // 通常の基準を満たしていれば、比率を見るまでもなく不正
      incidents.push({ courseId, cluster, disposableRatio: null });
      continue;
    }
    // 通常基準未満(3〜5件)は、使い捨てユーザー名の比率が高い場合のみ不正とみなす
    const disposableRatio = await calcDisposableUsernameRatio(cluster);
    if (disposableRatio >= LIKE_FRAUD_DISPOSABLE_RATIO_THRESHOLD) {
      incidents.push({ courseId, cluster, disposableRatio });
    }
  }

  const results = [];
  for (const { courseId, cluster, disposableRatio } of incidents) {
    const ids = cluster.map(r => r.id);
    const size = ids.length;

    const { rows: courseRows } = await pool.query(
      "SELECT author FROM courses WHERE id=$1", [courseId]
    );
    if (!courseRows.length) continue; // 既に削除済みのコースなどはスキップ
    const author = courseRows[0].author;

    // ③ 常習犯エスカレーション: 過去の検知回数から今回の判定基準を決める
    const priorCount = await countRecentFraudIncidents(author);
    const escalation = getEscalationLevel(priorCount);
    const isExtreme = size >= escalation.extremeSize || escalation.alwaysBan;

    // 不正と判定したいいねを削除する
    await pool.query("DELETE FROM likes WHERE id = ANY($1::int[])", [ids]);

    // ②のため未計算だった場合（通常基準で確定した塊）も、記録用に比率を算出しておく
    const finalDisposableRatio = disposableRatio !== null ? disposableRatio : await calcDisposableUsernameRatio(cluster);

    if (isExtreme) {
      // 重大な不正: いいね数を実カウントにリセットし、職人のチャットログインを停止する
      const { rows: countRows } = await pool.query(
        "SELECT COUNT(*) FROM likes WHERE course_id=$1", [courseId]
      );
      const actualCount = parseInt(countRows[0].count, 10);
      await pool.query("UPDATE courses SET like_count=$1 WHERE id=$2", [actualCount, courseId]);

      const banDays = escalation.banDays;
      const expiresAt = Math.floor(Date.now() / 1000) + banDays * 24 * 60 * 60;
      await banChatAuthor(
        author, expiresAt,
        `不正いいね自動検知（${size}件、通算${priorCount + 1}回目の検知）`
      );

      await pool.query(
        `INSERT INTO like_fraud_incidents
           (course_id, author, removed_count, action, disposable_ratio, prior_incident_count, ban_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [courseId, author, size, "reset_and_ban", finalDisposableRatio, priorCount, banDays]
      );
      results.push({ courseId, author, removedCount: size, action: "reset_and_ban", priorCount, banDays });
    } else {
      // 通常の不正: 不正分だけ差し引く
      await pool.query(
        "UPDATE courses SET like_count = GREATEST(like_count - $1, 0) WHERE id=$2",
        [size, courseId]
      );
      await pool.query(
        `INSERT INTO like_fraud_incidents
           (course_id, author, removed_count, action, disposable_ratio, prior_incident_count)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [courseId, author, size, "trim", finalDisposableRatio, priorCount]
      );
      results.push({ courseId, author, removedCount: size, action: "trim", priorCount, banDays: null });
    }
  }

  return results;
}

/** 不正いいね検知の履歴一覧（管理ページ表示用） */
async function listLikeFraudIncidents(limit = 100) {
  const { rows } = await pool.query(
    `SELECT id, course_id, author, removed_count, action, disposable_ratio, prior_incident_count, ban_days, detected_at
     FROM like_fraud_incidents ORDER BY detected_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
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
      COUNT(*) FILTER (WHERE posted_at >= $1)           AS weekly_courses
    FROM courses
  `, [weekAgo]);
  return rows[0];
}

// ─────────────────────────────────────────────
// 職人チャット
// ─────────────────────────────────────────────

// 保存形式: 先頭1バイトをフラグとして使う
//   0x00 = 無圧縮（以降がUTF-8のテキストそのもの）
//   0x01 = gzip圧縮（以降がgzipデータ）
// 短いメッセージはgzipのヘッダー/フッターの固定コストで逆に肥大化するため、
// 圧縮した方が実際に小さくなる場合だけgzipを使う。
const RAW_FLAG  = Buffer.from([0x00]);
const GZIP_FLAG = Buffer.from([0x01]);

function compressText(text) {
  const raw = Buffer.from(text, "utf8");
  const gzipped = zlib.gzipSync(raw);
  if (gzipped.length + GZIP_FLAG.length < raw.length + RAW_FLAG.length) {
    return Buffer.concat([GZIP_FLAG, gzipped]);
  }
  return Buffer.concat([RAW_FLAG, raw]);
}

function decompressText(buf) {
  // 後方互換: 以前のバージョンはフラグなしで常にgzip保存していたため、
  // gzipのマジックナンバー(0x1f 0x8b)で始まる場合はフラグなしの旧形式とみなす
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return zlib.gunzipSync(buf).toString("utf8");
  }
  const flag = buf[0];
  const body = buf.subarray(1);
  if (flag === GZIP_FLAG[0]) {
    return zlib.gunzipSync(body).toString("utf8");
  }
  return body.toString("utf8");
}

/** ログイン: 本登録済み職人のみ。トークンを発行してchat_sessionsに保存する */
async function chatLogin(author, password, ipAddress = null) {
  const confirmed = await isAuthorConfirmed(author);
  if (!confirmed) return { error: "not_registered" };
  const ok = await verifyMakerPassword(author, password);
  if (!ok) return { error: "invalid_password" };
  const banned = await isChatBanned(author, ipAddress);
  if (banned) return { error: "banned" };
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO chat_sessions (token, author, ip_address) VALUES ($1, $2, $3)", [token, author, ipAddress || null]
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
    "SELECT id, author, body, created_at FROM chat_messages WHERE id > $1 AND deleted=FALSE ORDER BY id ASC LIMIT $2",
    [afterId || 0, limit]
  );
  return rows.map(r => ({
    id: r.id, author: r.author, text: decompressText(r.body), created_at: parseInt(r.created_at, 10),
  }));
}

/** 初回読み込み用: 最新limit件を、古い→新しい の順で返す（一番古いメッセージから表示されるのを防ぐため） */
async function getLatestChatMessages(limit) {
  const { rows } = await pool.query(
    "SELECT id, author, body, created_at FROM chat_messages WHERE deleted=FALSE ORDER BY id DESC LIMIT $1",
    [limit]
  );
  return rows.reverse().map(r => ({
    id: r.id, author: r.author, text: decompressText(r.body), created_at: parseInt(r.created_at, 10),
  }));
}

/** 「過去にさかのぼって読み込む」用: beforeIdより古いメッセージをlimit件、古い→新しい の順で返す */
async function getChatMessagesBefore(beforeId, limit) {
  const { rows } = await pool.query(
    "SELECT id, author, body, created_at FROM chat_messages WHERE id < $1 AND deleted=FALSE ORDER BY id DESC LIMIT $2",
    [beforeId, limit]
  );
  return rows.reverse().map(r => ({
    id: r.id, author: r.author, text: decompressText(r.body), created_at: parseInt(r.created_at, 10),
  }));
}

/** 直近sinceSeconds秒以内に削除された全体チャットのメッセージID一覧 */
async function getRecentlyDeletedChatIds(sinceSeconds = 120) {
  const cutoff = Math.floor(Date.now() / 1000) - sinceSeconds;
  const { rows } = await pool.query(
    "SELECT id FROM chat_messages WHERE deleted=TRUE AND deleted_at >= $1", [cutoff]
  );
  return rows.map(r => r.id);
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
       AND id > $3 AND deleted=FALSE
     ORDER BY id ASC LIMIT $4`,
    [authorA, authorB, afterId || 0, limit]
  );
  return rows.map(r => ({
    id: r.id, from: r.from_author, to: r.to_author,
    text: decompressText(r.body), created_at: parseInt(r.created_at, 10),
  }));
}

/** 初回読み込み用: 最新limit件を、古い→新しい の順で返す */
async function getLatestDMMessages(authorA, authorB, limit) {
  const { rows } = await pool.query(
    `SELECT id, from_author, to_author, body, created_at FROM chat_dm
     WHERE ((from_author=$1 AND to_author=$2) OR (from_author=$2 AND to_author=$1))
       AND deleted=FALSE
     ORDER BY id DESC LIMIT $3`,
    [authorA, authorB, limit]
  );
  return rows.reverse().map(r => ({
    id: r.id, from: r.from_author, to: r.to_author,
    text: decompressText(r.body), created_at: parseInt(r.created_at, 10),
  }));
}

/** 「過去にさかのぼって読み込む」用: beforeIdより古いDMをlimit件、古い→新しい の順で返す */
async function getDMMessagesBefore(authorA, authorB, beforeId, limit) {
  const { rows } = await pool.query(
    `SELECT id, from_author, to_author, body, created_at FROM chat_dm
     WHERE ((from_author=$1 AND to_author=$2) OR (from_author=$2 AND to_author=$1))
       AND id < $3 AND deleted=FALSE
     ORDER BY id DESC LIMIT $4`,
    [authorA, authorB, beforeId, limit]
  );
  return rows.reverse().map(r => ({
    id: r.id, from: r.from_author, to: r.to_author,
    text: decompressText(r.body), created_at: parseInt(r.created_at, 10),
  }));
}

/** 2者間のDMで直近sinceSeconds秒以内に削除されたメッセージID一覧 */
async function getRecentlyDeletedDMIds(authorA, authorB, sinceSeconds = 120) {
  const cutoff = Math.floor(Date.now() / 1000) - sinceSeconds;
  const { rows } = await pool.query(
    `SELECT id FROM chat_dm
     WHERE ((from_author=$1 AND to_author=$2) OR (from_author=$2 AND to_author=$1))
       AND deleted=TRUE AND deleted_at >= $3`,
    [authorA, authorB, cutoff]
  );
  return rows.map(r => r.id);
}

/** DM相手一覧（最新メッセージ時刻順） */
/** DM相手一覧（最新メッセージ時刻順・未読件数つき） */
async function getDMPartners(author) {
  const { rows } = await pool.query(
    `SELECT t.partner, MAX(t.created_at) AS last_at,
            COUNT(*) FILTER (
              WHERE t.from_author = t.partner
                AND t.id > COALESCE(r.last_read_id, 0)
            ) AS unread_count
     FROM (
       SELECT id, to_author AS partner, from_author, created_at FROM chat_dm WHERE from_author=$1 AND deleted=FALSE
       UNION ALL
       SELECT id, from_author AS partner, from_author, created_at FROM chat_dm WHERE to_author=$1 AND deleted=FALSE
     ) t
     LEFT JOIN chat_dm_reads r ON r.author=$1 AND r.partner=t.partner
     GROUP BY t.partner
     ORDER BY last_at DESC`,
    [author]
  );
  return rows.map(r => ({
    author: r.partner,
    last_at: parseInt(r.last_at, 10),
    unread_count: parseInt(r.unread_count, 10),
  }));
}

/** そのDM相手との会話を既読にする（現時点までの最新メッセージIDを記録） */
async function markDMRead(author, partner) {
  await pool.query(
    `INSERT INTO chat_dm_reads (author, partner, last_read_id)
     SELECT $1, $2, COALESCE(MAX(id), 0) FROM chat_dm
     WHERE (from_author=$1 AND to_author=$2) OR (from_author=$2 AND to_author=$1)
     ON CONFLICT (author, partner) DO UPDATE SET
       last_read_id = GREATEST(chat_dm_reads.last_read_id, EXCLUDED.last_read_id)`,
    [author, partner]
  );
}

// ─────────────────────────────────────────────
// チャット: 1日あたりの送信文字数制限
// ─────────────────────────────────────────────

/** 日本時間(JST)での今日の日付文字列 'YYYY-MM-DD' を返す */
function getJstDateString() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** その職人が今日(JST)に送信した文字数の合計を取得する */
async function getDailyCharCount(author) {
  const day = getJstDateString();
  const { rows } = await pool.query(
    "SELECT char_count FROM chat_daily_usage WHERE author=$1 AND usage_date=$2",
    [author, day]
  );
  return rows.length ? rows[0].char_count : 0;
}

/** 今日(JST)の送信文字数を加算する */
async function addDailyCharCount(author, addChars) {
  const day = getJstDateString();
  await pool.query(
    `INSERT INTO chat_daily_usage (author, usage_date, char_count) VALUES ($1, $2, $3)
     ON CONFLICT (author, usage_date) DO UPDATE SET
       char_count = chat_daily_usage.char_count + EXCLUDED.char_count`,
    [author, day, addChars]
  );
}

/** 古い日次使用量の記録を削除する（今日以外は不要なため） */
async function cleanupOldDailyUsage() {
  const today = getJstDateString();
  const { rowCount } = await pool.query(
    "DELETE FROM chat_daily_usage WHERE usage_date <> $1", [today]
  );
  if (rowCount > 0) console.log(`🗑️ 古いチャット日次使用量を ${rowCount} 件削除しました`);
}

// ─────────────────────────────────────────────
// 営業日（6:00〜翌1:00）ごとの訪問ユーザー記録
// ─────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, "0"); }
function jstDateToString(y, m, d) { return `${y}-${pad2(m + 1)}-${pad2(d)}`; }

/**
 * 現在時刻(JST)がどの営業日(6:00〜翌1:00)に属するかを返す。
 * 1:00〜5:59の間は営業日と営業日の間の「空白時間」のため null を返す（記録対象外）。
 */
function getBusinessDayForRecording() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const hour = jst.getUTCHours();
  const y = jst.getUTCFullYear(), m = jst.getUTCMonth(), d = jst.getUTCDate();

  if (hour >= 6) {
    // 今日の6:00に始まった営業日
    return jstDateToString(y, m, d);
  }
  if (hour < 1) {
    // 昨日の6:00に始まり、今日の1:00まで続いている営業日
    const yesterday = new Date(Date.UTC(y, m, d - 1));
    return jstDateToString(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate());
  }
  return null; // 1:00〜5:59: どの営業日にも属さない
}

/** 表示用: 現在が空白時間(1:00〜5:59)なら、直前に終わった営業日を返す */
function getBusinessDayForDisplay() {
  const recording = getBusinessDayForRecording();
  if (recording) return recording;
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear(), m = jst.getUTCMonth(), d = jst.getUTCDate();
  const yesterday = new Date(Date.UTC(y, m, d - 1));
  return jstDateToString(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate());
}

/** その営業日に訪れたユーザーとしてusernameを記録する（同じ営業日内の重複は無視される） */
async function recordDailyActiveUser(username, businessDay) {
  await pool.query(
    `INSERT INTO daily_active_users (username, business_day) VALUES ($1, $2)
     ON CONFLICT (username, business_day) DO NOTHING`,
    [username, businessDay]
  );
}

/** 指定した営業日に訪れたユーザーの人数（重複なし）を取得する */
async function countDailyActiveUsers(businessDay) {
  const { rows } = await pool.query(
    "SELECT COUNT(*) FROM daily_active_users WHERE business_day=$1", [businessDay]
  );
  return parseInt(rows[0].count, 10);
}

/** 古い営業日の記録を削除する（DB容量対策） */
async function cleanupOldDailyActiveUsers(retentionDays = 30) {
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 24 * 60 * 60;
  const { rowCount } = await pool.query(
    "DELETE FROM daily_active_users WHERE first_seen_at < $1", [cutoff]
  );
  if (rowCount > 0) console.log(`🗑️ 古い訪問ユーザー記録を ${rowCount} 件削除しました`);
}

// ─────────────────────────────────────────────
// チャット: 古いメッセージの削除（DB容量対策）
// ─────────────────────────────────────────────

/** retentionDays日より古いチャットメッセージ・DMを削除する */
async function deleteOldChatMessages(retentionDays = 90) {
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 24 * 60 * 60;
  const { rowCount: msgCount } = await pool.query(
    "DELETE FROM chat_messages WHERE created_at < $1", [cutoff]
  );
  const { rowCount: dmCount } = await pool.query(
    "DELETE FROM chat_dm WHERE created_at < $1", [cutoff]
  );
  if (msgCount > 0 || dmCount > 0) {
    console.log(`🗑️ 古いチャットデータを削除しました（全体チャット: ${msgCount}件, DM: ${dmCount}件）`);
  }
  return { deletedMessages: msgCount, deletedDMs: dmCount };
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
  // そのauthorが過去にチャットへログインした際のIPアドレスも全てBANする
  // （IPアドレスを変えて別のauthor名で再ログインされてもBANが効くようにするため）
  const { rows: ipRows } = await pool.query(
    "SELECT DISTINCT ip_address FROM chat_sessions WHERE author=$1 AND ip_address IS NOT NULL",
    [author]
  );
  for (const { ip_address } of ipRows) {
    await pool.query(
      `INSERT INTO chat_bans (author, expires_at, reason) VALUES ($1, $2, $3)
       ON CONFLICT (author) DO UPDATE SET expires_at = EXCLUDED.expires_at, reason = EXCLUDED.reason`,
      [ip_address, expiresAt, reason]
    );
  }
  // BAN対象の既存セッションを全て無効化
  await pool.query("DELETE FROM chat_sessions WHERE author=$1", [author]);
}

async function isChatBanned(author, ipAddress = null) {
  const now = Math.floor(Date.now() / 1000);
  const { rows } = await pool.query(
    "SELECT 1 FROM chat_bans WHERE author=$1 AND expires_at > $2", [author, now]
  );
  if (rows.length > 0) return true;
  if (ipAddress) {
    const { rows: ipRows } = await pool.query(
      "SELECT 1 FROM chat_bans WHERE author=$1 AND expires_at > $2", [ipAddress, now]
    );
    if (ipRows.length > 0) return true;
  }
  return false;
}

/** チャットBANを解除する（誤検知時などに管理者が使う） */
async function unbanChatAuthor(author) {
  const { rowCount } = await pool.query(
    "DELETE FROM chat_bans WHERE author=$1", [author]
  );
  return rowCount > 0;
}

/**
 * 通報を作成する。kind('global'/'dm')とmessageIdが指定された場合、
 * 通報された時点のメッセージ本文をサーバー側で取得してスナップショット保存する
 * （後でメッセージが削除されても、通報された内容を確認できるようにするため）
 *
 * 同じ人が同じメッセージ(kind+messageId)を既に通報済みの場合は何もせず false を返す。
 * 通報を新規作成できた場合は true を返す。
 */
async function createChatReport(reporter, targetAuthor, reason, kind = null, messageId = null) {
  let messageText = null;
  if (kind === "global" && messageId) {
    const { rows } = await pool.query("SELECT body FROM chat_messages WHERE id=$1", [messageId]);
    if (rows.length) messageText = decompressText(rows[0].body);
  } else if (kind === "dm" && messageId) {
    const { rows } = await pool.query("SELECT body FROM chat_dm WHERE id=$1", [messageId]);
    if (rows.length) messageText = decompressText(rows[0].body);
  }
  const { rowCount } = await pool.query(
    `INSERT INTO chat_reports (reporter, target_author, reason, message_kind, message_id, message_text)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (reporter, message_kind, message_id) WHERE message_id IS NOT NULL DO NOTHING`,
    [reporter, targetAuthor, reason, kind, messageId || null, messageText]
  );
  return rowCount > 0;
}

async function listChatReports() {
  const { rows } = await pool.query(
    `SELECT id, reporter, target_author, reason, created_at, message_kind, message_id, message_text
     FROM chat_reports WHERE resolved=FALSE ORDER BY created_at ASC`
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
    `UPDATE chat_messages SET deleted=TRUE, deleted_at=EXTRACT(EPOCH FROM NOW())::BIGINT
     WHERE id=$1 AND author=$2 AND deleted=FALSE`,
    [id, author]
  );
  return rowCount > 0;
}

async function deleteDMMessage(id, author) {
  const { rowCount } = await pool.query(
    `UPDATE chat_dm SET deleted=TRUE, deleted_at=EXTRACT(EPOCH FROM NOW())::BIGINT
     WHERE id=$1 AND from_author=$2 AND deleted=FALSE`,
    [id, author]
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

/** blockerがblockedをブロックしているかどうか */
async function isAuthorBlocked(blocker, blocked) {
  const { rows } = await pool.query(
    "SELECT 1 FROM chat_blocks WHERE blocker=$1 AND blocked=$2", [blocker, blocked]
  );
  return rows.length > 0;
}

// ─────────────────────────────────────────────
// 禁止ワード（NGワード）
// リストはコードに直書きせず、DBで管理する。管理ページから追加・削除する。
// ─────────────────────────────────────────────

async function listBannedWords() {
  const { rows } = await pool.query(
    "SELECT word FROM chat_banned_words ORDER BY created_at ASC"
  );
  return rows.map(r => r.word);
}

async function addBannedWord(word) {
  await pool.query(
    "INSERT INTO chat_banned_words (word) VALUES ($1) ON CONFLICT (word) DO NOTHING",
    [word]
  );
}

async function removeBannedWord(word) {
  const { rowCount } = await pool.query(
    "DELETE FROM chat_banned_words WHERE word=$1", [word]
  );
  return rowCount > 0;
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
  saveChatMessage, getChatMessages, getLatestChatMessages, getChatMessagesBefore,
  saveDM, getDMMessages, getLatestDMMessages, getDMMessagesBefore, getDMPartners, markDMRead,
  getDailyCharCount, addDailyCharCount, cleanupOldDailyUsage, deleteOldChatMessages,
  getBusinessDayForRecording, getBusinessDayForDisplay,
  recordDailyActiveUser, countDailyActiveUsers, cleanupOldDailyActiveUsers,
  getRecentlyDeletedChatIds, getRecentlyDeletedDMIds,
  banChatAuthor, unbanChatAuthor, isChatBanned, createChatReport, listChatReports, resolveChatReport,
  detectAndCleanSuspiciousLikes, listLikeFraudIncidents,
  deleteChatMessage, deleteDMMessage,
  blockAuthor, unblockAuthor, getBlockedAuthors, isAuthorBlocked,
  listBannedWords, addBannedWord, removeBannedWord,
};
