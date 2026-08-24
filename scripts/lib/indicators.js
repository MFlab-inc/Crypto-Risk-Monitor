/**
 * リスク指標の計算(純関数のみ・テスト対象)
 *
 * 定義(README準拠):
 * - TR    = max(H-L, |H-前日C|, |L-前日C|)
 * - ATR14 = Wilder平滑: 初期値=最初の14本のTR単純平均、以後 ATR=(前ATR*13+TR)/14
 *           ※既存FXDaily-Levels fetch.jsと同一定義(数値整合のため)
 * - ATR%  = ATR14 / 終値 * 100 (パーセント表記)
 * - ADR20 = 直近20暦日の(H-L)単純平均(暗号資産は毎日が取引日)
 * - RV20  = 直近20個の日次対数リターンの標本標準偏差(n-1) * sqrt(365) * 100 (年率%・パーセント表記)
 *           ※暗号資産は24/7取引のため年率化は暦日365(forex版EA-Risk-Monitorは営業日252)
 * - パーセンタイル = 直近N本(既定365暦日)のATR%系列中、当日値以下の割合*100(当日を含む)
 * - レジーム: 平常 p<50 / 注意 50<=p<80 / 高ボラ 80<=p<95 / 異常 p>=95 (境界は保守側=上位区分)
 */

const ATR_PERIOD = 14;
const ADR_PERIOD = 20;
const RV_PERIOD = 20;

/** TR系列(昇順バー配列に対し、index 1 以降について計算) */
function trSeries(barsAsc) {
  const trs = [];
  for (let i = 1; i < barsAsc.length; i++) {
    const h = barsAsc[i].high, l = barsAsc[i].low, pc = barsAsc[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs;
}

/**
 * ATR系列(Wilder)。返り値は bars と同じ長さの配列で、
 * atr[i] は bars[i] 時点のATR14(計算不能な先頭はnull)。
 */
function atrSeries(barsAsc, period = ATR_PERIOD) {
  const trs = trSeries(barsAsc); // trs[j] は bars[j+1] のTR
  const atr = new Array(barsAsc.length).fill(null);
  if (trs.length < period) return atr;
  let a = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  atr[period] = a; // bars[period] 時点(TR period本分)
  for (let j = period; j < trs.length; j++) {
    a = (a * (period - 1) + trs[j]) / period;
    atr[j + 1] = a;
  }
  return atr;
}

/** ADR20系列。adr[i] = bars[i-19..i] の(H-L)平均(不足はnull) */
function adrSeries(barsAsc, period = ADR_PERIOD) {
  const adr = new Array(barsAsc.length).fill(null);
  let sum = 0;
  for (let i = 0; i < barsAsc.length; i++) {
    sum += barsAsc[i].high - barsAsc[i].low;
    if (i >= period) sum -= barsAsc[i - period].high - barsAsc[i - period].low;
    if (i >= period - 1) adr[i] = sum / period;
  }
  return adr;
}

/** RV20系列(年率%・パーセント表記)。rv[i] は bars[i] までの20リターンで計算。annDays=年率化日数 */
function rvSeries(barsAsc, period = RV_PERIOD, annDays = 365) {
  const rv = new Array(barsAsc.length).fill(null);
  const rets = [null];
  for (let i = 1; i < barsAsc.length; i++) {
    rets.push(Math.log(barsAsc[i].close / barsAsc[i - 1].close));
  }
  for (let i = period; i < barsAsc.length; i++) {
    const w = rets.slice(i - period + 1, i + 1); // 20個
    const mean = w.reduce((s, v) => s + v, 0) / w.length;
    const varS = w.reduce((s, v) => s + (v - mean) ** 2, 0) / (w.length - 1);
    rv[i] = Math.sqrt(varS) * Math.sqrt(annDays) * 100;
  }
  return rv;
}

/** ATR%系列(パーセント表記) */
function atrPctSeries(barsAsc, period = ATR_PERIOD) {
  const atr = atrSeries(barsAsc, period);
  return atr.map((a, i) => (a === null ? null : (a / barsAsc[i].close) * 100));
}

/**
 * パーセンタイルランク: 直近lookback本(当日含む)のうち当日値以下の割合*100。
 * 有効値がminWindow未満ならnull。
 */
function percentileRank(series, lookback = 250, minWindow = 120) {
  const valid = series.filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  if (valid.length === 0) return { percentile: null, window: 0 };
  const window = valid.slice(-lookback);
  if (window.length < minWindow) return { percentile: null, window: window.length };
  const cur = window[window.length - 1];
  const cnt = window.filter((v) => v <= cur).length;
  return { percentile: (cnt / window.length) * 100, window: window.length };
}

/** レジーム判定(境界値は上位区分=保守側) */
function regimeOf(percentile, th) {
  if (percentile === null || percentile === undefined) return null;
  if (percentile >= th.extreme) return "extreme";
  if (percentile >= th.highvol) return "highvol";
  if (percentile >= th.caution) return "caution";
  return "normal";
}

/**
 * 1ペア分の日次指標一式を計算。barsAscは昇順・確定足のみ。
 */
function computeDailyMetrics(barsAsc, thresholds) {
  const n = barsAsc.length;
  const minBars = ATR_PERIOD + RV_PERIOD + 1;
  if (n < minBars) throw new Error(`確定足が不足しています(${n}本、最低${minBars}本必要)`);
  const last = barsAsc[n - 1];
  const atr = atrSeries(barsAsc);
  const adr = adrSeries(barsAsc);
  const rv = rvSeries(barsAsc, RV_PERIOD, thresholds.rv_annualization_days || 365);
  const atrPct = atrPctSeries(barsAsc);
  const { percentile, window } = percentileRank(
    atrPct,
    thresholds.percentile_lookback,
    thresholds.percentile_min_window || 180
  );
  return {
    session_date: last.date,
    close: last.close,
    atr14: atr[n - 1],
    atr_pct: atrPct[n - 1],
    adr20: adr[n - 1],
    rv20: rv[n - 1],
    atr_pct_percentile_250: percentile,
    percentile_window: window,
    regime: regimeOf(percentile, thresholds.regime_percentile),
  };
}

module.exports = {
  ATR_PERIOD, ADR_PERIOD, RV_PERIOD,
  trSeries, atrSeries, adrSeries, rvSeries, atrPctSeries,
  percentileRank, regimeOf, computeDailyMetrics,
};
