/**
 * Phase 0: D1履歴の一括初期化(手動1回・workflow_dispatch)
 *
 * 既定: Twelve Data APIから各銘柄560本(365暦日パーセンタイル+ウォームアップ+余裕)を取得。
 * 代替: `node scripts/init-history.js --csv <dir>` で MT5エクスポートCSVから取込
 *       (<dir>/BTCUSD.csv のように銘柄コード名のファイルを置く)。
 *
 * 取得後に検証(本数・重複・OHLC整合・ギャップ)を行い、合格ペアのみ保存。
 * 最後に日次計算を実行して risk-feed.json の初版を生成する。
 */
const fs = require("fs");
const path = require("path");
const { sleep, loadConfigs, jstIso } = require("./lib/util");
const { lastCompletedSessionDate } = require("./lib/session");
const { fetchDailyBars } = require("./lib/twelvedata");
const { saveHistory, validateBars } = require("./lib/history");
const { parseCsv } = require("./lib/csv");

// 560暦日(約1.5年)を取得し、365暦日パーセンタイル+ATR/RVウォームアップ+余裕を確保。
// 保存時はhistory_keep_bars(500)に切詰め。
const OUTPUTSIZE = 560;

async function main() {
  const { pairs, thresholds, pairKeys } = loadConfigs();
  const csvFlag = process.argv.indexOf("--csv");
  const csvDir = csvFlag >= 0 ? process.argv[csvFlag + 1] : null;
  const cutoff = lastCompletedSessionDate(new Date());
  console.log(`初期化開始 ${jstIso(new Date())} / 確定セッション: ${cutoff} / モード: ${csvDir ? "CSV取込" : "Twelve Data API"}`);

  const failed = [];
  for (const key of pairKeys) {
    const cfg = pairs[key];
    try {
      let bars;
      if (csvDir) {
        const file = path.join(csvDir, `${key}.csv`);
        if (!fs.existsSync(file)) throw new Error(`CSVがありません: ${file}`);
        bars = parseCsv(fs.readFileSync(file, "utf8")).filter((b) => b.date <= cutoff);
      } else {
        bars = await fetchDailyBars(cfg.symbol, { outputsize: OUTPUTSIZE, cutoffDate: cutoff });
        await sleep(1500); // レート制限対策(取得間隔を空ける)
      }
      const v = validateBars(bars, { minBars: 270 });
      for (const w of v.warnings) console.warn(`  警告(${key}): ${w}`);
      if (!v.ok) throw new Error(v.errors.join(" / "));
      saveHistory(key, cfg.symbol, bars, thresholds.history_keep_bars);
      console.log(`OK: ${key} ${bars.length}本 (${bars[0].date} 〜 ${bars[bars.length - 1].date})`);
    } catch (e) {
      console.error(`FAIL: ${key} - ${e.message}`);
      failed.push(key);
    }
  }

  if (failed.length > 0) {
    console.error(`初期化失敗ペア: ${failed.join(", ")}(保存されていません。再実行してください)`);
    process.exit(1);
  }

  // 初版フィード生成(日次計算を実行)
  console.log("risk-feed.json 初版を生成します…");
  await require("./daily").run({ skipFetch: true });
  console.log("初期化完了");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
