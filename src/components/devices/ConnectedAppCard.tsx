import type { DeviceInfo } from '@/types/manager'

interface ConnectedAppCardProps {
  device: DeviceInfo
  /** 直近 get_info で得た app 接続状態。`infoCache[ip]` の subset。 */
  cachedInfo: {
    app_connected?: boolean
    app_name?: string
    app_device?: string
  } | undefined
}

/**
 * 接続中のクライアントアプリ表示カード。
 *
 * SDK (Unity / Unreal / etc.) は `CONNECT_STATUS` (0x20) ペイロードを
 * 周期的にデバイスへ送り、`app_name` をデバイスに通知している。
 * デバイスは `get_info` レスポンスで `app_connected` / `app_name` /
 * `app_device` を返すので、それを Studio で可視化する。
 *
 * 表示パターン:
 *   - device offline           → 「デバイスがオフラインです」
 *   - app_connected = true     → ● 緑 + app_name (+ app_device があれば)
 *   - app_connected = false    → ○ 灰 + 「アプリ未接続」
 *
 * ユーザーが手動で再取得したい場合は、上の「⟳ デバイスから読み込み」
 * ボタン (DeviceDetail) で get_info が再発行されカードも更新される。
 */
export function ConnectedAppCard({ device, cachedInfo }: ConnectedAppCardProps) {
  const offline = !device.online
  const connected = cachedInfo?.app_connected === true
  const appName = (cachedInfo?.app_name ?? '').trim()
  const appDevice = (cachedInfo?.app_device ?? '').trim()

  // Status dot color via existing pill / indicator vocabulary so this
  // card matches the rest of the Devices tab visually without new CSS.
  const dotColor = offline
    ? 'var(--text-muted)'
    : connected
      ? '#4caf50'
      : 'var(--text-muted)'

  let body: React.ReactNode
  if (offline) {
    body = <span style={{ color: 'var(--text-muted)' }}>デバイスがオフラインです</span>
  } else if (connected && appName) {
    body = (
      <>
        <strong style={{ color: 'var(--text-primary)' }}>{appName}</strong>
        {appDevice && (
          <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>
            → {appDevice}
          </span>
        )}
      </>
    )
  } else {
    body = <span style={{ color: 'var(--text-muted)' }}>アプリ未接続</span>
  }

  return (
    <div className="form-section">
      <div className="form-section-title">接続中アプリ</div>
      <div
        className="form-row"
        style={{ display: 'flex', alignItems: 'center', gap: 8 }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: dotColor,
            display: 'inline-block',
            flexShrink: 0,
          }}
        />
        <span style={{ flex: 1 }}>{body}</span>
      </div>
      {!offline && !connected && (
        <div
          className="form-help"
          style={{
            color: 'var(--text-muted)',
            fontSize: 12,
            marginTop: 4,
          }}
        >
          SDK 側で `HapbeatConfig.appName` を設定し、対象デバイスを正しい
          group に向けて起動すると表示されます (Unity SDK は `HapbeatManager`
          が自動で CONNECT_STATUS を送信)。
        </div>
      )}
    </div>
  )
}
