"use strict";

const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");

const SYMBOLS   = "0123456789abcdefghijklmnopqrstuvwxyz-_";
const B36       = "0123456789abcdefghijklmnopqrstuvwxyz";
const MOD       = 1296;
const BLOCK     = 24;
const NONCE_LEN = 8;
const MIN_KEY_LEN = 100;

let KEY = null;

function parseKey(text) {
  const arr = text.split(/[\s,]+/).filter(Boolean).map(Number);
  if (arr.length < MIN_KEY_LEN || arr.some(x => !Number.isInteger(x) || x < 0 || x >= MOD)) {
    throw new Error(`鍵の内容が不正です（0〜${MOD - 1}の整数が${MIN_KEY_LEN}個以上必要。現在${arr.length}個）`);
  }
  return arr;
}

function loadKey() {
  let text = process.env.PW_CRYPT_KEY;
  let source = "環境変数 PW_CRYPT_KEY";
  if (!text) {
    const file = process.env.PW_CRYPT_KEY_FILE || path.join(__dirname, "key.txt");
    if (fs.existsSync(file)) {
      text = fs.readFileSync(file, "utf8");
      source = `ファイル ${file}`;
    }
  }
  if (!text) {
    throw new Error("パスワード暗号化の鍵が見つかりません。環境変数 PW_CRYPT_KEY（または PW_CRYPT_KEY_FILE / key.txt）を設定してください");
  }
  KEY = parseKey(text);
  console.log(`🔑 パスワード暗号化の鍵を読み込みました（${KEY.length}個 / ${source}）`);
}

function isCipherFormat(str) {
  return typeof str === "string" && str.length === BLOCK * 2 && /^[0-9a-z]+$/.test(str);
}

function generateNonce() {
  let s = "";
  for (let i = 0; i < NONCE_LEN; i++) s += B36[crypto.randomInt(B36.length)];
  return s;
}

function b36val(ch) { return B36.indexOf(ch); }
function mod(a, m) { return ((a % m) + m) % m; }

function keystream(nonceVals, i) {
  const L = KEY.length;
  const start = (nonceVals[0] * 1296 + nonceVals[1] * 36 + nonceVals[2]) % L;
  const step  = 2 * (nonceVals[3] % 20) + 1;
  return (KEY[(start + i * step) % L] + nonceVals[i % NONCE_LEN]) % MOD;
}

function decryptPassword(cipher, nonce) {
  if (!KEY) throw new Error("鍵が読み込まれていません（loadKey()を先に呼んでください）");
  if (typeof nonce !== "string" || nonce.length !== NONCE_LEN) return null;
  if (typeof cipher !== "string" || cipher.length !== BLOCK * 2) return null;

  const nonceVals = [...nonce].map(b36val);
  if (nonceVals.some(v => v < 0)) return null;

  let prev = nonceVals[NONCE_LEN - 1];
  const p = [];
  for (let i = 0; i < BLOCK; i++) {
    const hi = b36val(cipher[i * 2]);
    const lo = b36val(cipher[i * 2 + 1]);
    if (hi < 0 || lo < 0) return null;
    const c = hi * 36 + lo;
    p.push(mod(c - keystream(nonceVals, i) - prev, MOD));
    prev = c;
  }

  const len = p[0];
  if (len < 1 || len > BLOCK - 1) return null;
  let pw = "";
  for (let i = 1; i <= len; i++) {
    if (p[i] >= SYMBOLS.length) return null;
    pw += SYMBOLS[p[i]];
  }
  return pw;
}

module.exports = { loadKey, generateNonce, decryptPassword, isCipherFormat, NONCE_LEN, BLOCK };
