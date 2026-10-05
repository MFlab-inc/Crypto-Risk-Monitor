/**
 * 月初始値の固定表(data/history/ETHUSD-month-open.json)の更新
 *
 * data/history/ETHUSD.json は history_keep_bars で古い日が消えるため、
 * 各月1日(UTC)の日足始値だけを、消えない別ファイルに保持する。追記専用。
 *
 *   node scripts/month-open.js             通常: ETHUSD.json の bars から追記(API消費なし)
 *   node scripts/month-open.js --backfill  ETH/USD を outputsize=600 で1回取得して追記(手動1回用)
 *
 * 規則:
 * - 既存の月は上書きしない。新しい値が既存値と0.5%超ずれていたら、保存せずエラー終了する
 * - 保存前に表全体を検証する(START_MONTH から始まる・最新月まで欠けなく連続)。不合格なら保存しない
 */
const path = require("path");
const { loadConfigs, loadJSON, saveJSON, jstIso, HISTORY_DIR } = require("./lib/util");
const { lastCompletedSessionDate } = require("./lib/session");
const { loadHistory } = require("./lib/history");

const PAIR = "ETHUSD";
const START_MONTH = "2025-04";
const TOLERANCE = 0.005;
const BACKFILL_OUTPUTSIZE = 600;
const SOURCE = "Twelve Data ETH/USD 1day (UTC)";
const RULE = "各月1日(UTC)の日足始値";
const TABLE_PATH = path.join(HISTORY_DIR, `${PAIR}-month-open.json`);

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function nextMonth(m) {
  let [y, mo] = m.split("-").map(Number);
  mo += 1;
  if (mo > 12) { mo = 1; y += 1; }
  return `${y}-${String(mo).padStart(2, "0")}`;
}

function sortedMonths(months) {
  const out = {};
  for (const k of Object.keys(months).sort()) out[k] = months[k];
  return out;
}

/** bars から「◯月1日」の始値を拾う(START_MONTH より前の月は無視)。返り値: { "YYYY-MM": {date, open} } */
function extractMonthOpens(bars, startMonth = START_MONTH) {
  const found = {};
  for (const b of bars) {
    if (!DATE_RE.test(String(b.date))) throw new Error(`不正な日付形式: ${b.date}`);
    if (b.date.slice(8, 10) !== "01") continue;
    const month = b.date.slice(0, 7);
    if (month < startMonth) continue;
    if (typeof b.open !== "number" || !isFinite(b.open) || b.open <= 0) {
      throw new Error(`${b.date} の始値が不正: ${b.open}`);
    }
    if (found[month]) throw new Error(`${month} の1日バーが重複しています`);
    found[month] = { date: b.date, open: b.open };
  }
  return sortedMonths(found);
}

/**
 * 既存の表に、無い月だけ追加する(純関数)。既存月は上書きしない。
 * 差が tolerance 超の月は conflicts に入れる(呼び出し側がエラー終了にする)。
 */
function mergeMonthOpens(existing, candidates, tolerance = TOLERANCE) {
  const months = { ...existing };
  const added = [];
  const withinTolerance = [];
  const conflicts = [];
  for (const [month, c] of Object.entries(candidates)) {
    const cur = existing[month];
    if (!cur) {
      months[month] = { date: c.date, open: c.open };
      added.push(month);
      continue;
    }
    const diff = Math.abs(c.open - cur.open) / cur.open;
    if (diff > tolerance) {
      conflicts.push({ month, existing: cur.open, incoming: c.open, diffPct: diff * 100 });
    } else if (c.open !== cur.open) {
      withinTolerance.push({ month, diffPct: diff * 100 });
    }
  }
  return { months: sortedMonths(months), added, withinTolerance, conflicts };
}

/** 表の検証(純関数): 開始月・各エントリの形式・最新月までの連続性 */
function validateMonthTable(months, startMonth = START_MONTH) {
  const errors = [];
  const keys = Object.keys(months || {}).sort();
  if (keys.length === 0) return { ok: false, errors: ["表が空です"], first: null, last: null };

  for (const k of keys) {
    if (!MONTH_RE.test(k)) { errors.push(`不正な月キー: ${k}`); continue; }
    const e = months[k];
    if (!e || e.date !== `${k}-01`) errors.push(`${k}: date が ${k}-01 ではありません (${e && e.date})`);
    if (!e || typeof e.open !== "number" || !isFinite(e.open) || e.open <= 0) {
      errors.push(`${k}: open が不正です (${e && e.open})`);
    }
  }
  if (keys[0] !== startMonth) errors.push(`開始月が ${startMonth} ではありません (先頭=${keys[0]})`);

  if (keys.every((k) => MONTH_RE.test(k))) {
    const missing = [];
    const last = keys[keys.length - 1];
    for (let m = keys[0]; m < last; ) {
      m = nextMonth(m);
      if (!months[m]) missing.push(m);
    }
    if (missing.length > 0) errors.push(`月が欠けています: ${missing.join(", ")}`);
  }
  return { ok: errors.length === 0, errors, first: keys[0], last: keys[keys.length - 1] };
}

/**
 * 候補を既存の表に反映して保存する。検証や衝突で1つでも問題があれば何も保存せず throw する。
 * 追加が無いときはファイルを書き換えない(日次のコミットを増やさないため)。
 */
function applyCandidates({ tablePath = TABLE_PATH, candidates, backfill = false, symbol, now = new Date(), log = console.log }) {
  const existingFile = loadJSON(tablePath, null);
  if (!existingFile && !backfill) {
    throw new Error(`${path.basename(tablePath)} がありません。先に month-open-backfill を手動実行してください`);
  }
  if (existingFile && existingFile.pair !== PAIR) {
    throw new Error(`既存の表の pair が ${PAIR} ではありません (${existingFile.pair})`);
  }
  const existing = existingFile ? existingFile.months || {} : {};
  if (existingFile) {
    const ev = validateMonthTable(existing);
    if (!ev.ok) throw new Error(`既存の表が不正です: ${ev.errors.join(" / ")}`);
  }

  if (backfill && !candidates[START_MONTH]) {
    throw new Error(`取得結果に ${START_MONTH}-01 が含まれていません(outputsize を増やすか、取得範囲を確認してください)`);
  }

  const { months, added, withinTolerance, conflicts } = mergeMonthOpens(existing, candidates);
  if (conflicts.length > 0) {
    const detail = conflicts
      .map((c) => `${c.month}: 既存 ${c.existing} / 新 ${c.incoming} (${c.diffPct.toFixed(2)}%)`)
      .join(" ; ");
    throw new Error(`既存値との差が${TOLERANCE * 100}%を超えています(上書きしません): ${detail}`);
  }
  for (const w of withinTolerance) {
    log(`  注: ${w.month} は既存値と差があります(${w.diffPct.toFixed(3)}%・許容内・既存値を維持)`);
  }

  const v = validateMonthTable(months);
  if (!v.ok) throw new Error(`検証エラー(保存しません): ${v.errors.join(" / ")}`);

  if (added.length === 0) {
    return { saved: false, added, first: v.first, last: v.last, count: Object.keys(months).length };
  }
  saveJSON(tablePath, {
    pair: PAIR,
    symbol,
    source: SOURCE,
    rule: RULE,
    updated_at: jstIso(now),
    months,
  });
  return { saved: true, added, first: v.first, last: v.last, count: Object.keys(months).length };
}

async function run({ backfill = false, tablePath = TABLE_PATH, now = new Date(), fetchBars = null, log = console.log } = {}) {
  const { pairs } = loadConfigs();
  const cfg = pairs[PAIR];
  if (!cfg) throw new Error(`config/pairs.json に ${PAIR} がありません`);

  let bars;
  if (backfill) {
    const fetchDailyBars = fetchBars || require("./lib/twelvedata").fetchDailyBars;
    bars = await fetchDailyBars(cfg.symbol, {
      outputsize: BACKFILL_OUTPUTSIZE,
      cutoffDate: lastCompletedSessionDate(now),
    });
  } else {
    const hist = loadHistory(PAIR);
    if (!hist || !Array.isArray(hist.bars) || hist.bars.length === 0) {
      throw new Error(`data/history/${PAIR}.json がないか空です`);
    }
    bars = hist.bars;
  }

  const candidates = extractMonthOpens(bars);
  return applyCandidates({ tablePath, candidates, backfill, symbol: cfg.symbol, now, log });
}

async function main() {
  const backfill = process.argv.includes("--backfill");
  console.log(`月初始値の更新 ${jstIso(new Date())} / モード: ${backfill ? "backfill (Twelve Data API)" : "通常 (ETHUSD.json)"}`);
  const r = await run({ backfill });
  if (r.saved) {
    console.log(`OK: ${PAIR} 月初始値 ${r.added.length}件追加 (${r.added.join(", ")}) / 表: ${r.first} 〜 ${r.last} (${r.count}か月)`);
  } else {
    console.log(`OK: ${PAIR} 月初始値 追加なし / 表: ${r.first} 〜 ${r.last} (${r.count}か月)`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`FAIL: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { START_MONTH, TOLERANCE, extractMonthOpens, mergeMonthOpens, validateMonthTable, applyCandidates, run };
