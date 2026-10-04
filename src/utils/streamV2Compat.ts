import { compareVersions } from './firmwareLibrary'

/**
 * Stream session v2 compatibility (DEC-074 / DEC-081).
 *
 * Device firmware from STREAM_V2_FIRMWARE_MIN on accepts only v2 streams, so
 * apps built with an SDK that predates v2 lose streamed haptics (FIRE/PLAY
 * still work). The table below MUST mirror hapbeat-contracts
 * `specs/stream-session-v2.md` § "Minimum versions" — that section is the
 * single source of truth; update it first, then this constant.
 */
export const STREAM_V2_FIRMWARE_MIN = '0.5.0'

/** Minimum SDK / helper versions that send v2 streams (contracts § Minimum versions). */
export const STREAM_V2_MIN_VERSIONS: ReadonlyArray<{ name: string; version: string }> = [
  { name: 'Unity SDK', version: '0.6.0' },
  { name: 'Unreal SDK', version: '0.2.0' },
  { name: 'Python SDK (hapbeat-python-sdk)', version: '0.3.0' },
  { name: 'JS SDK (@hapbeat/sdk)', version: '0.4.0' },
  { name: 'hapbeat-helper', version: '0.5.0' },
]

/** SDKs without v2 support yet: their streams are silent on v2 firmware. */
export const STREAM_V2_UNSUPPORTED_SDKS: readonly string[] = ['Arduino SDK', 'Godot SDK']

const VERSION_CORE = /^v?\d+\.\d+\.\d+/

/**
 * True when `fw` is on the v2 line (core version ≥ STREAM_V2_FIRMWARE_MIN).
 * Dev / pre-release suffixes (`0.5.0d7`, `0.5.0-d7`, `0.5.0-rc1`) count as
 * their core version: they are builds of the v2 line. Unknown or
 * unparseable versions return false.
 */
export function isStreamV2Firmware(fw: string | null | undefined): boolean {
  if (!fw || !VERSION_CORE.test(fw.trim())) return false
  return compareVersions(fw.trim(), STREAM_V2_FIRMWARE_MIN) <= 0
}

/**
 * Whether flashing `targetFw` needs the stream v2 warning: the image is on
 * the v2 line and at least one target currently runs pre-v2 or unknown
 * firmware. An image of unknown version (local .bin) is not judged.
 */
export function needsStreamV2Warning(
  targetFw: string | null | undefined,
  currentFws: ReadonlyArray<string | null | undefined>,
): boolean {
  if (!isStreamV2Firmware(targetFw)) return false
  return currentFws.some((fw) => !isStreamV2Firmware(fw))
}

/** `・<name> ≥ <version>` lines for the confirm message. */
export function streamV2MinimumLines(): string {
  return STREAM_V2_MIN_VERSIONS.map((m) => `・${m.name} ≥ ${m.version}`).join('\n')
}
