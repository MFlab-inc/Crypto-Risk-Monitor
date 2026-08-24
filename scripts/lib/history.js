/**
 * D1履歴(data/history/{PAIR}.json)の管理
 * 形式: { pair, symbol, updated_at, bars: [{date, open, high, low, close}] } 昇順
 */
const path = require("path");
const { loadJSON, saveJSON, jstIso, HISTORY_DIR } = require("./util");

function historyPath(pairKey) {
  return path.join(HISTORY_DIR, `${pairKey}.json`);
}

function loadHistory(pairKey) {
  return loadJSON(historyPath(pairKey));
}

function saveHistory(pairKey, symbol, barsAsc, keepBars) {
  const bars = barsAsc.slice(-keepBars);
  saveJSON(historyPath(pairKey), {
    pair: pairKey,
    symbol,
    updated_at: jstIso(new Date()),
    bars,
  });
  return bars;
}

/**
 * 新しいバーを履歴にマージ(日付キー・冪等)。
 * 同一日付は新データで置換(データ訂正対応)。昇順を維持。
 */
function mergeBars(existingBars, newBars) {
  const byDate = new Map(existingBars.map((b) => [b.date, b]));
  let added = 0, replaced = 0;
  for (const b of newBars) {
    if (byDate.has(b.date)) {
      const cur = byDate.get(b.date);
      if (
        cur.open !== b.open || cur.high !== b.high ||
        cur.low !== b.low || cur.close !== b.close
      ) replaced++;
      byDate.set(b.date, b);
    } else {
      byDate.set(b.date, b);
      added++;
    }
  }
  const merged = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { merged, added, replaced };
}

/**
 * 履歴の検証(純関数・テスト対象)。
 * 返り値: { ok, errors: [], warnings: [] }
 */
function validateBars(barsAsc, { minBars = 270 } = {}) {
  const errors = [];
  const warnings = [];
  if (barsAsc.length < minBars) {
    errors.push(`本数不足: ${barsAsc.length}本 (最低${minBars}本必要)`);
  }
  const seen = new Set();
  for (const b of barsAsc) {
    if (seen.has(b.date)) errors.push(`重複日付: ${b.date}`);
    seen.add(b.date);
    const vals = [b.open, b.high, b.low, b.close];
    if (vals.some((v) => typeof v !== "number" || !isFinite(v) || v <= 0)) {
      errors.push(`不正値(0以下/非数値): ${b.date}`);
      continue;
    }
    if (b.high < b.low || b.high < b.open || b.high < b.close || b.low > b.open || b.low > b.close) {
      errors.push(`OHLC整合性エラー: ${b.date}`);
    }
  }
  for (let i = 1; i < barsAsc.length; i++) {
    const gap =
      (new Date(barsAsc[i].date) - new Date(barsAsc[i - 1].date)) / 86400000;
    if (gap > 6) warnings.push(`日付ギャップ ${barsAsc[i - 1].date} → ${barsAsc[i].date} (${gap}日)`);
    if (gap <= 0) errors.push(`日付順序エラー: ${barsAsc[i].date}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { historyPath, loadHistory, saveHistory, mergeBars, validateBars };
