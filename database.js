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
    -- 管理者が復元したいいね。自動検知・自動削除の対象から外す
    ALTER TABLE likes ADD COLUMN IF NOT EXISTS protected BOOLEAN NOT NULL DEFAULT FALSE;

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

    -- 最大同接数（scope='all' が全期間、営業日の文字列 'YYYY-MM-DD' がその営業日の最大）
    CREATE TABLE IF NOT EXISTS online_peaks (
      scope   TEXT    PRIMARY KEY,
      peak    INT     NOT NULL,
      peak_at BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

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

    -- 自動削除したいいねのバックアップ（管理ページから復元できるようにする）
    CREATE TABLE IF NOT EXISTS deleted_likes (
      id          SERIAL  PRIMARY KEY,
      incident_id INT,
      author      TEXT    NOT NULL,
      course_id   TEXT    NOT NULL,
      username    TEXT    NOT NULL,
      liked_at    BIGINT  NOT NULL,
      deleted_at  BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      source      TEXT    NOT NULL,
      restored    BOOLEAN NOT NULL DEFAULT FALSE,
      restored_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_deleted_likes_incident ON deleted_likes(incident_id);
    CREATE INDEX IF NOT EXISTS idx_deleted_likes_deleted_at ON deleted_likes(deleted_at);

    -- 管理ページで設定する「使用不可CMD」
    CREATE TABLE IF NOT EXISTS disabled_cmds (
      cmd        INT     PRIMARY KEY,
      created_at BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

    -- 運営おすすめコース（CMD=3で返す）。コースが削除されたら自動で外れる
    CREATE TABLE IF NOT EXISTS recommended_courses (
      course_id  TEXT    PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
      added_at   BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_recommended_added ON recommended_courses(added_at DESC);

    -- メンテナンス用の特別ユーザー名（id=1の1行しか持てない＝常に最大1つ）
    CREATE TABLE IF NOT EXISTS bypass_username (
      id         INT     PRIMARY KEY CHECK (id = 1),
      username   TEXT    NOT NULL,
      issued_at  BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
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

// ─────────────────────────────────────────────
// コース保存
// ─────────────────────────────────────────────
async function saveCourse(title, author, username, stageData, ipAddress = null) {
  const { rows: dupRows } = await pool.query(
    "SELECT 1 FROM courses WHERE stage_data=$1", [stageData]
  );
  if (dupRows.length) return { duplicate: true };

  // 1職人あたり最大100コースまで
  const MAX_COURSES_PER_AUTHOR = 100;
  const { rows: authorCountRows } = await pool.query(
    "SELECT COUNT(*) FROM courses WHERE author=$1", [author]
  );
  if (parseInt(authorCountRows[0].count, 10) >= MAX_COURSES_PER_AUTHOR) {
    return { limitReached: true };
  }

  const postedAt = minutesSince2000();

  const { rows: lastRows } = await pool.query(
    "SELECT posted_at FROM courses WHERE author=$1 ORDER BY posted_at DESC LIMIT 1",
    [author]
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
    [id, title, author, username, stageData, postedAt, ipAddress || null, red]
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
    `SELECT ${INFO_COLS} FROM courses ORDER BY RANDOM() LIMIT $1`, [limit]
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

// CMD=3: 運営おすすめコース（おすすめに追加した日時が新しい順）
async function getRecommendedCourses(limit) {
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.author, c.like_count, c.play_count,
            c.attempt_count, c.clear_count, c.posted_at, c.red
     FROM recommended_courses r
     JOIN courses c ON c.id = r.course_id
     ORDER BY r.added_at ASC
     LIMIT $1`,
    [limit]
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
// excludeUsername を渡すと、そのユーザー名が投稿したコース（courses.username が一致）には加算しない。
// （自作コースを自分で遊んだぶんをカウントしないため。判定は1回のUPDATEで行う）
async function incrementPlay(courseId, excludeUsername = null) {
  await pool.query(
    "UPDATE courses SET play_count=play_count+1 WHERE id=$1 AND ($2::text IS NULL OR username <> $2::text)",
    [courseId, excludeUsername]
  );
}

async function incrementAttempt(courseId, excludeUsername = null) {
  await pool.query(
    "UPDATE courses SET attempt_count=attempt_count+1 WHERE id=$1 AND ($2::text IS NULL OR username <> $2::text)",
    [courseId, excludeUsername]
  );
}

async function incrementClear(courseId, excludeUsername = null) {
  await pool.query(
    "UPDATE courses SET clear_count=clear_count+1 WHERE id=$1 AND ($2::text IS NULL OR username <> $2::text)",
    [courseId, excludeUsername]
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

const LIKE_FRAUD_BURST_GAP_SECONDS       = 300;  // この秒数以内の間隔で連続していれば同じ"塊(バースト)"とみなす
const LIKE_FRAUD_MIN_BURST_SIZE          = 12;    // 通常、1つの塊がこの件数以上なら不正とみなす
const LIKE_FRAUD_SUSPICIOUS_MIN_SIZE     = 6;    // 使い捨てユーザー名比率が高い場合、この件数まで閾値を下げる
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
    "SELECT COUNT(*) FROM like_fraud_incidents WHERE author=$1 AND detected_at >= $2 AND action IN ('trim','reset_and_ban')",
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
     WHERE created_at >= $1 AND NOT protected
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
    const backupIds = (await backupLikes(pool, ids, "burst")).map(b => b.id);
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

      const { rows: incRows } = await pool.query(
        `INSERT INTO like_fraud_incidents
           (course_id, author, removed_count, action, disposable_ratio, prior_incident_count, ban_days)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [courseId, author, size, "reset_and_ban", finalDisposableRatio, priorCount, banDays]
      );
      await linkBackupsToIncident(incRows[0].id, backupIds);
      results.push({ courseId, author, removedCount: size, action: "reset_and_ban", priorCount, banDays });
    } else {
      // 通常の不正: 不正分だけ差し引く
      await pool.query(
        "UPDATE courses SET like_count = GREATEST(like_count - $1, 0) WHERE id=$2",
        [size, courseId]
      );
      const { rows: incRows } = await pool.query(
        `INSERT INTO like_fraud_incidents
           (course_id, author, removed_count, action, disposable_ratio, prior_incident_count)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [courseId, author, size, "trim", finalDisposableRatio, priorCount]
      );
      await linkBackupsToIncident(incRows[0].id, backupIds);
      results.push({ courseId, author, removedCount: size, action: "trim", priorCount, banDays: null });
    }
  }

  return results;
}

/** 不正いいね検知の履歴一覧（管理ページ表示用） */
async function listLikeFraudIncidents(limit = 100) {
  const { rows } = await pool.query(
    `SELECT i.id, i.course_id, i.author, i.removed_count, i.action, i.disposable_ratio, i.prior_incident_count, i.ban_days, i.detected_at,
            (SELECT COUNT(*) FROM deleted_likes d WHERE d.incident_id = i.id)                  AS backup_count,
            (SELECT COUNT(*) FROM deleted_likes d WHERE d.incident_id = i.id AND d.restored)   AS restored_count
     FROM like_fraud_incidents i ORDER BY i.detected_at DESC LIMIT $1`,
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

/**
 * DM（chat_dm）を全件削除する。あわせてDMの既読位置（chat_dm_reads）も削除する。
 * 全体チャット（chat_messages）には一切触れない。
 */
async function deleteAllDMs() {
  const { rowCount: dmCount } = await pool.query("DELETE FROM chat_dm");
  await pool.query("DELETE FROM chat_dm_reads");
  console.log(`🗑️ DMを全件削除しました（${dmCount}件）`);
  return { deletedDMs: dmCount };
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

// ─────────────────────────────────────────────
// 使用不可CMD（管理ページで設定）
// リクエストごとにDBを叩かないよう、短時間キャッシュする
// ─────────────────────────────────────────────
const DISABLED_CMD_CACHE_MS = 5000;
let disabledCmdCache = { set: new Set(), loadedAt: 0 };

async function getDisabledCmdSet() {
  const now = Date.now();
  if (now - disabledCmdCache.loadedAt < DISABLED_CMD_CACHE_MS) return disabledCmdCache.set;
  try {
    const { rows } = await pool.query("SELECT cmd FROM disabled_cmds");
    disabledCmdCache = { set: new Set(rows.map(r => r.cmd)), loadedAt: now };
  } catch (e) {
    // DB障害時は直前のキャッシュで動かし続ける（全CMDが止まるのを防ぐ）
    console.error("使用不可CMD取得失敗:", e.message);
  }
  return disabledCmdCache.set;
}

async function isCmdDisabled(cmd) {
  return (await getDisabledCmdSet()).has(cmd);
}

async function listDisabledCmds() {
  const { rows } = await pool.query("SELECT cmd FROM disabled_cmds ORDER BY cmd ASC");
  return rows.map(r => r.cmd);
}

async function addDisabledCmd(cmd) {
  await pool.query(
    "INSERT INTO disabled_cmds (cmd) VALUES ($1) ON CONFLICT (cmd) DO NOTHING", [cmd]
  );
  disabledCmdCache.loadedAt = 0; // 即時反映
}

async function removeDisabledCmd(cmd) {
  const { rowCount } = await pool.query("DELETE FROM disabled_cmds WHERE cmd=$1", [cmd]);
  disabledCmdCache.loadedAt = 0;
  return rowCount > 0;
}

// ─────────────────────────────────────────────
// メンテナンス用 特別ユーザー名
// 使用不可CMDがあっても、このユーザー名からのリクエストは全CMD使用可能にする。
// 10文字の英小文字+数字（クライアントのalphabetエンコードが小文字のみ対応のため）。
// 常に最大1つ。再発行すると前のものは上書きされて無効になる。
// ─────────────────────────────────────────────
const BYPASS_USERNAME_LENGTH = 10;
const BYPASS_USERNAME_CHARS  = "abcdefghijklmnopqrstuvwxyz0123456789";
const BYPASS_CACHE_MS = 5000;
let bypassCache = { info: null, loadedAt: 0 };

function generateBypassUsername() {
  let s = "";
  for (let i = 0; i < BYPASS_USERNAME_LENGTH; i++) {
    s += BYPASS_USERNAME_CHARS[crypto.randomInt(BYPASS_USERNAME_CHARS.length)];
  }
  return s;
}

/** 現在の特別ユーザー名情報 { username, issued_at } を返す（なければ null）。5秒キャッシュ。 */
async function getBypassInfo() {
  const now = Date.now();
  if (now - bypassCache.loadedAt < BYPASS_CACHE_MS) return bypassCache.info;
  try {
    const { rows } = await pool.query("SELECT username, issued_at FROM bypass_username WHERE id=1");
    bypassCache = {
      info: rows[0] ? { username: rows[0].username, issued_at: parseInt(rows[0].issued_at, 10) } : null,
      loadedAt: now,
    };
  } catch (e) {
    // DB障害時は直前のキャッシュで動かし続ける
    console.error("特別ユーザー名取得失敗:", e.message);
  }
  return bypassCache.info;
}

async function getBypassUsername() {
  const info = await getBypassInfo();
  return info ? info.username : null;
}

/** 特別ユーザー名を発行（再発行）する。前のユーザー名は上書きされて使えなくなる。 */
async function issueBypassUsername() {
  const username = generateBypassUsername();
  const { rows } = await pool.query(
    `INSERT INTO bypass_username (id, username, issued_at)
     VALUES (1, $1, EXTRACT(EPOCH FROM NOW())::BIGINT)
     ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, issued_at = EXCLUDED.issued_at
     RETURNING username, issued_at`,
    [username]
  );
  bypassCache = { info: null, loadedAt: 0 }; // 即時反映
  return { username: rows[0].username, issued_at: parseInt(rows[0].issued_at, 10) };
}

/** 特別ユーザー名を削除する（メンテナンス終了時など） */
async function clearBypassUsername() {
  const { rowCount } = await pool.query("DELETE FROM bypass_username WHERE id=1");
  bypassCache = { info: null, loadedAt: 0 };
  return rowCount > 0;
}

// ─────────────────────────────────────────────
// 使い捨てユーザーが多いコースの一覧（管理ページ表示用）
// 「使い捨てユーザー」= likesテーブル内で、いいね履歴がそのコースへの1件だけのusername
// （不正いいね検知のcalcDisposableUsernameRatioと同じ定義）。
// ※likesテーブルは7日より古いものが削除されるため、集計対象は直近約7日分。
// ─────────────────────────────────────────────
async function listCoursesByDisposableLikers(limit = 50) {
  const { rows } = await pool.query(
    `WITH user_counts AS (
       SELECT username, COUNT(*) AS cnt FROM likes GROUP BY username
     )
     SELECT l.course_id,
            c.title,
            c.author,
            c.like_count,
            COUNT(*)                                  AS likes_in_table,
            COUNT(*) FILTER (WHERE uc.cnt = 1)        AS disposable_count
     FROM likes l
     JOIN user_counts uc ON uc.username = l.username
     JOIN courses c      ON c.id = l.course_id
     GROUP BY l.course_id, c.title, c.author, c.like_count
     HAVING COUNT(*) FILTER (WHERE uc.cnt = 1) > 0
     ORDER BY disposable_count DESC, likes_in_table DESC
     LIMIT $1`,
    [limit]
  );
  return rows.map(r => {
    const likesInTable = parseInt(r.likes_in_table, 10);
    const disposable   = parseInt(r.disposable_count, 10);
    return {
      course_id: r.course_id,
      title: r.title,
      author: r.author,
      like_count: r.like_count,
      likes_in_table: likesInTable,
      disposable_count: disposable,
      disposable_ratio: likesInTable > 0 ? disposable / likesInTable : 0,
    };
  });
}

// ─────────────────────────────────────────────
// 職人ごとの「いいねしているユーザー名」集計（管理ページ表示用）
// 同じユーザーが同じ職人の複数コースにいいねしていても、その職人に対しては1人とカウントする。
// ※likesテーブルは約7日分しか保持されないため、集計対象は直近約7日分。
// ─────────────────────────────────────────────

/**
 * 職人ごとに、いいねしたユーザー名の人数(重複なし)を集計する。人数の多い順。
 * total_pairs は「職人×ユーザー名」の組み合わせ総数（=各職人のuser_countの合計）。
 */
async function listAuthorLikerSummary(limit = 50) {
  const { rows } = await pool.query(
    `SELECT c.author,
            COUNT(DISTINCT l.username)  AS user_count,
            COUNT(DISTINCT l.course_id) AS course_count,
            COUNT(*)                    AS like_count
     FROM likes l
     JOIN courses c ON c.id = l.course_id
     GROUP BY c.author
     ORDER BY user_count DESC, like_count DESC
     LIMIT $1`,
    [limit]
  );
  const { rows: totalRows } = await pool.query(
    `SELECT COUNT(*) AS total_pairs FROM (
       SELECT DISTINCT c.author, l.username
       FROM likes l JOIN courses c ON c.id = l.course_id
     ) t`
  );
  return {
    authors: rows.map(r => ({
      author: r.author,
      user_count: parseInt(r.user_count, 10),
      course_count: parseInt(r.course_count, 10),
      like_count: parseInt(r.like_count, 10),
    })),
    total_pairs: parseInt(totalRows[0].total_pairs, 10),
  };
}

/**
 * 指定した職人のコースにいいねしているユーザー名の一覧（いいねしたコース数の多い順）。
 * 各ユーザー名について以下も返す:
 *  - is_disposable: 使い捨てユーザー名か（likesテーブル全体でいいね履歴が1件だけ）
 *  - posted_authors: そのユーザー名でコースを投稿している場合に使っている職人名（なければ空配列）
 *    ※現在DBに残っているコースのみが対象（削除済みコースの履歴は残らない）
 */
async function listLikersForAuthor(author, limit = 500) {
  const { rows } = await pool.query(
    `WITH likers AS (
       SELECT l.username,
              COUNT(DISTINCT l.course_id) AS course_count,
              MAX(l.created_at)           AS last_liked_at
       FROM likes l
       JOIN courses c ON c.id = l.course_id
       WHERE c.author = $1
       GROUP BY l.username
       ORDER BY course_count DESC, last_liked_at DESC
       LIMIT $2
     )
     SELECT k.username, k.course_count, k.last_liked_at,
            (SELECT COUNT(*) FROM likes x WHERE x.username = k.username) AS total_likes,
            (SELECT COALESCE(array_agg(DISTINCT c2.author ORDER BY c2.author), '{}')
               FROM courses c2 WHERE c2.username = k.username)            AS posted_authors,
            (SELECT COALESCE(array_agg(DISTINCT cu.author ORDER BY cu.author), '{}')
               FROM courses cu
               JOIN courses cv ON cv.author = cu.author AND cv.username <> cu.username
               JOIN courses co ON co.username = cv.username AND co.author = $1
              WHERE cu.username = k.username AND cu.author <> $1)             AS linked_via
     FROM likers k
     ORDER BY k.course_count DESC, k.last_liked_at DESC`,
    [author, limit]
  );
  return rows.map(r => ({
    username: r.username,
    course_count: parseInt(r.course_count, 10),
    last_liked_at: parseInt(r.last_liked_at, 10),
    total_likes: parseInt(r.total_likes, 10),
    is_disposable: parseInt(r.total_likes, 10) === 1,
    posted_authors: r.posted_authors || [],
    // 持ち主と共通で投稿している職人名（関連ユーザー判定の根拠）
    linked_via: r.linked_via || [],
    linked_to_owner: (r.linked_via || []).length >= AUTO_LINK_MIN_SHARED_AUTHORS,
  }));
}

// 「関連ユーザー」判定: いいねしたユーザー名Uが、その職人Aの持ち主（Aの名前でコースを投稿したユーザー名V、U以外）と
// 「共通の職人名B（A以外）」で投稿していれば、UはAの持ち主と同一人物・グループの可能性が高いとみなす。
// 共通の職人名が何個以上あれば関連とみなすか（1なら共通の職人名が1つでもあれば関連）
const AUTO_LINK_MIN_SHARED_AUTHORS = 1;

/**
 * 指定した職人のコースについた「不正分」のいいねを手動で削除する（管理ページ用）。
 * 削除対象:
 *   ① その職人名で投稿したことがあるユーザー名からのいいね（自作自演）
 *   ② どの職人名でも投稿履歴がない（coursesに一度も現れない）ユーザー名からのいいね
 *   ③ 関連ユーザー: その職人名の持ち主と、共通の職人名で投稿しているユーザー名からのいいね
 * 削除したぶん、該当コースの courses.like_count も同じ件数だけ減らす（0未満にはしない）。
 * dryRun=true のときは件数だけ返し、何も削除しない。
 * onlyUsername を渡すと、そのユーザー名のいいねだけを対象にする（ユーザー名ごとの削除）。
 *   その場合も、そのユーザー名が上の①②のどちらにも当てはまらなければ何も削除されない（removed_count=0）。
 * ※対象はlikesテーブルに残っているいいね（約7日分）のみ。
 * ※投稿履歴は現在DBに残っているコースから判定する（削除済みコースの履歴は残らない）。
 */
async function purgeSuspiciousLikesForAuthor(author, dryRun = false, onlyUsername = null, includeNoHistory = true, options = {}) {
  // options.source を指定したとき（自動削除）だけ、削除前にバックアップを取る。skipProtected=true なら復元済みいいねは対象外
  const { source = null, skipProtected = false } = options;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT l.id, l.course_id, l.username,
              EXISTS (SELECT 1 FROM courses o WHERE o.author = $1 AND o.username = l.username) AS posted_as_author,
              NOT EXISTS (SELECT 1 FROM courses p WHERE p.username = l.username)               AS no_post_history,
              (SELECT COUNT(DISTINCT cu.author)
                 FROM courses cu
                 JOIN courses cv ON cv.author = cu.author AND cv.username <> cu.username
                 JOIN courses co ON co.username = cv.username AND co.author = $1
                WHERE cu.username = l.username AND cu.author <> $1) >= $3::int AS linked_to_owner
       FROM likes l
       JOIN courses c ON c.id = l.course_id
       WHERE c.author = $1
         AND ($2::text IS NULL OR l.username = $2::text)
         AND (NOT $4::boolean OR NOT l.protected)`,
      [author, onlyUsername, AUTO_LINK_MIN_SHARED_AUTHORS, skipProtected]
    );
    // includeNoHistory=false のときは、②（投稿履歴のないユーザー名）を削除対象にしない（自動削除用）
    const targets = rows.filter(r => r.posted_as_author || r.linked_to_owner || (includeNoHistory && r.no_post_history));

    const stats = {
      author,
      username: onlyUsername,
      dry_run: dryRun,
      total_likes: rows.length,                                              // この職人のコースについているいいね(likesテーブル内)
      removed_count: targets.length,                                         // 削除対象(削除した)件数
      posted_as_author_count: targets.filter(r => r.posted_as_author).length, // ①の件数
      linked_count: targets.filter(r => !r.posted_as_author && r.linked_to_owner).length, // ③の件数
      no_history_count: targets.filter(r => !r.posted_as_author && !r.linked_to_owner).length, // ②の件数
      user_count: new Set(targets.map(r => r.username)).size,
      course_count: new Set(targets.map(r => r.course_id)).size,
    };

    let backupIds = [];
    if (!dryRun && targets.length > 0) {
      if (source) backupIds = (await backupLikes(client, targets.map(r => r.id), source)).map(b => b.id);
      await client.query("DELETE FROM likes WHERE id = ANY($1::int[])", [targets.map(r => r.id)]);

      const perCourse = new Map();
      for (const t of targets) perCourse.set(t.course_id, (perCourse.get(t.course_id) || 0) + 1);
      await client.query(
        `UPDATE courses c
         SET like_count = GREATEST(c.like_count - d.n, 0)
         FROM (SELECT unnest($1::text[]) AS id, unnest($2::int[]) AS n) d
         WHERE c.id = d.id`,
        [[...perCourse.keys()], [...perCourse.values()]]
      );
    }

    stats.backup_ids = backupIds;
    await client.query("COMMIT");
    return stats;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────
// 不正分いいねの自動削除（職人単位）
// 「不正判定ユーザー名」（①その職人名で投稿履歴のあるユーザー名、③その職人名の持ち主と共通の職人名で投稿している関連ユーザー名）の
// いいねについて、以下のどちらかを満たした職人を不正と判定し、
// 管理ページの「この職人の不正分いいねを削除」と同じ処理（①②とも削除）を自動実行する。
// ※不正の判定には、投稿履歴のないユーザー名の数・いいね数は一切使わない。
//   ① 不正判定ユーザー名が、いいねしたユーザーの中に3つ以上いる
//   ② 不正判定ユーザー名からの、いいね総数(likesテーブル内)が6を超えている
// 削除が行われたら like_fraud_incidents（管理ページの検知履歴）に記録する。
// さらに、繰り返し検知された職人には以下の措置を取る。
//   ・全コースのいいね数・プレイ数を0にリセット（likesテーブルの該当いいねも削除）
//   ・職人登録(maker_accounts)を 'pending' に戻し、チャットのセッションも無効化
// 「繰り返し」= 過去AUTO_PURGE_REPEAT_WINDOW_DAYS日の間に、検知された日(JST)が
//   AUTO_PURGE_ESCALATE_DAYS日以上（今回の日を含む）。同じ日に何回検知されても1日と数える。
// ─────────────────────────────────────────────
const AUTO_PURGE_POSTED_USERNAME_THRESHOLD = 3;  // ①の閾値（以上）
const AUTO_PURGE_TOTAL_LIKES_THRESHOLD     = 6;  // ②の閾値（超えたら）
const AUTO_PURGE_REPEAT_WINDOW_DAYS        = 30; // 繰り返し判定の対象期間（日）
const AUTO_PURGE_ESCALATE_DAYS             = 3;  // この日数以上検知されたら強い措置を取る
const AUTO_PURGE_ACTION        = "auto_purge";        // 履歴のaction: 不正分の削除のみ
const AUTO_PURGE_RESET_ACTION  = "auto_purge_reset";  // 履歴のaction: 削除＋リセット＋pending化
const AUTO_PURGE_COURSE_LABEL  = "(職人単位)";         // 履歴のcourse_id（職人単位の処理のため）

/** 過去AUTO_PURGE_REPEAT_WINDOW_DAYS日以内に、自動削除が検知された「日数」(JST、重複日は1日)を数える */
async function countAutoPurgeIncidentDays(author) {
  const since = Math.floor(Date.now() / 1000) - AUTO_PURGE_REPEAT_WINDOW_DAYS * 24 * 60 * 60;
  const { rows } = await pool.query(
    `SELECT COUNT(DISTINCT (to_timestamp(detected_at) AT TIME ZONE 'Asia/Tokyo')::date) AS days
     FROM like_fraud_incidents
     WHERE author = $1 AND action IN ($2, $3) AND detected_at >= $4`,
    [author, AUTO_PURGE_ACTION, AUTO_PURGE_RESET_ACTION, since]
  );
  return parseInt(rows[0].days, 10);
}

/**
 * 繰り返し検知された職人への措置（1トランザクション）:
 *   ① その職人の全コースの like_count / play_count を0にし、likesテーブルの該当いいねも削除する
 *   ② maker_accounts の本登録(confirmed)を 'pending' に戻す（職人名が使えなくなる）
 *   ③ その職人のチャットセッションを削除する
 */
async function resetAuthorAndRevoke(author) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rowCount: likesDeleted } = await client.query(
      "DELETE FROM likes WHERE course_id IN (SELECT id FROM courses WHERE author = $1)", [author]
    );
    const { rowCount: coursesReset } = await client.query(
      "UPDATE courses SET like_count = 0, play_count = 0 WHERE author = $1", [author]
    );
    const { rowCount: accountsRevoked } = await client.query(
      "UPDATE maker_accounts SET status = 'pending' WHERE author = $1 AND status = 'confirmed'", [author]
    );
    await client.query("DELETE FROM chat_sessions WHERE author = $1", [author]);
    await client.query("COMMIT");
    return { likesDeleted, coursesReset, accountsRevoked };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function autoPurgeSuspiciousLikes() {
  const { rows } = await pool.query(
    `WITH l2 AS (
       SELECT c.author, l.username,
              EXISTS (
                SELECT 1 FROM courses o
                WHERE o.author = c.author AND o.username = l.username
              ) AS posted_as_author,
              (SELECT COUNT(DISTINCT cu.author)
                 FROM courses cu
                 JOIN courses cv ON cv.author = cu.author AND cv.username <> cu.username
                 JOIN courses co ON co.username = cv.username AND co.author = c.author
                WHERE cu.username = l.username AND cu.author <> c.author) >= $3::int AS linked_to_owner
       FROM likes l
       JOIN courses c ON c.id = l.course_id
       WHERE NOT l.protected
     )
     SELECT author,
            COUNT(*) FILTER (WHERE posted_as_author OR linked_to_owner)                 AS suspicious_like_count,
            COUNT(DISTINCT username) FILTER (WHERE posted_as_author OR linked_to_owner) AS suspicious_username_count,
            COUNT(DISTINCT username) FILTER (WHERE posted_as_author)                    AS posted_username_count,
            COUNT(DISTINCT username) FILTER (WHERE linked_to_owner AND NOT posted_as_author) AS linked_username_count
     FROM l2
     GROUP BY author
     HAVING COUNT(*) FILTER (WHERE posted_as_author OR linked_to_owner) > $1
         OR COUNT(DISTINCT username) FILTER (WHERE posted_as_author OR linked_to_owner) >= $2`,
    [AUTO_PURGE_TOTAL_LIKES_THRESHOLD, AUTO_PURGE_POSTED_USERNAME_THRESHOLD, AUTO_LINK_MIN_SHARED_AUTHORS]
  );

  const results = [];
  for (const r of rows) {
    try {
      const priorDays = await countAutoPurgeIncidentDays(r.author);
      // 不正と判定した後の削除は、手動ボタンと同じ（①投稿履歴ありユーザー名 と ②投稿履歴なしユーザー名 の両方）
      const stats = await purgeSuspiciousLikesForAuthor(r.author, false, null, true, { source: AUTO_PURGE_ACTION, skipProtected: true });
      if (stats.removed_count <= 0) continue;

      // 検知履歴に保存する
      const { rows: ins } = await pool.query(
        `INSERT INTO like_fraud_incidents
           (course_id, author, removed_count, action, disposable_ratio, prior_incident_count)
         VALUES ($1, $2, $3, $4, NULL, $5)
         RETURNING id`,
        [AUTO_PURGE_COURSE_LABEL, r.author, stats.removed_count, AUTO_PURGE_ACTION, priorDays]
      );
      const incidentId = ins[0].id;
      await linkBackupsToIncident(incidentId, stats.backup_ids); // 復元できるよう、削除したいいねを履歴に紐付ける

      // 繰り返し検知された職人には、全コースのいいね・プレイ数リセットと職人名のpending化を行う
      let escalation = null;
      const days = await countAutoPurgeIncidentDays(r.author); // 今回の記録を含む
      if (days >= AUTO_PURGE_ESCALATE_DAYS) {
        escalation = await resetAuthorAndRevoke(r.author);
        await pool.query(
          "UPDATE like_fraud_incidents SET action = $1 WHERE id = $2",
          [AUTO_PURGE_RESET_ACTION, incidentId]
        );
      }

      results.push({
        author: r.author,
        removedCount: stats.removed_count,
        postedAsAuthorCount: stats.posted_as_author_count,
        noHistoryCount: stats.no_history_count,
        linkedCount: stats.linked_count,
        postedUsernameCount: parseInt(r.posted_username_count, 10),
        linkedUsernameCount: parseInt(r.linked_username_count, 10),
        suspiciousUsernameCount: parseInt(r.suspicious_username_count, 10),
        suspiciousLikeCount: parseInt(r.suspicious_like_count, 10),
        incidentDays: days,
        escalated: !!escalation,
        escalation,
      });
    } catch (e) {
      console.error(`不正分いいね自動削除失敗 (author=${r.author}):`, e.message);
    }
  }
  return results;
}

// ─────────────────────────────────────────────
// 重複いいねの自動削除
// 同じコースに、「共通の職人名で投稿しているユーザー名」が2つ以上いいねしている場合
// （同一人物・グループが複数のユーザー名で同じコースにいいねしているとみなす）、
// そのコースについた該当ユーザー名のいいねを削除し、courses.like_count も同じ件数だけ減らす。
// 片方のユーザー名しかいいねしていないコースのいいねは削除しない。
// ─────────────────────────────────────────────
const AUTO_DUP_MIN_SHARED_AUTHORS = 1;              // 共通の職人名が何個以上あれば同一人物とみなすか
const AUTO_DUP_ACTION             = "auto_dup_like"; // 検知履歴のaction
const AUTO_DUP_COURSE_LABEL       = "(重複いいね)";   // 検知履歴のcourse_id（職人単位の記録のため）

/**
 * 重複いいねを削除する。onlyAuthor を渡すとその職人のコースだけを対象にする。
 * dryRun=true のときは件数だけ返し、何も削除しない。
 * 戻り値: { dry_run, removed_count, authors: [{ author, removed_count, course_count, user_count }] }
 */
async function purgeDuplicateLikes(dryRun = false, onlyAuthor = null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT l1.id, l1.course_id, l1.username, c.author
       FROM likes l1
       JOIN courses c ON c.id = l1.course_id
       WHERE ($2::text IS NULL OR c.author = $2::text)
         AND NOT l1.protected
         AND EXISTS (
           SELECT 1 FROM likes l2
           WHERE l2.course_id = l1.course_id
             AND l2.username <> l1.username
             AND NOT l2.protected
             AND (SELECT COUNT(DISTINCT p1.author)
                    FROM courses p1
                    JOIN courses p2 ON p2.author = p1.author
                   WHERE p1.username = l1.username AND p2.username = l2.username) >= $1::int
         )`,
      [AUTO_DUP_MIN_SHARED_AUTHORS, onlyAuthor]
    );

    const byAuthor = new Map();
    for (const r of rows) {
      if (!byAuthor.has(r.author)) byAuthor.set(r.author, { author: r.author, removed_count: 0, courses: new Set(), users: new Set(), backup_ids: [] });
      const a = byAuthor.get(r.author);
      a.removed_count++;
      a.courses.add(r.course_id);
      a.users.add(r.username);
    }

    if (!dryRun && rows.length > 0) {
      const backups = await backupLikes(client, rows.map(r => r.id), AUTO_DUP_ACTION);
      for (const b of backups) { const a = byAuthor.get(b.author); if (a) a.backup_ids.push(b.id); }
      await client.query("DELETE FROM likes WHERE id = ANY($1::int[])", [rows.map(r => r.id)]);
      const perCourse = new Map();
      for (const r of rows) perCourse.set(r.course_id, (perCourse.get(r.course_id) || 0) + 1);
      await client.query(
        `UPDATE courses c
         SET like_count = GREATEST(c.like_count - d.n, 0)
         FROM (SELECT unnest($1::text[]) AS id, unnest($2::int[]) AS n) d
         WHERE c.id = d.id`,
        [[...perCourse.keys()], [...perCourse.values()]]
      );
    }

    await client.query("COMMIT");
    return {
      dry_run: dryRun,
      removed_count: rows.length,
      authors: [...byAuthor.values()].map(a => ({
        author: a.author, removed_count: a.removed_count,
        course_count: a.courses.size, user_count: a.users.size,
        backup_ids: a.backup_ids,
      })),
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** 重複いいねを削除し、職人ごとに検知履歴(like_fraud_incidents)へ記録する */
async function autoPurgeDuplicateLikes() {
  const result = await purgeDuplicateLikes(false, null);
  const out = [];
  for (const a of result.authors) {
    try {
      const { rows: ins } = await pool.query(
        `INSERT INTO like_fraud_incidents
           (course_id, author, removed_count, action, disposable_ratio, prior_incident_count)
         VALUES ($1, $2, $3, $4, NULL, 0)
         RETURNING id`,
        [AUTO_DUP_COURSE_LABEL, a.author, a.removed_count, AUTO_DUP_ACTION]
      );
      await linkBackupsToIncident(ins[0].id, a.backup_ids);
    } catch (e) {
      console.error(`重複いいね検知履歴の保存失敗 (author=${a.author}):`, e.message);
    }
    out.push({ author: a.author, removedCount: a.removed_count, courseCount: a.course_count, userCount: a.user_count });
  }
  return out;
}

// ─────────────────────────────────────────────
// 自動削除したいいねのバックアップと復元
// 自動削除（バースト検知 / 不正分いいね / 重複いいね）で消すいいねは、削除前に deleted_likes へ保存し、
// 検知履歴(like_fraud_incidents)に紐付ける。管理ページの検知履歴から、履歴ごと・ユーザー名ごとに復元できる。
// 復元したいいねは likes.protected = TRUE にし、以後の自動検知・自動削除の対象から外す（再び消されないように）。
// ※職人への措置（全コースのいいね/プレイ数リセット・pending化）自体は、ここでは元に戻さない。
// ─────────────────────────────────────────────

/** 削除予定のいいね(likes.id の配列)を deleted_likes に保存し、[{id, author}] を返す。q は pool か client */
async function backupLikes(q, likeIds, source) {
  if (!likeIds.length) return [];
  const { rows } = await q.query(
    `INSERT INTO deleted_likes (author, course_id, username, liked_at, source)
     SELECT c.author, l.course_id, l.username, l.created_at, $2
     FROM likes l
     JOIN courses c ON c.id = l.course_id
     WHERE l.id = ANY($1::int[])
     RETURNING id, author`,
    [likeIds, source]
  );
  return rows;
}

/** バックアップ行を検知履歴に紐付ける */
async function linkBackupsToIncident(incidentId, backupIds) {
  if (!backupIds || !backupIds.length) return;
  await pool.query("UPDATE deleted_likes SET incident_id = $1 WHERE id = ANY($2::int[])", [incidentId, backupIds]);
}

/** 検知履歴1件ぶんの削除いいねを、ユーザー名ごとに集計して返す（管理ページの内訳表示用） */
async function listIncidentDeletedLikes(incidentId) {
  const { rows } = await pool.query(
    `SELECT username,
            COUNT(*)                          AS total,
            COUNT(*) FILTER (WHERE restored)  AS restored,
            COUNT(DISTINCT course_id)         AS courses
     FROM deleted_likes
     WHERE incident_id = $1
     GROUP BY username
     ORDER BY total DESC, username`,
    [incidentId]
  );
  return rows.map(r => ({
    username: r.username,
    total: parseInt(r.total, 10),
    restored: parseInt(r.restored, 10),
    courses: parseInt(r.courses, 10),
  }));
}

/**
 * 検知履歴の削除いいねを復元する。username を渡すとそのユーザー名のぶんだけ復元する。
 *  - likes に元のいいね(created_atも元のまま)を戻し、protected=TRUE にする
 *  - 戻したぶんだけ courses.like_count を増やす
 *  - 既に同じいいねがある（削除後に押し直された）場合・コースが削除済みの場合は戻さない
 */
async function restoreDeletedLikes(incidentId, username = null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT d.id, d.course_id, d.username, d.liked_at,
              EXISTS (SELECT 1 FROM courses c WHERE c.id = d.course_id) AS course_exists
       FROM deleted_likes d
       WHERE d.incident_id = $1 AND NOT d.restored
         AND ($2::text IS NULL OR d.username = $2::text)
       FOR UPDATE OF d`,
      [incidentId, username]
    );
    const restorable = rows.filter(r => r.course_exists);
    let insertedCount = 0;
    if (restorable.length > 0) {
      const ins = await client.query(
        `INSERT INTO likes (username, course_id, created_at, protected)
         SELECT x.u, x.c, x.t, TRUE
         FROM unnest($1::text[], $2::text[], $3::bigint[]) AS x(u, c, t)
         ON CONFLICT (username, course_id) DO NOTHING
         RETURNING course_id`,
        [restorable.map(r => r.username), restorable.map(r => r.course_id), restorable.map(r => r.liked_at)]
      );
      insertedCount = ins.rows.length;
      const perCourse = new Map();
      for (const r of ins.rows) perCourse.set(r.course_id, (perCourse.get(r.course_id) || 0) + 1);
      if (perCourse.size > 0) {
        await client.query(
          `UPDATE courses c
           SET like_count = c.like_count + d.n
           FROM (SELECT unnest($1::text[]) AS id, unnest($2::int[]) AS n) d
           WHERE c.id = d.id`,
          [[...perCourse.keys()], [...perCourse.values()]]
        );
      }
      await client.query(
        "UPDATE deleted_likes SET restored = TRUE, restored_at = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id = ANY($1::int[])",
        [restorable.map(r => r.id)]
      );
    }
    await client.query("COMMIT");
    return {
      restored_count: insertedCount,                              // 実際に戻したいいね数
      already_exists_count: restorable.length - insertedCount,    // 既に同じいいねがあったため戻さなかった数
      missing_course_count: rows.length - restorable.length,      // コースが削除済みで戻せなかった数
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** 古いバックアップを削除する（DB容量対策。復元できる期間 = retentionDays） */
async function cleanupOldDeletedLikes(retentionDays = 30) {
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 24 * 60 * 60;
  const { rowCount } = await pool.query("DELETE FROM deleted_likes WHERE deleted_at < $1", [cutoff]);
  if (rowCount > 0) console.log(`🗑️ 古い削除いいねのバックアップを ${rowCount} 件削除しました`);
}

// ─────────────────────────────────────────────
// CMD=90 用の統計: 最大同接数 / 週間アクティブユーザー / 登録職人数
// ─────────────────────────────────────────────

// ── 最大同接数 ──
// 「同接数」は、直近5分以内にリクエストしたユーザー名の数（CMD=90のオンライン数と同じ定義）。
// ユーザーが増える瞬間(trackUser)にだけ最大値を更新する。サーバーを再起動しても消えないようDBにも保存する。
//   ・全期間の最大 : online_peaks の scope='all'
//   ・営業日の最大 : online_peaks の scope=営業日('YYYY-MM-DD')。営業日は 6:00〜翌1:00
const peakState = { all: 0, day: null, dayValue: 0 };

async function getOnlinePeak(scope) {
  const { rows } = await pool.query("SELECT peak FROM online_peaks WHERE scope=$1", [scope]);
  return rows.length ? rows[0].peak : 0;
}

async function recordOnlinePeak(scope, value) {
  await pool.query(
    `INSERT INTO online_peaks (scope, peak, peak_at) VALUES ($1, $2, EXTRACT(EPOCH FROM NOW())::BIGINT)
     ON CONFLICT (scope) DO UPDATE SET
       peak    = GREATEST(online_peaks.peak, EXCLUDED.peak),
       peak_at = CASE WHEN EXCLUDED.peak > online_peaks.peak THEN EXCLUDED.peak_at ELSE online_peaks.peak_at END`,
    [scope, value]
  );
}

/** 起動時に、DBに保存されている最大同接数をメモリへ読み込む */
async function loadOnlinePeaks() {
  peakState.all = await getOnlinePeak("all");
  const bd = getBusinessDayForRecording();
  if (bd) {
    peakState.day = bd;
    peakState.dayValue = await getOnlinePeak(bd);
  }
}

/** 現在の同接数を渡す。最大値を超えたときだけメモリとDBを更新する */
function trackOnlinePeak(online) {
  if (online > peakState.all) {
    peakState.all = online;
    recordOnlinePeak("all", online).catch(e => console.error("最大同接数(全期間)の保存失敗:", e.message));
  }
  const bd = getBusinessDayForRecording();
  if (!bd) return; // 1:00〜5:59は営業日に属さないため、営業日の最大は更新しない
  if (bd !== peakState.day) { peakState.day = bd; peakState.dayValue = 0; } // 営業日が変わったらリセット
  if (online > peakState.dayValue) {
    peakState.dayValue = online;
    recordOnlinePeak(bd, online).catch(e => console.error("最大同接数(営業日)の保存失敗:", e.message));
  }
}

/** { dayPeak: 本日(表示用の営業日)の最大同接数, allPeak: 全期間の最大同接数 } */
async function getOnlinePeaks() {
  const bd = getBusinessDayForDisplay();
  const dayPeak = bd === peakState.day ? peakState.dayValue : await getOnlinePeak(bd);
  return { dayPeak, allPeak: peakState.all };
}

/** 古い営業日ごとの最大同接数を削除する（全期間の最大 scope='all' は残す） */
async function cleanupOldOnlinePeaks(retentionDays = 30) {
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 24 * 60 * 60;
  await pool.query("DELETE FROM online_peaks WHERE scope <> 'all' AND peak_at < $1", [cutoff]);
}

// ── 週間アクティブユーザー ──
/** 'YYYY-MM-DD' の営業日文字列を deltaDays 日ずらす */
function shiftBusinessDay(dayStr, deltaDays) {
  const d = new Date(dayStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return jstDateToString(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** endBusinessDay を含む直近7営業日に訪れたユーザーの人数（重複なし） */
async function countWeeklyActiveUsers(endBusinessDay) {
  const startDay = shiftBusinessDay(endBusinessDay, -6);
  const { rows } = await pool.query(
    "SELECT COUNT(DISTINCT username) FROM daily_active_users WHERE business_day >= $1 AND business_day <= $2",
    [startDay, endBusinessDay]
  );
  return parseInt(rows[0].count, 10);
}

// ── 登録職人数 ──
/** 本登録(confirmed)済みの職人の人数 */
async function countRegisteredMakers() {
  const { rows } = await pool.query("SELECT COUNT(*) FROM maker_accounts WHERE status='confirmed'");
  return parseInt(rows[0].count, 10);
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
  isOfficialMaker,
  getMakerRankingWeek, getMakerRankingAllTime, getMakerInfo, getOfficialMakers,
  getLatestAnnouncement,
  isAuthorConfirmed, isAuthorUsedBeforeCutoff, hasUsernameUsedAuthorBeforeCutoff,
  getMakerStatus, registerMakerConfirmed, registerMakerPending, verifyMakerPassword, hasRegisteredToday,
  listPendingMakers, approvePendingMaker, rejectPendingMaker, cleanupInactiveMakers,
  calcMakerPointAllTime, calcMakerPointWeekly,
  chatLogin, getAuthorByToken, chatLogout,
  saveChatMessage, getChatMessages, getLatestChatMessages, getChatMessagesBefore,
  saveDM, getDMMessages, getLatestDMMessages, getDMMessagesBefore, getDMPartners, markDMRead,
  getDailyCharCount, addDailyCharCount, cleanupOldDailyUsage, deleteOldChatMessages, deleteAllDMs,
  getBusinessDayForRecording, getBusinessDayForDisplay,
  recordDailyActiveUser, countDailyActiveUsers, cleanupOldDailyActiveUsers,
  getRecentlyDeletedChatIds, getRecentlyDeletedDMIds,
  banChatAuthor, unbanChatAuthor, isChatBanned, createChatReport, listChatReports, resolveChatReport,
  detectAndCleanSuspiciousLikes, listLikeFraudIncidents,
  deleteChatMessage, deleteDMMessage,
  blockAuthor, unblockAuthor, getBlockedAuthors, isAuthorBlocked,
  listBannedWords, addBannedWord, removeBannedWord,
  isCmdDisabled, listDisabledCmds, addDisabledCmd, removeDisabledCmd,
  getBypassInfo, getBypassUsername, issueBypassUsername, clearBypassUsername,
  listCoursesByDisposableLikers,
  getRecommendedCourses,
  listAuthorLikerSummary, listLikersForAuthor, purgeSuspiciousLikesForAuthor,
  autoPurgeSuspiciousLikes,
  purgeDuplicateLikes, autoPurgeDuplicateLikes,
  listIncidentDeletedLikes, restoreDeletedLikes, cleanupOldDeletedLikes,
  loadOnlinePeaks, trackOnlinePeak, getOnlinePeaks, cleanupOldOnlinePeaks,
  countWeeklyActiveUsers, countRegisteredMakers,
};
