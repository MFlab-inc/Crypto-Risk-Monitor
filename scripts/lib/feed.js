/**
 * risk-feed.json の組み立て・更新
 * 方針: daily/intradayの各バッチは自分の担当セクションだけを更新し、
 * イベント判定とフラグは毎回現在時刻で再合成する(read-modify-write)。
 * 部分的な取得失敗時は前回値を保持し、data_ok/エラーを明記する。
 */
const { round, jstIso, loadJSON, saveJSON, FEED_PATH } = require("./util");
const { computeEventState, composeFlags } = require("./gates");

const SCHEMA_VERSION = "1.0";

function initFeedSkeleton(pairsCfg, thresholds, pairKeys) {
  return {
    meta: {
      schema_version: SCHEMA_VERSION,
      generated_daily: null,
      generated_intraday: null,
      generated_calendar: null,
      session_date: null,
      source: "twelvedata / yahoo(sentiment) / forexfactory(calendar)",
      thresholds,
      note:
        "暗号資産3銘柄の市場データと市場判定のみを配信する。口座・運用情報は含まない。" +
        "事実データであり売買助言ではない。日足はUTC暦日区切り。intraday値は実行間隔+遅延分の古さを持ち得る。",
      errors: [],
    },
    market: { dxy: null, us10y: null, vix: null },
    pairs: Object.fromEntries(
      pairKeys.map((k) => [
        k,
        {
          data_ok: false,
          session_date: null,
          close: null,
          atr14: null,
          atr_pct: null,
          adr20: null,
          rv20: null,
          atr_pct_percentile_250: null,
          percentile_window: null,
          regime: null,
          intraday: {
            price: null, range_today: null, range_vs_adr: null,
            spike_flag: false, updated_at: null,
          },
          events: { in_event_window: false, active: [], next_48h: [] },
          flags: {},
        },
      ])
    ),
  };
}

function loadFeed(pairsCfg, thresholds, pairKeys) {
  const feed = loadJSON(FEED_PATH);
  if (!feed || feed.meta?.schema_version !== SCHEMA_VERSION) {
    return initFeedSkeleton(pairsCfg, thresholds, pairKeys);
  }
  // 閾値は常に最新のconfigを転記(検証可能性のため)
  feed.meta.thresholds = thresholds;
  for (const k of pairKeys) {
    if (!feed.pairs[k]) {
      feed.pairs[k] = initFeedSkeleton(pairsCfg, thresholds, [k]).pairs[k];
    }
  }
  return feed;
}

/** 日次指標を反映 */
function applyDaily(feed, pairKey, metrics, digits) {
  const p = feed.pairs[pairKey];
  p.session_date = metrics.session_date;
  p.close = round(metrics.close, digits);
  p.atr14 = round(metrics.atr14, digits);
  p.atr_pct = round(metrics.atr_pct, 3);
  p.adr20 = round(metrics.adr20, digits);
  p.rv20 = round(metrics.rv20, 2);
  p.atr_pct_percentile_250 = round(metrics.atr_pct_percentile_250, 1);
  p.percentile_window = metrics.percentile_window;
  p.regime = metrics.regime;
  p.data_ok = true;
}

/** 当日クオート(intraday)を反映。quoteがnullなら前回値保持(updated_atは進めない) */
function applyIntraday(feed, pairKey, quote, digits, thresholds, now = new Date()) {
  const p = feed.pairs[pairKey];
  if (!quote) return false;
  const range = quote.today_high - quote.today_low;
  p.intraday.price = round(quote.price, digits);
  p.intraday.range_today = round(range, digits);
  if (p.adr20 && p.adr20 > 0) {
    const ratio = range / p.adr20;
    p.intraday.range_vs_adr = round(ratio, 3);
    p.intraday.spike_flag = ratio > feed.meta.thresholds.range_vs_adr_alert; // 「150%超」= 厳密に超
  } else {
    p.intraday.range_vs_adr = null;
    p.intraday.spike_flag = false;
  }
  p.intraday.updated_at = jstIso(now);
  return true;
}

/** イベント判定とフラグを全ペア再合成(daily/intraday双方から毎回呼ぶ) */
function applyEventsAndFlags(feed, pairsCfg, thresholds, pairKeys, events, now = new Date()) {
  for (const k of pairKeys) {
    const cfg = pairsCfg[k];
    const p = feed.pairs[k];
    const st = computeEventState(cfg, events, thresholds, now);
    p.events = { in_event_window: st.in_event_window, active: st.active, next_48h: st.next_48h };
    p.flags = composeFlags(cfg, {
      regime: p.regime,
      spike_flag: p.intraday.spike_flag,
      in_event_window: st.in_event_window,
      active_events: st.active,
    });
  }
  feed.meta.generated_calendar = jstIso(now);
}

function saveFeed(feed) {
  saveJSON(FEED_PATH, feed);
}

module.exports = {
  SCHEMA_VERSION, initFeedSkeleton, loadFeed,
  applyDaily, applyIntraday, applyEventsAndFlags, saveFeed,
};
