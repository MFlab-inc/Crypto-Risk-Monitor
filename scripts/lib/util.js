/**
 * 共通ユーティリティ(既存FXDaily-Levels fetch.jsの日付処理を流用)
 */
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, d) => (n === null || n === undefined || Number.isNaN(n) ? null : Number(n.toFixed(d)));

function fmtDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** JSTのISO文字列(例: 2026-07-19T08:30:00+09:00) */
function jstIso(now = new Date()) {
  const s = now.toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" });
  return s.replace(" ", "T") + "+09:00";
}

/** JSTの曜日(0=日)と時刻 */
function jstParts(now = new Date()) {
  const d = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  return { dow: d.getDay(), hour: d.getHours(), minute: d.getMinutes(), date: fmtDateLocal(d) };
}

function loadJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

const ROOT = path.join(__dirname, "..", "..");
const DATA_DIR = path.join(ROOT, "data");
const HISTORY_DIR = path.join(DATA_DIR, "history");
const ARCHIVE_DIR = path.join(DATA_DIR, "archive");
const FEED_PATH = path.join(DATA_DIR, "risk-feed.json");
const CONFIG_DIR = path.join(ROOT, "config");

function loadConfigs() {
  const pairs = loadJSON(path.join(CONFIG_DIR, "pairs.json"));
  const thresholds = loadJSON(path.join(CONFIG_DIR, "thresholds.json"));
  if (!pairs || !thresholds) throw new Error("config/pairs.json または config/thresholds.json が読み込めません");
  const pairKeys = Object.keys(pairs).filter((k) => !k.startsWith("_"));
  return { pairs, thresholds, pairKeys };
}

module.exports = {
  sleep, round, fmtDateLocal, jstIso, jstParts,
  loadJSON, saveJSON, loadConfigs,
  ROOT, DATA_DIR, HISTORY_DIR, ARCHIVE_DIR, FEED_PATH, CONFIG_DIR,
};
