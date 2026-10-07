# Plugin Agent Chat

ユーザーが自分の MCP サーバーと Agent Skills (`SKILL.md`) をプラグインとして登録できるエージェントチャットです。Cloudflare Workers 上で動き、エージェント本体は Agents SDK の `PiHarness` が Durable Object の中で動かす Pi Durable です。UI は [Beautiful UI](https://www.beautifului.dev) のコンポーネントを実データ駆動に書き換えて使っています。

## 構成

ユーザー 1 人につき `UserAgent` Durable Object が 1 つあります。プラグイン、会話履歴、MCP 接続、OAuth トークン、ChatGPT の接続情報はすべてその Durable Object の SQLite に入ります。

```mermaid
flowchart LR
  B[Browser<br/>React + useAgent] -- WebSocket --> W[Worker<br/>Hono + routeAgentRequest]
  W -- Access JWT で本人確認 --> DO[UserAgent<br/>Durable Object]
  DO --> PI[PiHarness<br/>pi-durable]
  PI --> AI[OpenAI Responses API<br/>ChatGPT プラン]
  DO --> BOOK[PluginBook]
  BOOK -- registry.install --> PI
  BOOK --> MCP[Agents SDK MCP client]
  MCP --> R[リモート MCP サーバー]
  DO --> HUB[ChatHub + Transcript]
  HUB -- chat.tail frame --> B
```

- `src/server/agent.ts` は Durable Object 本体です。`@callable` メソッドがブラウザからの操作口になります。
- `src/server/chatgpt.ts` は Sign in with ChatGPT による接続、トークンの保存と更新、モデルの選択を持ちます。
- `src/server/plugins/book.ts` はプラグインの保存と、有効なプラグインを pi の registry に反映する処理を持ちます。MCP のツール一覧はキャッシュするので、コールドスタート直後でもネットワークを待たずにツールが揃います。
- `src/server/chat/transcript.ts` は pi のイベントを画面用の `Turn` に畳み込む純粋な reducer です。
- `src/shared/protocol.ts` はブラウザとサーバーの契約です。pi や SDK の型はここに出しません。
- `src/client/` は React の UI です。`use-workspace.ts` が接続と状態をまとめます。

## ローカルで動かす

モデル呼び出しはすべて、ユーザーが接続した ChatGPT プランで動きます (Sign in with ChatGPT)。開発中も OpenAI の API を呼ぶので、プランの利用枠を消費します。

1. 依存を入れます。

   ```sh
   pnpm install
   ```

2. 開発用の認証モードを有効にします。`AUTH_MODE=dev` では全リクエストが 1 人のユーザー `u-dev` として扱われます。

   ```sh
   cp .dev.vars.example .dev.vars
   ```

3. 開発サーバーを起動して `http://localhost:5173` を開き、ChatGPT を接続します ([ChatGPT を接続する](#chatgpt-を接続する))。

   ```sh
   pnpm dev
   ```

ブラウザは secure context (`localhost` か `https://`) で開いてください。Agents SDK のクライアントは `crypto.randomUUID` を使うので、`http://` で別ホストから開くと接続できません。

## デプロイする

本番では Cloudflare Access でログインしたユーザーごとに Durable Object が分かれます。Worker は `Cf-Access-Jwt-Assertion` を検証し、`iss` と `sub` から Durable Object 名を作ります。

1. Zero Trust で Self-hosted の Access アプリケーションを作り、Worker のホスト名を保護します。`workers.dev` のルートを使わない場合は無効にします。
2. `wrangler.jsonc` の `vars` に `ACCESS_TEAM_DOMAIN` (例 `myteam.cloudflareaccess.com`) と `ACCESS_AUD` (アプリケーションの AUD タグ) を設定します。`AUTH_MODE` は `access` のままにします。
3. デプロイします。

   ```sh
   pnpm run deploy
   ```

## ChatGPT を接続する

初めて開くとチャット欄に **Connect ChatGPT** が出ます。押すと **Open ChatGPT sign-in** のリンクが出るので、別タブで開いて承認します。承認後のタブは `http://127.0.0.1:1455/auth/callback?...` に移って接続エラーになります。そのタブのアドレスをコピーしてカードに貼り、**Finish** を押します。

接続すると、プランで使えるモデルのうち pi が扱えるものがチャット欄のモデル選択に並びます。既定は `gpt-5.6-luna` で、プランに無ければ一覧の先頭を使います。選んだモデルはすべての会話に反映されます。サイドバー下部の **Disconnect** で接続を解除できます。

アクセストークンは 1 時間で切れ、期限の 5 分前から次のモデル呼び出しで更新します。リフレッシュトークンは更新のたびに替わるので、新しいものを Durable Object に保存します。トークンはブラウザには送りません。

## プラグインを追加する

サイドバーの **Plugins** から追加します。追加・無効化・削除は、エージェントの次のステップから反映されます。

- **MCP server**: 名前と URL を入れます。API キーが必要なサーバーは **Header** でヘッダーを足します。ヘッダーの値は Durable Object の中にだけ保存され、画面には名前しか戻りません。OAuth が必要なサーバーでは **Authorize** リンクが出るので、別タブで認可してください。
- **Skill (paste)**: `name` と `description` の frontmatter を持つ `SKILL.md` を貼り付けます。
- **Skill (URL)**: `SKILL.md` の https URL を入れます。GitHub の `blob` URL は raw に読み替えます。

チャット欄で `/` を打つと有効なスキル、`@` を打つとプラグインの一覧と有効・無効の切り替えが出ます。

## 動作を確認する

型検査とビルドです。

```sh
pnpm typecheck
pnpm build
```

`scripts/smoke.mjs` は起動中の開発サーバーに対して、ChatGPT プランの接続、プラグインの登録、MCP ツールの実行、スキルの読み込み、ヘッダー値・URL クエリ・ChatGPT のトークンがブラウザ向けフレームに出ないことを確かめます。開発サーバーを再起動したあとに `--after-restart` を付けて流すと、ChatGPT の接続、プラグイン、履歴がコールドスタートを越えて残ることを確かめます。

まだ接続していない Durable Object に対しては、`SMOKE_CHATGPT_CRED` に資格情報ファイル (`{clientId, access, refresh, expires, scope}` の JSON) のパスを渡すと、`importChatGPTCredential` で取り込んでから進みます。この取り込みは `AUTH_MODE=dev` でだけ使えます。リフレッシュトークンは使い捨てなので、同じファイルを取り込むのは 1 回だけにしてください。

```sh
HOST=127.0.0.1:5173 SMOKE_CHATGPT_CRED=/path/to/cred.json node scripts/smoke.mjs
HOST=127.0.0.1:5173 SMOKE_CHATGPT_CRED=/path/to/cred.json node scripts/smoke.mjs --after-restart
```

## 制約

- MCP のヘッダー値と OAuth トークンは、Agents SDK が Durable Object の SQLite に平文で保存します。ChatGPT のトークンも同じ SQLite に平文で保存します。暗号化はしていません。
- スキルは `SKILL.md` 本文だけを扱います。`references/` や `scripts/` などの付属ファイルは読み込みません。
- ツール実行前の承認フローはありません。
- MCP のツール呼び出しはクラッシュ後に再実行しません。中断されたツールはエラーとしてモデルに返ります。
- UI は Beautiful UI のレジストリ `https://www.beautifului.dev/r/<name>.json` から取り込んだコンポーネントを改変したものです。ライセンス表記は `THIRD_PARTY_NOTICES.md` にあります。
