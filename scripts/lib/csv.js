/**
 * MT4/MT5エクスポートCSVの取込(初期化の代替モード)
 * Twelve Dataとブローカー日足の厳密整合が必要になった場合に使用する。
 *
 * 対応形式(自動判別):
 * - 区切り: カンマ / タブ / セミコロン
 * - 日付: "2025.07.18" / "2025-07-18" / "2025/07/18" (時刻列があっても日付部のみ使用)
 * - 列: ヘッダー行があれば Date/Time/Open/High/Low/Close を名前で解決。
 *       ヘッダーなしは [Date, Open, High, Low, Close, ...] の順とみなす。
 */

function detectDelimiter(line) {
  const cands = ["\t", ",", ";"];
  let best = ",", bestCount = 0;
  for (const c of cands) {
    const n = line.split(c).length;
    if (n > bestCount) { bestCount = n; best = c; }
  }
  return best;
}

function normDate(s) {
  const m = String(s).trim().match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

/** CSVテキスト → 昇順バー配列(純関数・テスト対象) */
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error("CSVの行数が不足しています");
  const delim = detectDelimiter(lines[0]);
  const first = lines[0].split(delim).map((s) => s.trim().toLowerCase().replace(/[<>"]/g, ""));

  let idx = { date: 0, open: 1, high: 2, low: 3, close: 4 };
  let start = 0;
  const hasHeader = first.some((c) => /date|time|open|high|low|close/.test(c));
  if (hasHeader) {
    const find = (names) => first.findIndex((c) => names.some((n) => c === n || c.includes(n)));
    const di = find(["date"]);
    idx = {
      date: di >= 0 ? di : find(["time"]),
      open: find(["open"]),
      high: find(["high"]),
      low: find(["low"]),
      close: find(["close"]),
    };
    if (Object.values(idx).some((i) => i < 0)) {
      throw new Error(`ヘッダー列を解決できません: ${lines[0]}`);
    }
    start = 1;
  }

  const bars = [];
  for (let i = start; i < lines.length; i++) {
    const cols = lines[i].split(delim).map((s) => s.trim().replace(/"/g, ""));
    const date = normDate(cols[idx.date]);
    if (!date) continue;
    const open = parseFloat(cols[idx.open]);
    const high = parseFloat(cols[idx.high]);
    const low = parseFloat(cols[idx.low]);
    const close = parseFloat(cols[idx.close]);
    if ([open, high, low, close].some((v) => !isFinite(v))) continue;
    bars.push({ date, open, high, low, close });
  }
  if (bars.length === 0) throw new Error("有効な行がありません");
  // 同一日付は後勝ちで重複除去し昇順ソート
  const byDate = new Map(bars.map((b) => [b.date, b]));
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = { parseCsv, normDate, detectDelimiter };
