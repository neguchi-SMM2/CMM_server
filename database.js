"use strict";

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
      like_count    INT     NOT NULL DEFAULT 0,
      weekly_likes  INT     NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS likes (
      user_id   TEXT NOT NULL,
      course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, course_id)
    );

    CREATE INDEX IF NOT EXISTS idx_courses_likes   ON courses(like_count DESC);
    CREATE INDEX IF NOT EXISTS idx_courses_weekly  ON courses(weekly_likes DESC);
    CREATE INDEX IF NOT EXISTS idx_courses_posted  ON courses(posted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_courses_author  ON courses(author);
    CREATE INDEX IF NOT EXISTS idx_courses_title   ON courses(title);
  `);
  console.log("✅ DB初期化完了");
}

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

async function saveCourse(title, author, stageData) {
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
  return id;
}

async function getCourseById(id) {
  const { rows } = await pool.query("SELECT * FROM courses WHERE id=$1", [id]);
  return rows[0] || null;
}

const INFO_COLS = `id, title, author, like_count, play_count, attempt_count, clear_count, posted_at`;

async function getRandomCourses(limit) {
  const { rows } = await pool.query(
    `SELECT ${INFO_COLS} FROM courses ORDER BY RANDOM() LIMIT $1`, [limit]
  );
  return rows;
}

async function getWeeklyRanking(limit) {
  // 1週間以内にいいねされたコース（weekly_likesを使用）
  const { rows } = await pool.query(
    `SELECT ${INFO_COLS} FROM courses ORDER BY weekly_likes DESC LIMIT $1`, [limit]
  );
  return rows;
}

async function getAllTimeRanking(limit) {
  const { rows } = await pool.query(
    `SELECT ${INFO_COLS} FROM courses ORDER BY like_count DESC LIMIT $1`, [limit]
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

/**
 * いいね処理
 * @returns {{ alreadyLiked: boolean }}
 */
async function addLike(userId, courseId) {
  // すでにいいね済みか確認
  const { rows } = await pool.query(
    "SELECT 1 FROM likes WHERE user_id=$1 AND course_id=$2", [userId, courseId]
  );
  if (rows.length) return { alreadyLiked: true };

  await pool.query(
    "INSERT INTO likes (user_id, course_id) VALUES ($1,$2)", [userId, courseId]
  );
  await pool.query(
    `UPDATE courses SET like_count=like_count+1, weekly_likes=weekly_likes+1
     WHERE id=$1`, [courseId]
  );
  return { alreadyLiked: false };
}

// 週間いいねリセット（毎週月曜に呼ぶ）
async function resetWeeklyLikes() {
  await pool.query("UPDATE courses SET weekly_likes=0");
  console.log("✅ 週間いいねリセット完了");
}

module.exports = {
  initDB, pool,
  saveCourse, getCourseById,
  getRandomCourses, getWeeklyRanking, getAllTimeRanking,
  searchByCourseId, searchByAuthor,
  incrementPlay, incrementAttempt, incrementClear, addLike,
  resetWeeklyLikes, minutesSince2000,
};
