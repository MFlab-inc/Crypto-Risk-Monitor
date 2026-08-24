/**
 * Forex Factory 経済カレンダー取得・イベント種別分類
 * (既存FXDaily-Levels fetch.jsの取得パターンを流用。今週+来週の2フィードを
 *  マージするのは本システムの拡張: 週末をまたぐ48時間先読みに対応するため)
 *
 * イベント種別分類は通貨コード+タイトルの正規表現マッチ(仮置き・Phase 1稼働後に
 * 実データで捕捉漏れを検証する)。分類できないイベントは types=[] のまま返す。
 */

const FF_URLS = [
  "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
  "https://nfs.faireconomy.media/ff_calendar_nextweek.json",
];

const CAL_CURRENCIES = ["USD", "JPY", "EUR", "GBP", "AUD", "CAD", "CHF", "CNY", "NZD"];
const CAL_IMPACTS = ["High", "Medium"];

/**
 * イベント種別の判定規則。
 * impact条件: 既定はHigh/Medium両方だが、typeごとに上書き可能。
 * - china_data はHighのみ(Medium採用だとAUDCADのウィンドウが過剰になるため仮置きで限定)
 * - oil はインパクト不問(FFフィード上で原油在庫がMedium未満分類の場合があるため)
 */
const EVENT_RULES = [
  { type: "boj",        currency: "JPY", re: /BOJ|Bank of Japan|Monetary Policy|Policy Rate|Outlook Report/i },
  { type: "fomc",       currency: "USD", re: /FOMC|Federal Funds Rate|Fed Chair/i },
  { type: "boe",        currency: "GBP", re: /BOE|Official Bank Rate|Monetary Policy|MPC/i },
  { type: "ecb",        currency: "EUR", re: /ECB|Main Refinancing Rate|Monetary Policy/i },
  { type: "rba",        currency: "AUD", re: /RBA|Cash Rate|Monetary Policy/i },
  { type: "rbnz",       currency: "NZD", re: /RBNZ|Official Cash Rate|Monetary Policy/i },
  { type: "boc",        currency: "CAD", re: /BOC|Overnight Rate|Monetary Policy/i },
  { type: "us_cpi",     currency: "USD", re: /CPI/i },
  { type: "us_jobs",    currency: "USD", re: /Non-?Farm|Unemployment Rate|Average Hourly Earnings/i, exclude: /Claims/i },
  { type: "uk_cpi",     currency: "GBP", re: /CPI/i },
  { type: "uk_jobs",    currency: "GBP", re: /Claimant Count|Unemployment Rate|Average Earnings/i },
  { type: "ca_jobs",    currency: "CAD", re: /Employment Change|Unemployment Rate/i },
  { type: "china_data", currency: "CNY", re: /./, impacts: ["High"] },
  { type: "oil",        currency: "USD", re: /Crude Oil Inventories|OPEC/i, impacts: null }, // impacts:null=不問
];

/** 単一イベントを分類し、該当typeの配列を返す(純関数・テスト対象) */
function classifyEvent(ev) {
  const types = [];
  for (const rule of EVENT_RULES) {
    if (ev.currency !== rule.currency) continue;
    const impacts = rule.impacts === undefined ? CAL_IMPACTS : rule.impacts;
    if (impacts !== null && !impacts.includes(ev.impact)) continue;
    if (rule.exclude && rule.exclude.test(ev.title)) continue;
    if (rule.re.test(ev.title)) types.push(rule.type);
  }
  return types;
}

/** FF生イベント配列を正規化(純関数・テスト対象) */
function normalizeEvents(rawEvents) {
  const seen = new Set();
  const out = [];
  for (const e of rawEvents) {
    if (!CAL_CURRENCIES.includes(e.country)) continue;
    const dt = new Date(e.date); // ISO with offset
    if (isNaN(dt.getTime())) continue;
    const key = `${e.date}|${e.country}|${e.title}`;
    if (seen.has(key)) continue; // 今週/来週フィードの重複除去
    seen.add(key);
    const ev = {
      time_utc: dt.toISOString(),
      time_ms: dt.getTime(),
      currency: e.country,
      impact: e.impact || null,
      title: e.title,
      types: [],
    };
    ev.types = classifyEvent(ev);
    // High/Medium以外はtypesが付いた場合(oil等)のみ保持
    if (!CAL_IMPACTS.includes(ev.impact) && ev.types.length === 0) continue;
    out.push(ev);
  }
  out.sort((a, b) => a.time_ms - b.time_ms);
  return out;
}

/** 今週+来週のフィードを取得して正規化 */
async function fetchEvents() {
  const raw = [];
  const errors = [];
  for (const url of FF_URLS) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw.push(...(await res.json()));
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
  }
  if (raw.length === 0) throw new Error(`Forex Factory 取得失敗: ${errors.join(" / ")}`);
  if (errors.length > 0) console.warn(`警告(カレンダー部分失敗): ${errors.join(" / ")}`);
  return normalizeEvents(raw);
}

module.exports = { fetchEvents, normalizeEvents, classifyEvent, EVENT_RULES, CAL_CURRENCIES, CAL_IMPACTS };
