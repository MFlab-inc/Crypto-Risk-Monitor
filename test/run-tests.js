/**
 * 計算ロジックの検証テスト(ネットワーク不要・node test/run-tests.js で実行)
 */
const assert = require("assert");
const {
  atrSeries, adrSeries, rvSeries, atrPctSeries,
  percentileRank, regimeOf, computeDailyMetrics,
} = require("../scripts/lib/indicators");
const { classifyEvent, normalizeEvents } = require("../scripts/lib/calendar");
const { computeEventState, composeFlags, windowHoursFor } = require("../scripts/lib/gates");
const { mergeBars, validateBars } = require("../scripts/lib/history");
const { lastCompletedSessionDate } = require("../scripts/lib/session");
const { parseCsv } = require("../scripts/lib/csv");
const { initFeedSkeleton, applyDaily, applyIntraday } = require("../scripts/lib/feed");
const { loadConfigs } = require("../scripts/lib/util");

let passed = 0, failed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok: ${name}`);
  } catch (e) {
    failed++;
    console.error(`  NG: ${name}\n      ${e.message}`);
  }
}
const approx = (a, b, eps = 1e-9) => {
  assert.ok(Math.abs(a - b) < eps, `expected ${b}, got ${a}`);
};

const { thresholds } = loadConfigs();
const TH = thresholds;

// ---------- indicators ----------
console.log("[indicators]");

t("ATR: 一定レンジのバーではATR=レンジ", () => {
  const bars = Array.from({ length: 40 }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    open: 105, high: 110, low: 100, close: 105,
  }));
  const atr = atrSeries(bars, 14);
  approx(atr[bars.length - 1], 10);
  const adr = adrSeries(bars, 20);
  approx(adr[bars.length - 1], 10);
  const atrPct = atrPctSeries(bars, 14);
  approx(atrPct[bars.length - 1], (10 / 105) * 100);
});

t("ATR: Wilder再帰の手計算一致(period=2)", () => {
  const bars = [
    { date: "2026-01-01", open: 11, high: 12, low: 10, close: 11 },
    { date: "2026-01-02", open: 11, high: 13, low: 11, close: 12 },   // TR=2
    { date: "2026-01-03", open: 12, high: 15, low: 12, close: 14 },   // TR=3
    { date: "2026-01-04", open: 14, high: 14, low: 13, close: 13.5 }, // TR=1
  ];
  const atr = atrSeries(bars, 2);
  approx(atr[2], 2.5);            // 初期値 = mean(2,3)
  approx(atr[3], (2.5 * 1 + 1) / 2); // Wilder: (前ATR*(p-1)+TR)/p = 1.75
});

t("RV: 一定リターンなら標準偏差0", () => {
  const bars = Array.from({ length: 30 }, (_, i) => ({
    date: `2026-02-${String(i + 1).padStart(2, "0")}`,
    open: 100, high: 101, low: 99, close: 100 * Math.pow(1.001, i), // 毎日+0.1%
  }));
  const rv = rvSeries(bars, 20);
  approx(rv[bars.length - 1], 0, 1e-8);
});

t("RV: 2点の手計算一致(period=2)", () => {
  const bars = [
    { date: "2026-01-01", open: 0, high: 0, low: 0, close: 12 },
    { date: "2026-01-02", open: 0, high: 0, low: 0, close: 12 },
    { date: "2026-01-03", open: 0, high: 0, low: 0, close: 14 },
    { date: "2026-01-04", open: 0, high: 0, low: 0, close: 13.5 },
  ];
  const r1 = Math.log(14 / 12), r2 = Math.log(13.5 / 14);
  const m = (r1 + r2) / 2;
  // 暗号資産版: 年率化はsqrt(365)(暦日ベース)
  const expected = Math.sqrt(((r1 - m) ** 2 + (r2 - m) ** 2) / 1) * Math.sqrt(365) * 100;
  const rv = rvSeries(bars, 2);
  approx(rv[3], expected);
});

t("パーセンタイル: 最大値は100・最小値は1/N", () => {
  const inc = Array.from({ length: 250 }, (_, i) => i + 1);
  assert.strictEqual(percentileRank(inc, 250, 120).percentile, 100);
  const dec = Array.from({ length: 250 }, (_, i) => 250 - i);
  approx(percentileRank(dec, 250, 120).percentile, (1 / 250) * 100);
});

t("パーセンタイル: 窓不足はnull", () => {
  const s = Array.from({ length: 100 }, (_, i) => i);
  assert.strictEqual(percentileRank(s, 250, 120).percentile, null);
});

t("レジーム境界(50/80/95・境界は上位区分)", () => {
  const th = TH.regime_percentile;
  assert.strictEqual(regimeOf(49.9, th), "normal");
  assert.strictEqual(regimeOf(50, th), "caution");
  assert.strictEqual(regimeOf(79.9, th), "caution");
  assert.strictEqual(regimeOf(80, th), "highvol");
  assert.strictEqual(regimeOf(94.9, th), "highvol");
  assert.strictEqual(regimeOf(95, th), "extreme");
  assert.strictEqual(regimeOf(100, th), "extreme");
});

t("computeDailyMetrics: 450本の合成データで全項目算出(365暦日パーセンタイル)", () => {
  const bars = [];
  let c = 100;
  const d0 = new Date("2025-01-01");
  for (let i = 0; i < 450; i++) {
    const vol = 1 + 0.5 * Math.sin(i / 10); // 決定論的なボラ変動
    const o = c;
    c = c + 0.3 * Math.sin(i / 7) * vol;
    const h = Math.max(o, c) + vol;
    const l = Math.min(o, c) - vol;
    const d = new Date(d0.getTime() + i * 86400000);
    bars.push({ date: d.toISOString().slice(0, 10), open: o, high: h, low: l, close: c });
  }
  const m = computeDailyMetrics(bars, TH);
  assert.ok(m.atr14 > 0 && m.adr20 > 0 && m.rv20 >= 0);
  assert.ok(m.atr_pct > 0);
  assert.strictEqual(m.percentile_window, 365); // lookback=365暦日
  assert.ok(m.atr_pct_percentile_250 >= 0 && m.atr_pct_percentile_250 <= 100);
  assert.ok(["normal", "caution", "highvol", "extreme"].includes(m.regime));
  assert.strictEqual(m.session_date, bars[449].date);
});

// ---------- calendar ----------
console.log("[calendar]");

t("分類: 日銀・FOMC・CPI・雇用・原油", () => {
  const c = (currency, impact, title) => classifyEvent({ currency, impact, title });
  assert.deepStrictEqual(c("JPY", "High", "BOJ Policy Rate"), ["boj"]);
  assert.deepStrictEqual(c("USD", "High", "FOMC Statement"), ["fomc"]);
  assert.deepStrictEqual(c("USD", "High", "Core CPI m/m"), ["us_cpi"]);
  assert.deepStrictEqual(c("USD", "High", "Non-Farm Employment Change"), ["us_jobs"]);
  assert.deepStrictEqual(c("USD", "High", "Unemployment Claims"), []); // Claimsは米雇用から除外
  assert.deepStrictEqual(c("USD", "Low", "Crude Oil Inventories"), ["oil"]); // 原油はインパクト不問
  assert.deepStrictEqual(c("CNY", "Medium", "Manufacturing PMI"), []); // 中国はHighのみ(仮置き)
  assert.deepStrictEqual(c("CNY", "High", "GDP q/y"), ["china_data"]);
  assert.deepStrictEqual(c("GBP", "High", "Official Bank Rate"), ["boe"]);
  assert.deepStrictEqual(c("CAD", "High", "Employment Change"), ["ca_jobs"]);
  assert.deepStrictEqual(c("NZD", "High", "RBNZ Official Cash Rate"), ["rbnz"]); // 2026-07-24 5ペア追加
});

t("normalizeEvents: 重複除去・Low維持条件・時刻順", () => {
  const raw = [
    { country: "USD", impact: "High", title: "FOMC Statement", date: "2026-07-29T14:00:00-04:00" },
    { country: "USD", impact: "High", title: "FOMC Statement", date: "2026-07-29T14:00:00-04:00" }, // 重複
    { country: "USD", impact: "Low", title: "Crude Oil Inventories", date: "2026-07-22T10:30:00-04:00" },
    { country: "USD", impact: "Low", title: "Some Minor Talk", date: "2026-07-22T11:00:00-04:00" }, // Low+分類なし=除外
    { country: "ZZZ", impact: "High", title: "Unknown", date: "2026-07-22T11:00:00-04:00" }, // 対象外通貨
  ];
  const ev = normalizeEvents(raw);
  assert.strictEqual(ev.length, 2);
  assert.strictEqual(ev[0].title, "Crude Oil Inventories"); // 時刻順
  assert.deepStrictEqual(ev[1].types, ["fomc"]);
});

// ---------- gates ----------
console.log("[gates]");
const { pairs: PAIRS_CFG } = loadConfigs();

t("ウィンドウ時間: 種別×銘柄(BTC/ETH/BNB)", () => {
  const w1 = windowHoursFor(["fomc"], PAIRS_CFG.BTCUSD, TH);
  assert.strictEqual(w1.pre, 24); assert.strictEqual(w1.post, 2); // FOMC=central_bank_major
  const w2 = windowHoursFor(["us_cpi"], PAIRS_CFG.ETHUSD, TH);
  assert.strictEqual(w2.pre, 12); assert.strictEqual(w2.post, 1); // 指標系
  const w3 = windowHoursFor(["us_jobs"], PAIRS_CFG.BNBUSD, TH);
  assert.strictEqual(w3.pre, 12); assert.strictEqual(w3.post, 1); // 指標系
  const w4 = windowHoursFor(["boj"], PAIRS_CFG.BTCUSD, TH);
  assert.strictEqual(w4, null); // 監視対象外(日銀はBTCの監視イベントに含めない)
});

t("イベントウィンドウ判定: FOMC前24h以内で点灯・発表後2h超で消灯", () => {
  const now = new Date("2026-07-28T12:00:00Z");
  const mk = (offsetH, types, title) => ({
    time_ms: now.getTime() + offsetH * 3600000,
    time_utc: "", currency: "USD", impact: "High", title, types,
  });
  // 10時間後のFOMC → ウィンドウ内
  let st = computeEventState(PAIRS_CFG.BTCUSD, [mk(10, ["fomc"], "FOMC Statement")], TH, now);
  assert.strictEqual(st.in_event_window, true);
  assert.strictEqual(st.next_48h.length, 1);
  assert.strictEqual(st.next_48h[0].gating, true);
  // 30時間後のFOMC → まだウィンドウ外だが48hリストには載る
  st = computeEventState(PAIRS_CFG.BTCUSD, [mk(30, ["fomc"], "FOMC Statement")], TH, now);
  assert.strictEqual(st.in_event_window, false);
  assert.strictEqual(st.next_48h.length, 1);
  // 発表1時間後 → post2hウィンドウ内
  st = computeEventState(PAIRS_CFG.BTCUSD, [mk(-1, ["fomc"], "FOMC Statement")], TH, now);
  assert.strictEqual(st.in_event_window, true);
  // 発表3時間後 → 解除
  st = computeEventState(PAIRS_CFG.BTCUSD, [mk(-3, ["fomc"], "FOMC Statement")], TH, now);
  assert.strictEqual(st.in_event_window, false);
  // 50時間後 → 48hリスト外
  st = computeEventState(PAIRS_CFG.BTCUSD, [mk(50, ["fomc"], "FOMC Statement")], TH, now);
  assert.strictEqual(st.next_48h.length, 0);
});

t("フラグ合成: レジーム・急変・イベントの組合せ", () => {
  const cfg = PAIRS_CFG.BTCUSD;
  let f = composeFlags(cfg, { regime: "normal", spike_flag: false, in_event_window: false });
  assert.deepStrictEqual([f.no_new_grid, f.halt_all_new], [false, false]);
  f = composeFlags(cfg, { regime: "highvol", spike_flag: false, in_event_window: false });
  assert.deepStrictEqual([f.no_new_grid, f.halt_all_new], [true, false]);
  f = composeFlags(cfg, { regime: "extreme", spike_flag: false, in_event_window: false });
  assert.deepStrictEqual([f.no_new_grid, f.halt_all_new], [true, true]);
  f = composeFlags(cfg, { regime: "normal", spike_flag: true, in_event_window: false });
  assert.deepStrictEqual([f.no_new_grid, f.halt_all_new], [true, true]); // 急変=全停止
  f = composeFlags(cfg, { regime: "normal", spike_flag: false, in_event_window: true, active_events: [{ title: "FOMC" }] });
  assert.deepStrictEqual([f.no_new_grid, f.halt_all_new], [true, false]);
  assert.ok(f.reasons.includes("event:FOMC"));
});

t("フラグ合成: 3銘柄とも標準ゲート対象(hold/monitorなし)", () => {
  for (const k of ["BTCUSD", "ETHUSD", "BNBUSD"]) {
    const f = composeFlags(PAIRS_CFG[k], { regime: "extreme", spike_flag: true, in_event_window: false });
    assert.strictEqual(f.no_new_grid, true);
    assert.strictEqual(f.halt_all_new, true);
    assert.strictEqual(f.monitor_only, undefined);
    assert.strictEqual(f.vr_hold_check, undefined);
  }
});

// ---------- history ----------
console.log("[history]");

t("mergeBars: 追記・置換・冪等", () => {
  const a = [
    { date: "2026-07-01", open: 1, high: 2, low: 0.5, close: 1.5 },
    { date: "2026-07-02", open: 1.5, high: 2.5, low: 1, close: 2 },
  ];
  const b = [
    { date: "2026-07-02", open: 1.5, high: 2.6, low: 1, close: 2 }, // 訂正
    { date: "2026-07-03", open: 2, high: 3, low: 1.5, close: 2.5 }, // 新規
  ];
  const r1 = mergeBars(a, b);
  assert.strictEqual(r1.merged.length, 3);
  assert.strictEqual(r1.added, 1);
  assert.strictEqual(r1.replaced, 1);
  const r2 = mergeBars(r1.merged, b); // 再実行しても変化なし
  assert.strictEqual(r2.merged.length, 3);
  assert.strictEqual(r2.added, 0);
  assert.strictEqual(r2.replaced, 0);
});

t("セッション日付: UTC昨日(土日も取引日として扱う)", () => {
  // 2026-08-02(日) 03:00 UTC → 確定済み最新セッションは 08-01(土)
  assert.strictEqual(lastCompletedSessionDate(new Date("2026-08-02T03:00:00Z")), "2026-08-01");
  // 2026-08-03(月) 00:10 UTC → 08-02(日)。forex版と異なり週末を飛ばさない
  assert.strictEqual(lastCompletedSessionDate(new Date("2026-08-03T00:10:00Z")), "2026-08-02");
  // 23:59 UTCでは当日はまだ確定しない
  assert.strictEqual(lastCompletedSessionDate(new Date("2026-08-02T23:59:00Z")), "2026-08-01");
});

t("validateBars: 重複・OHLC不整合・ギャップ検出", () => {
  const bars = [
    { date: "2026-07-01", open: 1, high: 2, low: 0.5, close: 1.5 },
    { date: "2026-07-01", open: 1, high: 2, low: 0.5, close: 1.5 }, // 重複
    { date: "2026-07-02", open: 1, high: 0.9, low: 1.2, close: 1 }, // H<L
    { date: "2026-07-20", open: 1, high: 2, low: 0.5, close: 1.5 }, // ギャップ
  ];
  const v = validateBars(bars, { minBars: 3 });
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("重複")));
  assert.ok(v.errors.some((e) => e.includes("整合性") || e.includes("順序")));
  assert.ok(v.warnings.some((w) => w.includes("ギャップ")));
});

// ---------- csv ----------
console.log("[csv]");

t("parseCsv: MT5形式(タブ+<HEADER>)とカンマ形式", () => {
  const mt5 = "<DATE>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\n2025.07.17\t1.1000\t1.1200\t1.0900\t1.1150\t1000\n2025.07.18\t1.1150\t1.1300\t1.1100\t1.1250\t1200\n";
  const b1 = parseCsv(mt5);
  assert.strictEqual(b1.length, 2);
  assert.strictEqual(b1[0].date, "2025-07-17");
  approx(b1[1].close, 1.125);
  const csv = "Date,Open,High,Low,Close\n2025/07/18,150.10,151.20,149.80,150.90\n2025/07/17,149.50,150.40,149.00,150.10\n";
  const b2 = parseCsv(csv);
  assert.strictEqual(b2[0].date, "2025-07-17"); // 昇順ソート
  assert.strictEqual(b2[1].date, "2025-07-18");
});

// ---------- feed ----------
console.log("[feed]");

t("applyIntraday: 150%超で急変フラグ(境界=1.5は点灯しない)", () => {
  const { pairs, thresholds: th } = loadConfigs();
  const keys = Object.keys(pairs).filter((k) => !k.startsWith("_"));
  const feed = initFeedSkeleton(pairs, th, keys);
  feed.pairs.BTCUSD.adr20 = 2000;
  let ok = applyIntraday(feed, "BTCUSD", { price: 100000, today_high: 101500, today_low: 98500 }, 2, th); // range=3000 → 1.5
  assert.strictEqual(ok, true);
  assert.strictEqual(feed.pairs.BTCUSD.intraday.spike_flag, false);
  applyIntraday(feed, "BTCUSD", { price: 100000, today_high: 101600, today_low: 98500 }, 2, th); // range=3100 → 1.55
  assert.strictEqual(feed.pairs.BTCUSD.intraday.spike_flag, true);
  // quote失敗時は前回値保持
  ok = applyIntraday(feed, "BTCUSD", null, 2, th);
  assert.strictEqual(ok, false);
  assert.strictEqual(feed.pairs.BTCUSD.intraday.spike_flag, true);
});

t("applyDaily: 丸め桁とdata_ok", () => {
  const { pairs, thresholds: th } = loadConfigs();
  const keys = Object.keys(pairs).filter((k) => !k.startsWith("_"));
  const feed = initFeedSkeleton(pairs, th, keys);
  applyDaily(feed, "BTCUSD", {
    session_date: "2026-08-01", close: 99123.456789, atr14: 2345.6789,
    atr_pct: 2.3661234, adr20: 2456.789012, rv20: 45.87654,
    atr_pct_percentile_250: 62.345, percentile_window: 365, regime: "caution",
  }, 2);
  const p = feed.pairs.BTCUSD;
  assert.strictEqual(p.close, 99123.46);
  assert.strictEqual(p.atr_pct, 2.366);
  assert.strictEqual(p.rv20, 45.88);
  assert.strictEqual(p.atr_pct_percentile_250, 62.3);
  assert.strictEqual(p.data_ok, true);
});

// ---------- 結果 ----------
console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
