"use strict";
/**
 * DB層 - Supabase (PostgreSQL)
 * 環境変数: DATABASE_URL
 */

const { Pool } = require("pg");
const crypto   = require("crypto");

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
      stage_data    TEXT    NOT NULL,
      posted_at     BIGINT  NOT NULL,
      play_count    INT     NOT NULL DEFAULT 0,
      attempt_count INT     NOT NULL DEFAULT 0,
      clear_count   INT     NOT NULL DEFAULT 0,
      like_count    INT     NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS likes (
      id         SERIAL  PRIMARY KEY,
      username   TEXT    NOT NULL,
      course_id  TEXT    NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      created_at BIGINT  NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE (username, course_id)
    );
    -- 既存テーブルにcreated_atがなければ追加
    ALTER TABLE likes ADD COLUMN IF NOT EXISTS
      created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT;

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
// コースID生成（A〜Z, 0〜9の3文字×3ブロック）
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
// コース保存
// ─────────────────────────────────────────────
async function saveCourse(title, author, stageData) {
  // 同一ステージデータの重複チェック
  const { rows: dupRows } = await pool.query(
    "SELECT 1 FROM courses WHERE stage_data=$1", [stageData]
  );
  if (dupRows.length) return { duplicate: true };

  // コースID衝突回避（最大5回リトライ）
  let id = generateCourseId();
  for (let i = 0; i < 5; i++) {
    const { rows } = await pool.query("SELECT 1 FROM courses WHERE id=$1", [id]);
    if (!rows.length) break;
    id = generateCourseId();
  }
  const postedAt = minutesSince2000();
  await pool.query(
    `INSERT INTO courses (id, title, author, stage_data, posted_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, title, author, stageData, postedAt]
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
    `SELECT ${INFO_COLS} FROM courses ORDER BY posted_at + (RANDOM() * 1080) DESC LIMIT $1`, [limit]
  );
  return rows;
}

async function getWeeklyRanking(limit) {
  // 過去7日間（604800秒）のいいね数で集計
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
  // weekly_countをlike_countとして上書きしてencodeCourseInfoで使えるようにする
  return rows.map(r => ({ ...r, like_count: parseInt(r.like_count), _weekly_count: parseInt(r.weekly_count) }));
}

async function getAllTimeRanking(limit) {
  const { rows } = await pool.query(
    `SELECT ${INFO_COLS} FROM courses ORDER BY like_count DESC, play_count DESC LIMIT $1`
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

const LIKES_MAX = 50000; // likesテーブルの最大件数

/**
 * いいね処理
 * @returns {{ alreadyLiked: boolean }}
 */
async function addLike(username, courseId) {
  // すでにいいね済みか確認
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

  // 5万件を超えたら古いものを削除
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

// 古いいいねの削除（7日以上前のものを定期削除してDBを軽量に保つ）
async function deleteOldLikes() {
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const { rowCount } = await pool.query(
    "DELETE FROM likes WHERE created_at < $1", [cutoff]
  );
  if (rowCount > 0) console.log(`🗑️ 古いいいねを ${rowCount} 件削除しました`);
}

// 後方互換用（scheduleWeeklyResetから呼ばれる）
async function resetWeeklyLikes() {
  await deleteOldLikes();
}

module.exports = {
  initDB, pool,
  saveCourse, getCourseById,
  getRandomCourses, getWeeklyRanking, getAllTimeRanking,
  searchByCourseId, searchByAuthor,
  incrementPlay, incrementAttempt, incrementClear, addLike,
  resetWeeklyLikes, deleteOldLikes, minutesSince2000,
};
