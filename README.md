# Crypto Risk Monitor

暗号資産3銘柄(BTC/USD・ETH/USD・BNB/USD)専用のリスク計測・デリスク判定フィード。
GitHub Actions が市場データを定期取得し、`data/risk-feed.json` と運用者向けダッシュボード(`index.html`)を GitHub Pages で配信する。

- 全銘柄24/7取引。日足は**UTC暦日区切り**(00:00 UTCクローズ)、指標はすべて**暦日ベース**
- 本リポジトリは市場データと市場判定のみを扱う。**EA名・マジックナンバー・配分・ロット・口座情報・停止ライン額は一切含まない**(それらはVPS側で管理)
- 事実データであり売買助言ではない
- FXポートフォリオ用の [EA-Risk-Monitor](https://github.com/MFlab-inc/EA-Risk-Monitor) から実証済み設計を流用した姉妹システム(リポジトリは独立・相互に干渉しない)。ダッシュボード: [EA Risk Monitor](https://mflab-inc.github.io/EA-Risk-Monitor/)

## 構成

| 処理 | ファイル | スケジュール |
|---|---|---|
| Phase 0 初期化(日足560本×3銘柄) | `scripts/init-history.js` | 手動1回(Actions → Init History) |
| 日次バッチ(指標計算・フィード生成) | `scripts/daily.js` | 毎日 04:47 UTC(JST 13:47) |
| 日中バッチ(急変検知・イベント窓再判定) | `scripts/intraday.js` | 1時間8回・24/7(週末スキップなし) |

データ取得元: Twelve Data API(日足・当日クオート) / Yahoo Finance(DXY・US10Y・VIX 参考) / Forex Factory(経済カレンダー今週+来週)。

## 計算定義

すべて日足確定足(UTC暦日・00:00 UTCクローズ)基準。

| 項目 | 定義 |
|---|---|
| TR | max(H−L, \|H−前日C\|, \|L−前日C\|) |
| ATR14 | Wilder平滑(初期値=最初の14本のTR単純平均、以後 (前ATR×13+TR)/14)。EA-Risk-Monitorと同一定義 |
| ATR% | ATR14 ÷ 終値 × 100(%表記) |
| ADR20 | 直近20暦日の(H−L)単純平均 |
| RV20 | 直近20個の日次対数リターンの標本標準偏差(n−1) × **√365** × 100(年率%表記。24/7取引のため暦日365で年率化) |
| パーセンタイル | 直近**365暦日**(当日含む)のATR%系列中、当日値以下の割合×100(最低180日で算出開始) |
| レジーム | 平常 p<50 / 注意 50≤p<80 / 高ボラ 80≤p<95 / 異常 p≥95(境界は上位区分=保守側) |
| 急変フラグ | 当日(UTC)レンジ(H−L) ÷ ADR20 が **1.50超**(進行中急変の検知) |
| イベント窓 | 監視イベントの [発表−pre, 発表+post]。FOMC=前24h/後2h、米CPI・米雇用統計=前12h/後1h |

**閾値はすべて仮置き**(`config/thresholds.json`)。`data/archive/` の日次スナップショット蓄積による実測後に確定する(EA-Risk-Monitorと同じ2段階方式)。

## フラグ(アクション接続)

| フラグ | 条件 | 意味 |
|---|---|---|
| `no_new_grid` | レジーム高ボラ以上 or イベント窓内 | 新規グリッド開始・段数追加の禁止(3銘柄すべてで算出) |
| `halt_all_new` | レジーム異常 or 急変フラグ | 新規全停止(3銘柄すべてで算出) |

既存バスケットのTP決済は常時許可(フィードは「新規」に関する判定のみを配信)。
どのEAがどのフラグに従うかは本リポジトリでは定義しない(VPS側)。

## risk-feed.json の読み方(EA側接続向け)

- `meta.generated_daily / generated_intraday / generated_calendar`: 各セクションの生成時刻(JST表記)
- `pairs.<SYMBOL>.data_ok`: false の場合、その銘柄の日次値は前回値のまま(取得失敗)。`meta.errors` に理由
- `pairs.<SYMBOL>.flags`: 上表のフラグと `reasons`(根拠の列挙)

## 既知の制約

1. GitHub Actions の scheduled cron は高負荷時に遅延・間引きされ得る(特に00:00〜04:00 UTC)。急変フラグは間隔判定でありリアルタイム検知ではない。実行分は混雑しやすい「キリの良い分」を避けて設定している
2. Twelve Data の日足(UTC区切り)とブローカー(MT5・GMT+2/+3等)の日足は区切りが異なるため、数値は厳密には一致しない。厳密整合が必要な場合は `node scripts/init-history.js --csv <dir>` でMT5エクスポートCSVから初期化可能
3. BTC/ETH/BNBのTwelve Dataでの取得可否・履歴本数は、初回のInit実行ログで実確認する(不可・不足の銘柄はFAILとして明示され、他銘柄に影響しない)
4. Twelve Data Grow 55プラン(55クレジット/分・日次上限なし)をFXDaily-Levels・EA-Risk-Monitorと共有するため、実行分をずらしている(日中: 2,4,22,28,34,52,57,59分)。消費は日中1回=3クレジットと軽微
5. 閾値(50/80/95・150%・イベント窓時間)はすべて仮置きであり有効性は未検証。稼働後の実測で確定する

## テスト

```
npm test   # 計算ロジック検証20件(ネットワーク不要)
```
