# 指示書: Studio ↔ Manager WS プロトコル pack → kit rename（atomic）

_作成: 2026-04-25_
_関連メモリ: `../docs/agent-memory/project_pack_to_kit_migration.md`_
_前提: Manager 側の TCP rename 完了済み_
_ペア指示書: `hapbeat-manager/instructions/instructions-pack-to-kit-ws-202604251200.md`_

## 背景

Studio はすでに UI・内部識別子で「Kit」を採用済みだが、Manager に送る WS メッセージは `deploy_pack` 系の旧名のまま。Manager とアトミックに変更する。

## スコープ

### 1. WS 送信側

- `src/hooks/useManagerWs.ts` または `src/services/managerClient.ts` 相当で:
  - `{ type: "deploy_pack", ... }` → `{ type: "deploy_kit", ... }`
  - `{ type: "deploy_pack_data", ... }` → `{ type: "deploy_kit_data", ... }`
  - payload: `pack_id` → `kit_id`, `pack_dir` → `kit_dir`

### 2. TypeScript 型定義

- ws message 型定義を更新
- 旧型 alias を残さない

### 3. 呼び出し側

- Kit Manager 画面の Deploy 処理
- auto-deploy 系の処理（あれば）

### 4. WebSocket Context

- `../docs/agent-memory/feedback_web_to_localhost_websocket.md` でシングルトン化済み Context。この Context の内部も必要に応じて更新

## やってはいけないこと

- Manager 側の対応前に Studio を先にデプロイ（devtools.hapbeat.com に反映されるタイミングに注意）
- 旧型 alias を残す

## 完了条件

- [ ] 全 WS 送信が `deploy_kit` / `kit_id` / `kit_dir`
- [ ] `grep -rn 'deploy_pack\|pack_id\|pack_dir' src/` が 0 件
- [ ] Manager と連動 smoke test: Deploy → 実機転送が通る
- [ ] commit + push
- [ ] deploy が devtools.hapbeat.com/studio/ に反映されたことを確認（Manager 側 deploy とタイミングを合わせる）
- [ ] この指示書を `instructions/completed/` に移動

## 検証

Manager 側と同じ検証フローを共有。両方揃って初めて E2E 成功。

## 次の指示書

- `hapbeat-sdk-workspace/docs/instructions-pack-to-kit-cleanup-202604251200.md`
