/**
 * Yahoo Finance(非公式API)から市場心理指標を取得
 * 既存FXDaily-Levels fetch.jsから流用。DXY / US10Y / VIX。参考情報(仕様外オプション)。
 */
const { round, sleep } = require("./util");

const SENTIMENT = [
  { code: "dxy",   symbol: "DX-Y.NYB", divisor: 1,  digits: 2 },
  { code: "us10y", symbol: "^TNX",     divisor: 10, digits: 3 },
  { code: "vix",   symbol: "^VIX",     divisor: 1,  digits: 2 },
];

async function fetchOne(item) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(item.symbol)}?range=10d&interval=1d`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} (${item.symbol})`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo データなし (${item.symbol})`);
  const closes = (result.indicators?.quote?.[0]?.close || []).filter(
    (c) => c !== null && c !== undefined
  );
  if (closes.length < 2) throw new Error(`Yahoo 終値不足 (${item.symbol})`);
  let value = closes[closes.length - 1] / item.divisor;
  let prev = closes[closes.length - 2] / item.divisor;
  if (item.code === "us10y" && value < 1) { value *= 10; prev *= 10; } // スケール自動補正
  return {
    value: round(value, item.digits),
    change: round(value - prev, item.digits),
    change_pct: round(((value - prev) / prev) * 100, 2),
  };
}

/** 3指標を取得。失敗した指標はnull(部分失敗許容)。 */
async function fetchSentiment() {
  const out = {};
  for (const item of SENTIMENT) {
    try {
      out[item.code] = await fetchOne(item);
    } catch (e) {
      console.error(`FAIL: ${item.code} - ${e.message}`);
      out[item.code] = null;
    }
    await sleep(500);
  }
  return out;
}

module.exports = { fetchSentiment };
