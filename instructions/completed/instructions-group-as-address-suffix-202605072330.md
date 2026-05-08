# Identity Form の Address に Group suffix を統合

**作成日:** 2026-05-07
**起点セッション:** workspace `objective-ishizaka-2ddfb6` worktree (リリース直前 QA)
**優先度:** 高 (リリース時に Studio から group 設定できないと per-event group filter が運用できない)
**spec 参照:** `hapbeat-contracts/specs/device-addressing.md` §2 (改定後)

**関連:**
- unity-sdk: EventMap UI で per-event group field 対応済 (commit `fecd89e`)
- device-firmware: `instructions/instructions-group-as-address-suffix-202605072300.md` (group ボタン操作 + address 組み立てを新 spec に追従)

---

## 背景

contracts spec §2 改定で、device address 末尾に **任意セグメント `group_<N>` を追加可能** になった。format:

```
[自由プレフィックス/] player_{N} / {position} [/group_{M}]
```

unity-sdk 側は EventMap entry の Targeting で per-event group が設定できるようになり、target string に `group_<N>` suffix が含まれる。

device 側でこの target を正しく受信するには、device 自身の `s_device_address` にも対応する `group_<N>` suffix を含める必要がある。device firmware には別途指示書 (`instructions-group-as-address-suffix-202605072300.md`) で対応中。

**Studio はそのアドレス設定の主要 GUI** なので、こちらも group suffix に対応する必要がある。現状は player + position だけで address を組み立てており、group は別 (旧仕様の) `set_group` (uint8) で管理されている。

## 現状の実装

`src/components/devices/IdentityForm.tsx`:

- 入力 UI: Prefix (text) + Player (int) + Position (dropdown) + Group (int, 0-255)
- Address 部分は `buildAddress(prefix, player, position)` で `[prefix/]player_N/pos_X` を組み立て、`set_address` コマンドで送信
- Group 部分は別途 `set_group` コマンドで uint8 を送信

`src/components/devices/positions.ts`:

- `parseAddress(address)` → `{ prefix, player, position }` の 3 要素のみ抽出
- `buildAddress(prefix, player, position)` → group なしで組み立て

## 変更ファイル

### 1. `src/components/devices/positions.ts` — group 対応

`parseAddress` の戻り値に group を追加:

```ts
export function parseAddress(address: string): {
  prefix: string
  player: number
  position: string
  group: number   // ★ 追加: -1 = 未指定 (group suffix なし) / 1..99 = 指定あり
} {
  if (!address) return { prefix: '', player: 1, position: 'pos_chest', group: -1 }
  const parts = address.split('/')

  // group_<N> が末尾にあるかチェック
  let group = -1
  if (parts.length >= 1 && parts[parts.length - 1].startsWith('group_')) {
    const gStr = parts[parts.length - 1].slice(6)
    const gNum = Number(gStr)
    if (Number.isFinite(gNum) && gNum >= 1 && gNum <= 99) {
      group = gNum
      parts.pop()  // group_<N> を除去してから player/position を抽出
    }
  }

  if (parts.length < 2) {
    return { prefix: '', player: 1, position: 'pos_chest', group }
  }
  const playerStr = parts[parts.length - 2]
  const position = parts[parts.length - 1]
  const prefix = parts.slice(0, -2).join('/')
  let player = 1
  if (playerStr.startsWith('player_')) {
    const n = Number(playerStr.slice(7))
    if (Number.isFinite(n) && n > 0) player = n
  }
  return { prefix, player, position, group }
}

export function buildAddress(
  prefix: string,
  player: number,
  position: string,
  group: number = -1,
): string {
  const tail = `player_${player}/${position}`
  let addr = prefix.trim() ? `${prefix.trim()}/${tail}` : tail
  if (group >= 1 && group <= 99) {
    addr += `/group_${group}`
  }
  return addr
}
```

### 2. `src/components/devices/IdentityForm.tsx` — Group を address 経由に統合

#### 2-A. State に group を追加

```ts
const initial = parseAddress(device.address)
const [prefix, setPrefix] = useState(initial.prefix)
const [player, setPlayer] = useState<number>(initial.player)
const [position, setPosition] = useState<string>(initial.position)
const [group, setGroup] = useState<number>(initial.group)   // ★ 追加 (-1 = 未指定)
```

`groupStr` (旧 cachedInfo.group 由来の uint8 表示用) は廃止。group の source of truth は address に統一。

#### 2-B. UI: Position の下に Group 入力枠を追加

Position の下に Group IntField (1〜99 / -1=未指定) を追加。プレースホルダーで「未指定 = 全グループ」を表示。

```tsx
{/* Position の下に Group を追加 */}
<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
  <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>group_</span>
  <input
    type="number"
    min={-1}
    max={99}
    value={group < 1 ? '' : group}
    placeholder="未指定 (全グループ)"
    onChange={(e) => {
      const v = e.target.value
      if (v === '') setGroup(-1)
      else {
        const n = Number(v)
        if (Number.isFinite(n) && n >= 1 && n <= 99) setGroup(n)
      }
    }}
    onBlur={submitAddress}
    onKeyDown={(e) => { if (e.key === 'Enter') submitAddress() }}
    style={{ width: 80 }}
  />
  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
    1〜99 で指定、空欄で全グループ
  </span>
</div>
```

#### 2-C. submitAddress を group 込みで送信

```ts
const submitAddress = () => {
  const addr = buildAddress(prefix, player, position, group)
  sendTo({ type: 'set_address', payload: { address: addr } })
  if (prefix.trim()) prefixHistory.commit(prefix.trim())
  onChanged?.()
}
```

#### 2-D. 旧 group input + submitGroup を削除

`groupStr` state、`set_group` command 送信、関連 UI を削除。Group は address 経由でのみ更新される。

```diff
- const [groupStr, setGroupStr] = useState(String(cachedInfo?.group ?? 0))
- const submitGroup = () => {
-   const g = Number(groupStr)
-   if (!Number.isFinite(g) || g < 0 || g > 255) return
-   sendTo({ type: 'set_group', payload: { group: g } })
-   onChanged?.()
- }
```

UI 上の旧 group input フィールドも削除。

#### 2-E. effect で device.address 変化を監視して全 state 更新

```ts
useEffect(() => {
  const a = parseAddress(device.address)
  setPrefix(a.prefix)
  setPlayer(a.player)
  setPosition(a.position)
  setGroup(a.group)   // ★ 追加
}, [device.ipAddress, device.address, device.name, cachedInfo?.name])
// cachedInfo.group は依存から削除
```

### 3. `src/types/manager.ts` — `set_group` コマンドの位置付け

`set_group` コマンド型自体は残しても良い (firmware 側でしばらく旧コマンドを受け取る可能性) が、Studio 側からは送らない。新規コードからは使用禁止 (deprecated コメント追加)。

完全削除は device-firmware の対応完了後に再検討。

---

## 動作確認

1. Studio で device を選択 → Identity Form に Prefix / Player / Position / Group が並ぶ
2. Group を空欄 → device address = `player_1/pos_chest` (group なし)
3. Group = `5` → device address = `player_1/pos_chest/group_5`
4. address 入力後、device の OLED に新 address が反映されることを確認
5. Unity SDK の EventMap entry で target = `*/*/group_5` → この device のみ振動
6. Studio 再起動後も group が復元される (NVS 永続化が device 側で動いていれば)

## 互換性メモ

- 旧 `set_group` (uint8) を device firmware が受け取る間は併存可。Studio からは新 `set_address` 経由のみ送信
- リリース前 repo (後方互換コードを作らない方針) なので、デバイス側 firmware が新仕様に追従し次第 `set_group` の type 定義も削除する

## 参考

- 既存 `parseAddress` / `buildAddress` 実装: `src/components/devices/positions.ts:34-56`
- 既存 IdentityForm: `src/components/devices/IdentityForm.tsx`
- contracts spec: `hapbeat-contracts/specs/device-addressing.md` §2 (改定後)
- unity-sdk EventMap UI: 同等の Group 入力枠を実装済み (`HapbeatEventMapWindow.cs` `BuildTargetFromParts`)

---

## 実装後

- 動作確認できたら本ファイルを `instructions/completed/` に移動
- workspace `docs/decision-log.md` の DEC-030 (group_<N> suffix 採用) に Studio 側完了状況を追記
