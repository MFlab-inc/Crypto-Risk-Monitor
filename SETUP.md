# Crypto Risk Monitor セットアップ手順(約15分)

EA-Risk-Monitorのときと同じ流れです。

## 1. リポジトリ作成
GitHub(MFlab-inc)で **New repository** → 名前 `Crypto-Risk-Monitor` → **Public** → README等は追加せずCreate。
※リポジトリ名を変える場合、ダッシュボード相互リンクのURLも変わるので教えてください。

## 2. ファイル一式をアップロード
zipを解凍 → `Crypto-Risk-Monitor` フォルダを開く → 中身**すべて**(`.github`・`config`・`data`・`scripts`・`test` の5フォルダと `index.html`・`README.md`・`package.json`・`SETUP.md`)を選択 → **Add file → Upload files** にドラッグ → Commit changes。

アップロード後、ファイル一覧に `.github/workflows`(init.yml / daily.yml / intraday.yml の3つ)が見えることを確認。
※`.github` が見えない・入らなかった場合は、EA-Risk-Monitorのときと同じく `.github` フォルダだけを追加でドラッグ。

## 3. APIキー登録
Settings → Secrets and variables → Actions → **New repository secret**
- Name: `TWELVE_DATA_API_KEY`
- Secret: 既存と同じキー(Grow 55のキー)

## 4. GitHub Pages有効化
Settings → Pages → Branch: `main` / `(root)` → Save。
公開URL: `https://mflab-inc.github.io/Crypto-Risk-Monitor/`

## 5. 初期化実行
Actionsタブ →(初回は有効化ボタンを押す)→ **Init History (Crypto Phase 0)** → Run workflow。

ログで3銘柄とも `OK: BTCUSD 5xx本 …` になっていれば完了。
**BTC/ETH/BNBがTwelve Dataで取得できるかの実確認を兼ねています**——もしFAILの銘柄があればログの文言を教えてください(他銘柄には影響しません)。

## 6. 確認
数分後にダッシュボードを開き、3銘柄のカード・エントリー判定・「D1(UTC)」表示を確認。
日中バッチは毎時2,4,22,28,34,52,57,59分(24/7)、日次バッチは毎日JST 13:47頃に自動実行されます。
