import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { useHelperConnection } from '@/hooks/useHelperConnection'
import { useDeviceSpace } from '@/hooks/useDeviceSpace'
import { useDeviceStore } from '@/stores/deviceStore'
import { useSceneStore } from '@/stores/sceneStore'
import { useScenePlayback } from '@/stores/scenePlayback'
import { bytesToBase64, type HapticDevice } from '@/utils/sceneHaptics'
import { findCapacityProblems } from '@/utils/deviceSpace'
import { estimateKitStorageFromFiles } from '@/utils/kitSizeEstimate'
import { summarizeCapacityProblems } from '@/components/kit/capacityText'
import { deviceKitState, kitStateOf, locateProjectKit, missingClips, parseKitList, readKitFiles, type DeviceKitAnswer, type DeviceKitState, type ProjectKit } from '@/utils/sceneKit'
import { useScene } from './sceneContext'

/** The FIRE output's Kit on the target devices (useSceneKitCheck), shared through the Scene context. */
export interface SceneKitCheck {
  /** The cue table's `kit`; null = none (FIRE cannot play). */
  kit: string | null
  /** The project's Kit folder: undefined while looking (or not in FIRE output), null when not found. */
  project: ProjectKit | null | undefined
  /** Why the project's Kit could not be read. */
  error: string | null
  /** Per target device: its state, its Kit's version, the cue table's clips its Kit lacks, why the helper could not ask it. */
  rows: { device: HapticDevice; state: DeviceKitState; version: string | null; missing: string[]; error: string | null }[]
  /** Asks every target device again (after an install, "Check again"). */
  recheck: () => void
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const SETTLED = new Set(['ready', 'differs', 'unreachable', 'missing'])

/**
 * In FIRE output: finds the project's Kit, asks each target device which Kits it holds (`kit_list` per IP; on start, a
 * change of the devices or the Kit, recheck) and publishes the summary as scenePlayback.kitState, which plays FIRE only
 * once the Kit is known to be on every device (effectiveOutput). A device asked again keeps its last answer until the
 * new one arrives, and while only new devices are unanswered the last settled state stays: a recheck while playing
 * never flips the output (which would restart every stream). Mounted once by SceneView.
 */
export function useSceneKitCheck(devices: HapticDevice[], connected: boolean): SceneKitCheck {
  const fire = useScenePlayback(s => s.output) === 'fire'
  const root = useSceneStore(s => s.root)
  const clipsPath = useSceneStore(s => s.lib?.paths.clips)
  const kit = useSceneStore(s => s.table ? s.table.kit ?? null : null)
  const tableClips = useSceneStore(s => s.table?.clips)
  const clips = useMemo(() => Object.keys(tableClips ?? {}), [tableClips])
  const { send, subscribe } = useHelperConnection()
  const [project, setProject] = useState<{ found: ProjectKit | null; error: string | null } | undefined>(undefined)
  const [answers, setAnswers] = useState<Record<string, DeviceKitAnswer>>({})
  const [round, setRound] = useState(0)
  useEffect(() => {
    setProject(undefined)
    if (!fire || !root || !kit || clipsPath === undefined) return
    let live = true
    locateProjectKit(root, kit, clipsPath).then(found => { if (live) setProject({ found, error: null }) }, error => { if (live) setProject({ found: null, error: message(error) }) })
    return () => { live = false }
  }, [fire, root, kit, clipsPath, round])
  useEffect(() => { setAnswers({}) }, [fire, kit])
  const ips = devices.map(d => d.ipAddress).join(',')
  useEffect(() => {
    const list = ips.split(',').filter(Boolean)
    setAnswers(cur => Object.fromEntries(Object.entries(cur).filter(([ip]) => list.includes(ip))))
    if (!fire || !kit || !connected) return
    for (const ip of list) send({ type: 'kit_list', payload: { ip } })
  }, [fire, kit, connected, ips, round, send])
  useEffect(() => subscribe(m => {
    if (m.type !== 'kit_list_result' || !kit) return
    const answer = parseKitList(m.payload, kit)
    if (answer) setAnswers(cur => ({ ...cur, [answer.ip]: answer }))
  }), [subscribe, kit])
  const version = project?.found?.version ?? null
  const rows = useMemo(() => devices.map(device => {
    const a = answers[device.ipAddress]
    return { device, state: deviceKitState(a, version, clips), version: a?.version ?? null, missing: missingClips(a, clips), error: a?.error ?? null }
  }), [devices, answers, version, clips])
  const state = !fire ? 'none' : kitStateOf(kit ? rows.map(r => r.state) : null)
  const hold = state === 'checking' && rows.some(r => r.state !== 'checking')
  useEffect(() => {
    const pb = useScenePlayback.getState()
    if (hold && SETTLED.has(pb.kitState)) return
    pb.setKitState(state)
  }, [state, hold])
  useEffect(() => () => useScenePlayback.getState().setKitState('none'), [])
  const recheck = useCallback(() => setRound(n => n + 1), [])
  return { kit, project: project?.found ?? (project ? null : undefined), error: project?.error ?? null, rows, recheck }
}

interface InstallRow { pct: number; done?: boolean; ok?: boolean; msg?: string }

/**
 * "Kit on device" (FIRE output) in the Project panel: the project's Kit, each target Hapbeat's copy (✓ installed /
 * missing / another version / lacking clips / not reachable) and "Install", which sends the project's Kit (manifest +
 * install-clips, after KitManager's capacity check) to the devices without it, with another version or lacking clips,
 * shows their progress and checks again once every device answered (or the whole deploy failed, or the helper left).
 */
export function SceneKitStatus() {
  const { t } = useI18n()
  const { kit: check, helperConnected } = useScene()
  const root = useSceneStore(s => s.root)
  const kitState = useScenePlayback(s => s.kitState)
  const infoCache = useDeviceStore(s => s.infoCache)
  const { send, subscribe } = useHelperConnection()
  const [progress, setProgress] = useState<Record<string, InstallRow>>({})
  const [installError, setInstallError] = useState<string | null>(null)
  const waiting = useRef(new Set<string>())
  const { recheck } = check
  /** Every device still waited for fails with `msg` (a deploy that ended for all of them at once). */
  const failAll = useCallback((msg: string) => {
    if (!waiting.current.size) return
    const ips = [...waiting.current]
    waiting.current.clear()
    setProgress(cur => ({ ...cur, ...Object.fromEntries(ips.map(ip => [ip, { pct: cur[ip]?.pct ?? 0, done: true, ok: false, msg }])) }))
    recheck()
  }, [recheck])
  useEffect(() => subscribe(m => {
    const p = (m.payload ?? {}) as Record<string, unknown>, ip = typeof p.ip === 'string' ? p.ip : null
    // The helper's early refusals (no targets, a zip it cannot extract) carry no ip: the whole install failed.
    if (m.type === 'deploy_result' && !ip && p.success === false) { failAll(String(p.message ?? '')); return }
    if (!ip || !waiting.current.has(ip)) return
    if (m.type === 'deploy_progress') setProgress(cur => ({ ...cur, [ip]: { pct: Math.max(0, Math.min(100, Number(p.percent ?? 0))) } }))
    else if (m.type === 'deploy_result') {
      const ok = p.success === true
      setProgress(cur => ({ ...cur, [ip]: { pct: ok ? 100 : cur[ip]?.pct ?? 0, done: true, ok, msg: String(p.message ?? '') } }))
      waiting.current.delete(ip)
      if (!waiting.current.size) recheck()
    }
  }), [subscribe, recheck, failAll])
  useEffect(() => { if (!helperConnected) failAll(t('scene.output.noHelper')) }, [helperConnected, failAll, t])
  const installing = Object.values(progress).some(r => !r.done)
  const outdated = check.rows.filter(r => r.state === 'missing' || r.state === 'differs' || r.state === 'incomplete')
  const { entries: spaceEntries } = useDeviceSpace(outdated.map(r => r.device.ipAddress))
  const install = async () => {
    const project = check.project
    if (!root || !project || !outdated.length) return
    const ips = outdated.map(r => r.device.ipAddress)
    setInstallError(null)
    try {
      const files = await readKitFiles(root, project)
      if (files.length < 2) throw new Error(t('scene.kit.noClips', { folder: `${project.folder}/install-clips` }))
      // KitManager's capacity gate on the exact files: a deploy that does not fit fails on the device partway through.
      const blocking = summarizeCapacityProblems(findCapacityProblems(await estimateKitStorageFromFiles(files),
        outdated.map(r => ({ ipAddress: r.device.ipAddress, name: r.device.name ?? '' })), spaceEntries, ip => infoCache[ip]?.board), t)
      if (blocking) { setInstallError(t('kit.capacity.deployBlocked', { reason: blocking })); return }
      const { buildKitZip } = await import('@/utils/kitExporter')
      const { blob } = await buildKitZip(files, project.kit)
      waiting.current = new Set(ips)
      setProgress(Object.fromEntries(ips.map(ip => [ip, { pct: 0 }])))
      send({ type: 'deploy_kit_data', payload: { kit_id: project.kit, zip_base64: bytesToBase64(await blob.arrayBuffer()), targets: ips } })
    } catch (error) { setInstallError(t('scene.kit.readFailed', { error: message(error) })) }
  }
  const rowText = (r: SceneKitCheck['rows'][number]) => r.state === 'checking' ? t('scene.kit.dev.checking')
    : r.state === 'unreachable' ? t('scene.kit.dev.unreachable', { error: r.error ?? '' })
      : r.state === 'missing' ? t('scene.kit.dev.missing')
        : r.state === 'incomplete' ? t('scene.kit.dev.incomplete', { clips: r.missing.join(', ') })
          : r.state === 'differs' ? t('scene.kit.dev.differs', { version: r.version ?? '—' }) : t('scene.kit.dev.installed', { version: r.version ?? '—' })
  const warn = kitState === 'missing' ? check.rows.some(r => r.state === 'incomplete') ? 'scene.kit.warnIncomplete' : 'scene.kit.warnMissing'
    : kitState === 'differs' ? 'scene.kit.warnDiffers' : kitState === 'unreachable' ? 'scene.kit.warnUnreachable' : null
  return <div className="scene-sec scene-kit">
    <h3>{t('scene.kit.heading')}</h3>
    {!check.kit ? <div className="scene-warn">{t('scene.kit.noKitName')}</div> : <>
      <div className="scene-dim">{check.error ? t('scene.kit.readFailed', { error: check.error })
        : check.project === undefined ? t('scene.kit.dev.checking')
          : check.project ? t('scene.kit.folder', { kit: check.kit, version: check.project.version ?? '—', folder: `${check.project.folder}/` })
            : t('scene.kit.noFolder', { kit: check.kit })}</div>
      {!check.rows.length ? <div className="scene-dim">{t('scene.kit.noDevices')}</div>
        : <div className="scene-kit-rows">{check.rows.map(r => { const p = progress[r.device.ipAddress]
          return <div key={r.device.ipAddress} className={`scene-kit-row ${r.state}`}>
            <span className="scene-kit-name" title={r.device.ipAddress}>{r.device.name || r.device.ipAddress}</span>
            <span title={rowText(r)}>{rowText(r)}</span>
            <span className="scene-kit-progress" title={p?.msg}>{!p ? '' : !p.done ? t('scene.kit.installing', { percent: Math.round(p.pct) }) : p.ok ? t('scene.kit.installDone') : t('scene.kit.installFailed', { message: p.msg ?? '' })}</span>
          </div> })}</div>}
      {warn && <div className="scene-warn">{t(warn)}</div>}
      {installError && <div className="scene-warn">{installError}</div>}
      <div className="scene-row">
        {outdated.length > 0 && <button type="button" className="toolbar-btn primary" disabled={!check.project || installing} title={t('scene.kit.installTitle')} onClick={() => void install()}>{t('scene.kit.install')}</button>}
        <button type="button" className="toolbar-btn" disabled={installing} onClick={recheck}>{t('scene.kit.recheck')}</button>
      </div>
    </>}
  </div>
}
