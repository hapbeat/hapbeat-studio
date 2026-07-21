import { useEffect, useRef, useState } from 'react'
import { useDeviceStore } from '@/stores/deviceStore'
import { useSerialMaster } from '@/stores/serialMaster'
import { isWebSerialSupported } from '@/utils/serialConfig'
import { FirmwareSubTab } from './FirmwareSubTab'
import { DriverHelpLinks } from './DriverHelpLinks'
import './OnboardingWizard.css'

const SERIAL_DEVICE_PREFIX = 'serial:'

type Step = 'probe' | 'flash' | 'configure'

/**
 * One-track onboarding wizard. Drives all serial activity through the
 * `serialMaster` store — never touches `navigator.serial` directly so
 * Studio's single-master invariant holds (see serialMaster.ts).
 *
 * Step transitions:
 *   probe (success)  → configure
 *   probe (failed)   → user clicks「先にファームウェアを書き込む」→ flash
 *   flash (done)     → master auto-runs post-flash reprobe → configure
 *   configure       → finish (sidebar pickup) or back to probe
 */
export function OnboardingWizard() {
  const mode = useSerialMaster((s) => s.mode)
  const probeStatus = useSerialMaster((s) => s.probeStatus)
  const probeMessage = useSerialMaster((s) => s.probeMessage)
  const conn = useSerialMaster((s) => s.conn)
  const release = useSerialMaster((s) => s.release)
  const flashLastResult = useSerialMaster((s) => s.flashLastResult)
  const selectedPortIds = useSerialMaster((s) => s.selectedPortIds)

  const [step, setStep] = useState<Step>('probe')

  // Primary onboarding path (user 2026-07-10): CHECKING a USB card (flash-target
  // selection) auto-advances to firmware flashing — no "connect" click needed.
  // The 設定 (config-connect) button is for AFTER flashing (Wi-Fi setup, Step 3).
  useEffect(() => {
    if (step === 'probe' && selectedPortIds.length > 0) setStep('flash')
  }, [selectedPortIds, step])

  // Auto-route based on probe outcome.
  //
  //   success → step 3 (set the Serial pseudo-device as the
  //             primary selection so the regular DeviceDetail
  //             sub-tab UI takes over the right pane)
  //   failed  → step 2 (firmware flash) immediately
  //
  // Keying on probeStatus (not mode) avoids the mid-handshake jump
  // where mode briefly flipped to 'config' before get_info returned.
  useEffect(() => {
    if (probeStatus === 'success' && mode === 'config' && conn && step === 'probe') {
      // espnow_stream receivers have no Wi-Fi — skip the Wi-Fi setup step
      // entirely and go directly to device view (espnow tab).
      const info = useSerialMaster.getState().info
      if (info?.transport === 'espnow_stream') {
        const id = `${SERIAL_DEVICE_PREFIX}${info.mac ?? 'active'}`
        useDeviceStore.getState().selectDevice(id)
        return
      }
      // Other devices: Step 3 へ遷移するだけ。selectDevice() で sidebar を
      // 切り替えると DeviceDetail が前面に出て OnboardingWizard が消えてしまう
      // ため、Wi-Fi 設定が完了するまでサイドバー切替は行わない (ユーザ要望
      // 2026-05-09: 「一般の設定に飛んでしまう」)。完了は Step 3 内の
      // 「完了して設定タブへ」ボタンで明示的に行う。
      setStep('configure')
      return
    }
    if (probeStatus === 'failed' && step === 'probe') {
      setStep('flash')
    }
  }, [probeStatus, mode, conn, step])

  // 書き込み成功 → 自動で Step 3 へ「その書き込み 1 回だけ」遷移する
  // (ユーザ要望 2026-05-09)。flashLastResult は成功後もストアに残るため、素の
  // `ok && step==='flash'` だと Step 2 に戻る/開くたびに再発火し、ユーザーが
  // 能動的にファーム書き込み(Step 2)を開いても Step 3 へ強制連行されてしまう
  // (user 2026-07-10:「能動的に押しても 3 に強制遷移する」)。結果オブジェクトの
  // 同一性で成功エッジだけを 1 回拾う: ref を現在値で初期化するので、mount 時に
  // 残っている古い成功結果では遷移せず、新しい書き込み(新オブジェクト)でのみ発火。
  const handledFlashRef = useRef(flashLastResult)
  useEffect(() => {
    if (flashLastResult?.ok && step === 'flash' && flashLastResult !== handledFlashRef.current) {
      handledFlashRef.current = flashLastResult
      setStep('configure')
    }
  }, [flashLastResult, step])

  // Step 3 中に conn が落ちても auto で Step 1 に戻さない (旧挙動を撤廃)。
  // ケーブル抜け / set_wifi 後 reboot / post-flash いずれも「Step 3 内で
  // 再接続」させる方が動線が短い (= ユーザ要望)。

  const goProbe = () => setStep('probe')

  return (
    <section className="onboarding-wizard">
      <header className="onboarding-wizard-header">
        <div className="onboarding-wizard-title">Hapbeat 初期セットアップ</div>
        <div className="onboarding-wizard-subtitle">
          USB ケーブル経由でデバイスを 3 ステップで初期設定します。
        </div>
      </header>

      <ol className="onboarding-stepper">
        <StepPill index={1} label="デバイス選択" state={stepStateFor('probe', step)}
          onClick={() => setStep('probe')} />
        <StepArrow />
        <StepPill index={2} label="ファーム書き込み" state={stepStateFor('flash', step)}
          onClick={() => setStep('flash')} />
        <StepArrow />
        <StepPill index={3} label="Wi-Fi 設定" state={stepStateFor('configure', step)}
          onClick={() => setStep('configure')}
          /* conn 無しでも Step 3 を開けるようにする (再接続 UI を出すため) */ />
      </ol>

      {!isWebSerialSupported() && (
        <div className="form-section">
          <div className="form-status err">
            このブラウザは Web Serial API をサポートしていません。
            Chrome / Edge を使ってください (HTTPS または http://localhost のみ動作)。
          </div>
        </div>
      )}

      {step === 'probe' && (
        <ProbeStep
          probeStatus={probeStatus}
          probeMessage={probeMessage}
        />
      )}

      {step === 'flash' && (
        <FlashStep onBack={goProbe} />
      )}

      {step === 'configure' && (
        <ConfigureStep
          hasConn={!!conn}
          probeStatus={probeStatus}
          probeMessage={probeMessage}
          onDisconnect={async () => { await release(); setStep('probe') }}
        />
      )}
    </section>
  )
}

// ---------------------------------------------------------------------
// Step renderers
// ---------------------------------------------------------------------

function ProbeStep({
  probeStatus,
  probeMessage,
}: {
  probeStatus: string
  probeMessage: string | null
}) {
  // 初回セットアップの主動線は「カードをチェック → 自動で書き込み」。書き込みは
  // チェック（書き込み対象の選択）だけで成立し、設定接続（⚙ 設定）は不要
  // (ユーザ要望 2026-07-10)。このステップは操作案内に徹し、チェックが入ると
  // 親の effect が自動で Step 2 へ進める。既にファーム入りのデバイスを設定だけ
  // したい場合の「⚙ 設定」接続 → Step 3 直行も probeStatus 監視で残している。
  return (
    <div className="form-section onboarding-step">
      <div className="form-section-title">Step 1 — USB デバイスを選ぶ</div>
      <div className="onboarding-step-body">
        <p>
          デバイスを USB ケーブルで PC に繋ぎ、
          <strong>左の「USB Serial」欄</strong>で選びます:
        </p>
        <ol className="onboarding-substeps">
          <li><strong>＋</strong> ボタンで USB 機器を追加（COM ポート選択ダイアログ）</li>
          <li>表示されたカードの<strong>チェックボックス ☑</strong> を入れる（書き込み対象に選択）</li>
        </ol>
        <p className="onboarding-step-routing-hint">
          チェックを入れると <strong>自動で Step 2（ファーム書き込み）</strong> へ進みます。
          複数チェックすれば同時書き込みもできます。
        </p>
        <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          ※「⚙ 設定」ボタンは<strong>書き込み後の Wi-Fi 設定用</strong>です（初回書き込みには不要）。
          既にファーム入りのデバイスを設定だけしたいときは「⚙ 設定」で接続すると Step 3 へ直行します。
        </p>
        {probeMessage && (
          <div className={`form-status ${
            // failed = 「ファーム未書込」など通常フローのケースが大半。
            // 赤エラー (err) ではなく info/muted で表示し、ユーザーに
            // 「異常が起きた」印象を与えない。
            probeStatus === 'success' ? 'ok' : 'muted'}`}
          >
            {probeMessage}
          </div>
        )}
        <DriverHelpLinks />
      </div>
    </div>
  )
}

function FlashStep({ onBack }: { onBack: () => void }) {
  return (
    <>
      <div className="form-section onboarding-step">
        <div className="form-section-title">Step 2 — ファームウェア書き込み</div>
        <div className="onboarding-step-body">
          <p>
            下のファームウェアライブラリで <strong>ノードの種類（Hapbeat / 周辺機器）</strong>
            のタブを選び、書き込むファームウェアを選んで「Serial 書き込み」を押してください。
          </p>
          <div className="form-status muted">
            👉 書き込み完了後、自動で Step 3 (Wi-Fi 設定) に進みます。
            その後デバイスの<strong> 電源を一度 OFF→ON </strong>してから、
            左の USB Serial カードの<strong>「⚙ 設定」ボタン</strong>で設定接続してください。
          </div>
          <div className="form-action-row" style={{ marginTop: 8 }}>
            <button className="form-button-secondary" onClick={onBack}>
              ← Step 1 に戻る
            </button>
          </div>
        </div>
      </div>

      {/* 通常の Firmware タブと同じ — ライブラリ内に Hapbeat | 周辺機器 の
          グループタブが出る（groupFilter は渡さない）。 */}
      <FirmwareSubTab serialOnly />
    </>
  )
}

function ConfigureStep({
  hasConn,
  probeStatus,
  probeMessage,
  onDisconnect,
}: {
  hasConn: boolean
  probeStatus: string
  probeMessage: string | null
  onDisconnect: () => void
}) {
  // 接続なし: post-flash / cable 抜け / set_wifi 後 reboot のいずれかで
  // conn が外れた状態。Step 1 に戻さず、ここで電源 OFF→ON + 再接続を促す。
  // 再接続も左サイドバーの USB Serial カードの「接続」ボタンで。
  if (!hasConn) {
    return (
      <div className="form-section onboarding-step">
        <div className="form-section-title">Step 3 — Wi-Fi 設定 (再接続待ち)</div>
        <div className="onboarding-step-body">
          <p>
            ファーム書き込みが完了しました。<strong>デバイスの電源を一度 OFF→ON</strong> してから、
            <strong>左の USB Serial カードの「⚙ 設定」ボタンで</strong>設定接続してください
            （接続中はカード枠が緑になります）。
          </p>
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            設定接続できたら設定タブの Wi-Fi セクションで SSID / パスワードを入力できます。
          </p>
          {probeMessage && (
            <div className={`form-status ${
              probeStatus === 'success' ? 'ok' : 'muted'
            }`} style={{ marginTop: 6 }}>
              {probeMessage}
            </div>
          )}
        </div>
      </div>
    )
  }

  // 接続あり: 設定タブ (Wi-Fi sub-tab) へのハンドオフ。
  // Wi-Fi 設定 UI は DeviceDetail の Wi-Fi tab に集約しており、ここでは
  // 重複させない。「Wi-Fi 設定へ進む」ボタンで selectDevice を呼ぶと、
  // DeviceDetail 側が wifi_connected=false → Wi-Fi sub-tab を自動選択する。
  const masterInfo = useSerialMaster((s) => s.info)
  const handleFinish = () => {
    if (!masterInfo) return
    const id = `${SERIAL_DEVICE_PREFIX}${masterInfo.mac ?? 'active'}`
    useDeviceStore.getState().selectDevice(id)
  }
  return (
    <div className="form-section onboarding-step">
      <div className="form-section-title">Step 3 — Wi-Fi 設定へ進む</div>
      <div className="onboarding-step-body">
        <p style={{ marginTop: 0 }}>
          シリアル接続できました。下のボタンで <strong>Wi-Fi 設定タブ</strong> に進み、
          SSID とパスワードを登録してください。Wi-Fi 接続が確立するとデバイスが
          LAN 上に表示され、設定タブから残りの項目 (デバイス識別 / UI Config / Debug Dump)
          にアクセスできます。
        </p>
        <div className="form-action-row">
          <button
            className="form-button onboarding-cta"
            onClick={handleFinish}
            title="DeviceDetail の Wi-Fi タブを開きます"
          >
            Wi-Fi 設定タブへ進む →
          </button>
          <button className="form-button-secondary" onClick={onDisconnect}>
            切断して Step 1 に戻る
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// Stepper indicator
// ---------------------------------------------------------------------

type StepState = 'idle' | 'active' | 'done'

function stepStateFor(target: Step, current: Step): StepState {
  if (target === current) return 'active'
  if (current === 'configure') {
    if (target === 'probe') return 'done'
    return 'idle'
  }
  if (current === 'flash') {
    if (target === 'probe') return 'done'
    return 'idle'
  }
  return 'idle'
}

function StepPill({
  index,
  label,
  state,
  subtle,
  onClick,
  disabledReason,
}: {
  index: number
  label: string
  state: StepState
  subtle?: string
  onClick?: () => void
  /** When set, the pill is rendered disabled and the reason becomes
   *  the title tooltip. Used for Step 3 before probe success. */
  disabledReason?: string | null
}) {
  const disabled = !!disabledReason || !onClick
  return (
    <li className="onboarding-step-pill-li">
      <button
        type="button"
        className={`onboarding-step-pill state-${state}${disabled ? ' is-disabled' : ''}`}
        onClick={disabled ? undefined : onClick}
        disabled={disabled}
        title={disabledReason ?? `Step ${index} へ移動`}
      >
        <span className="onboarding-step-pill-num">{state === 'done' ? '✓' : index}</span>
        <span className="onboarding-step-pill-label">
          {label}
          {subtle && <span className="onboarding-step-pill-subtle"> {subtle}</span>}
        </span>
      </button>
    </li>
  )
}

function StepArrow() {
  return <li className="onboarding-step-arrow" aria-hidden>→</li>
}
