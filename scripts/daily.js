/**
 * Phase 1: 日次バッチ(毎日 04:47 UTC = JST 13:47。暗号資産は土日も取引日)
 * 1. 各ペアの直近足を取得し、確定した新規D1足のみを履歴に追記(冪等・同一日付は置換)
 * 2. 全指標を再計算して risk-feed.json のdailyセクションを更新
 * 3. カレンダー・フラグを再合成
 * 4. スナップショットを data/archive/YYYY-MM-DD.json に保存(Phase 3月次分析の材料)
 *
 * init-history.js からは run({skipFetch:true}) で呼ばれ、履歴の再取得なしで計算のみ行う。
 */
const path = require("path");
const { sleep, loadConfigs, jstIso, saveJSON, ARCHIVE_DIR } = require("./lib/util");
const { lastCompletedSessionDate } = require("./lib/session");
const { fetchDailyBars } = require("./lib/twelvedata");
const { fetchSentiment } = require("./lib/yahoo");
const { fetchEvents } = require("./lib/calendar");
const { loadHistory, saveHistory, mergeBars, validateBars } = require("./lib/history");
const { computeDailyMetrics } = require("./lib/indicators");
const { loadFeed, applyDaily, applyEventsAndFlags, saveFeed } = require("./lib/feed");

async function run({ skipFetch = false } = {}) {
  const now = new Date();
  const { pairs, thresholds, pairKeys } = loadConfigs();
  const cutoff = lastCompletedSessionDate(now);
  console.log(`日次バッチ ${jstIso(now)} / 確定セッション: ${cutoff}`);

  const feed = loadFeed(pairs, thresholds, pairKeys);
  feed.meta.errors = [];

  for (const key of pairKeys) {
    const cfg = pairs[key];
    try {
      const hist = loadHistory(key);
      if (!hist || !hist.bars || hist.bars.length === 0) {
        throw new Error("履歴がありません(先に init を実行してください)");
      }
      let bars = hist.bars; // 暗号資産は土日バーも正規データ(forex版の週末浄化は行わない)
      if (!skipFetch) {
        const fresh = await fetchDailyBars(cfg.symbol, { outputsize: 15, cutoffDate: cutoff });
        await sleep(1500);
        const { merged, added, replaced } = mergeBars(bars, fresh);
        const v = validateBars(merged, { minBars: Math.min(270, bars.length) });
        if (!v.ok) throw new Error(`マージ後検証エラー: ${v.errors.join(" / ")}`);
        bars = saveHistory(key, cfg.symbol, merged, thresholds.history_keep_bars);
        console.log(`OK: ${key} 追記${added}本/置換${replaced}本 (最新 ${bars[bars.length - 1].date})`);
      }
      const metrics = computeDailyMetrics(bars, thresholds);
      applyDaily(feed, key, metrics, cfg.digits);
    } catch (e) {
      console.error(`FAIL: ${key} - ${e.message}`);
      feed.meta.errors.push(`daily/${key}: ${e.message}`);
      if (feed.pairs[key]) feed.pairs[key].data_ok = false; // 前回値は保持しつつ非確定と明示
    }
  }

  // 市場心理(参考・部分失敗許容)
  try {
    feed.market = await fetchSentiment();
  } catch (e) {
    feed.meta.errors.push(`sentiment: ${e.message}`);
  }

  // カレンダー+フラグ再合成
  try {
    const events = await fetchEvents();
    applyEventsAndFlags(feed, pairs, thresholds, pairKeys, events, now);
    console.log(`OK: カレンダー ${events.length}件`);
  } catch (e) {
    console.error(`FAIL: カレンダー - ${e.message}`);
    feed.meta.errors.push(`calendar: ${e.message}`);
  }

  feed.meta.generated_daily = jstIso(now);
  feed.meta.session_date = cutoff;
  saveFeed(feed);

  // 日次スナップショット(Phase 3の一次データ)
  const snap = {
    session_date: cutoff,
    generated_at: jstIso(now),
    market: feed.market,
    pairs: Object.fromEntries(
      pairKeys.map((k) => {
        const p = feed.pairs[k];
        return [k, {
          data_ok: p.data_ok, session_date: p.session_date, close: p.close,
          atr14: p.atr14, atr_pct: p.atr_pct, adr20: p.adr20, rv20: p.rv20,
          atr_pct_percentile_250: p.atr_pct_percentile_250, regime: p.regime,
        }];
      })
    ),
  };
  saveJSON(path.join(ARCHIVE_DIR, `${cutoff}.json`), snap);

  const okCount = pairKeys.filter((k) => feed.pairs[k].data_ok).length;
  console.log(`保存完了: risk-feed.json / archive/${cutoff}.json (${okCount}/${pairKeys.length}ペア正常)`);
  if (okCount === 0) process.exit(1);
}

module.exports = { run };

if (require.main === module) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
