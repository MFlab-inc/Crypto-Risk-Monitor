/**
 * セッション日付の判定(暗号資産版)
 * 暗号資産は24/7取引・日足はUTC暦日区切り(00:00 UTCクローズ)。
 * forex版(EA-Risk-Monitor)のNY17:00セッション・市場時間ガードはここでは使わない。
 */
const { fmtDateLocal } = require("./util");

/** 直近の「確定した」セッション日付 = UTCの昨日(土日含む全暦日が取引日) */
function lastCompletedSessionDate(now = new Date()) {
  const d = new Date(now.getTime() - 86400000);
  return d.toISOString().slice(0, 10);
}

/** 暗号資産市場は常時オープン(intradayバッチのガードは常にtrue) */
function isMarketOpen() {
  return true;
}

module.exports = { lastCompletedSessionDate, isMarketOpen };
