/**
 * ペア別イベントウィンドウ計算とフラグ合成(純関数のみ・テスト対象)
 *
 * フラグ合成規則(アクション接続仕様):
 * - no_new_grid  = レジームがhighvol以上 OR イベントウィンドウ内 OR halt_all_new
 * - halt_all_new = レジームがextreme OR 急変フラグ(当日レンジ/ADR >= 閾値)
 * - 既存バスケットのTP決済は常時許可 = フィードは「新規」の判定のみを配信
 * - window_profile:
 *     standard / short   … 上記ゲートフラグを出力
 *     hold_flag_only     … ゲートなし。vr_hold_check(週次ルール5の自動化)のみ(2026-07-31以降未使用・後方互換で残置)
 *     monitor_only       … ゲート判定を参考算出し monitor_only: true を併記(同・未使用・後方互換で残置)
 * - pairCfg.hold_check: true … ゲートフラグに vr_hold_check(保有確認リマインダー)を併記
 *   (2026-07-31仕様変更: USDJPYをゲート算出対象に変更しつつ保有確認も残すための設定)
 */
const { jstIso } = require("./util");

const H = 3600 * 1000;

/** イベント1件に適用するウィンドウ時間(hours)を返す。対象外ならnull */
function windowHoursFor(evTypes, pairCfg, thresholds) {
  const watch = pairCfg.watch_events || [];
  const matched = evTypes.filter((t) => watch.includes(t));
  if (matched.length === 0) return null;
  const profileKey = pairCfg.window_profile === "short" ? "short" : "standard";
  const profile = thresholds.event_windows_hours[profileKey];
  // 複数type該当時は最も広いウィンドウを採用(保守側)
  let best = null;
  for (const t of matched) {
    const cls = thresholds.event_class_by_type[t] || "indicator";
    const w = profile[cls] || profile.indicator;
    if (!best || w.pre > best.pre || (w.pre === best.pre && w.post > best.post)) {
      best = { ...w, class: cls, matched_types: matched };
    }
  }
  return best;
}

/**
 * ペアのイベント状態を計算。
 * 返り値: { in_event_window, active, next_48h }
 * - active: 現在時刻を含むウィンドウの根拠イベント一覧
 * - next_48h: 48時間先までの関連イベント(監視通貨のHigh、または監視typeマッチ)
 */
function computeEventState(pairCfg, events, thresholds, now = new Date()) {
  const nowMs = now.getTime();
  const h48 = 48 * H;
  const active = [];
  const next48 = [];

  for (const ev of events) {
    const w = windowHoursFor(ev.types, pairCfg, thresholds);
    const isWatchHigh =
      (pairCfg.watch_currencies || []).includes(ev.currency) && ev.impact === "High";

    if (w) {
      const start = ev.time_ms - w.pre * H;
      const end = ev.time_ms + w.post * H;
      if (nowMs >= start && nowMs <= end) {
        active.push(entryOf(ev, w, start, end));
      }
    }
    if ((w || isWatchHigh) && ev.time_ms > nowMs - 2 * H && ev.time_ms <= nowMs + h48) {
      const e = entryOf(ev, w, w ? ev.time_ms - w.pre * H : null, w ? ev.time_ms + w.post * H : null);
      e.gating = !!w;
      next48.push(e);
    }
  }
  return { in_event_window: active.length > 0, active, next_48h: next48 };
}

function entryOf(ev, w, startMs, endMs) {
  return {
    time_jst: jstIso(new Date(ev.time_ms)),
    currency: ev.currency,
    impact: ev.impact,
    title: ev.title,
    types: ev.types,
    window_start_jst: startMs !== null ? jstIso(new Date(startMs)) : null,
    window_end_jst: endMs !== null ? jstIso(new Date(endMs)) : null,
  };
}

/**
 * VR保有確認フラグ(USDJPY・週次ルール5の自動化)。
 * 金曜15:00JST以降・土曜、または日銀イベントの専用ウィンドウ内でtrue。
 * 停止指示ではなくリマインダー。
 */
function vrHoldCheck(events, thresholds, now = new Date()) {
  const cfg = thresholds.vr_hold_flag;
  const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const reasons = [];
  if (
    (jst.getDay() === cfg.weekend_from_dow_jst && jst.getHours() >= cfg.weekend_from_hour_jst) ||
    jst.getDay() === 6
  ) {
    reasons.push("weekend_approach");
  }
  const nowMs = now.getTime();
  for (const ev of events) {
    if (!ev.types.includes("boj")) continue;
    const start = ev.time_ms - cfg.boj_pre_hours * H;
    const end = ev.time_ms + cfg.boj_post_hours * H;
    if (nowMs >= start && nowMs <= end) {
      reasons.push(`boj_window:${ev.title}`);
    }
  }
  return { flag: reasons.length > 0, reasons };
}

/**
 * フラグ合成。
 * state: { regime, spike_flag, in_event_window, active_events, vr_hold }
 */
function composeFlags(pairCfg, state) {
  const profile = pairCfg.window_profile;
  const reasons = [];

  if (profile === "hold_flag_only") {
    const vr = state.vr_hold || { flag: false, reasons: [] };
    return { vr_hold_check: vr.flag, reasons: vr.reasons };
  }

  // standard / short: ゲートフラグ
  // monitor_only(XAUUSD): 同じ判定を「参考」として算出し monitor_only: true を併記
  // (EA側ゲート接続の対象外である点は変わらない。2026-07-20仕様変更)
  const regime = state.regime;
  const spike = !!state.spike_flag;
  const inWin = !!state.in_event_window;

  const haltAll = regime === "extreme" || spike;
  if (regime === "extreme") reasons.push("regime:extreme");
  if (spike) reasons.push("spike:range_vs_adr");

  const noNewGrid = haltAll || regime === "highvol" || inWin;
  if (regime === "highvol") reasons.push("regime:highvol");
  if (inWin) {
    for (const a of state.active_events || []) {
      reasons.push(`event:${a.title}`);
    }
    if ((state.active_events || []).length === 0) reasons.push("event:window");
  }

  const flags = { no_new_grid: noNewGrid, halt_all_new: haltAll, reasons };
  if (profile === "monitor_only") flags.monitor_only = true;
  // hold_check: ゲートフラグに保有確認リマインダーを併記(USDJPY・2026-07-31仕様変更)
  if (pairCfg.hold_check) {
    const vr = state.vr_hold || { flag: false, reasons: [] };
    flags.vr_hold_check = vr.flag;
    for (const r of vr.reasons) reasons.push(`hold:${r}`);
  }
  return flags;
}

module.exports = { computeEventState, composeFlags, vrHoldCheck, windowHoursFor };
