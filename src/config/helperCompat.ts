/**
 * Helper compatibility — what Studio may use of the `hapbeat-helper` daemon it
 * talks to over WebSocket (contracts `helper-ws.md`, DEC-096).
 *
 * A 1.x Helper declares its request `types` and `features` in `helper_hello`;
 * Studio enables a feature only when the Helper lists it, and shows "update
 * Helper" for that feature alone (`helperHasType` / `helperHasFeature`).
 * Versions are never compared to enable features.
 *
 * A Helper without `types` (0.x) offers only what Helper 0.5.0 offered.
 * `MIN_HELPER_VERSION` is kept for that case only: a 0.x Helper below it
 * cannot serve Studio (0.5.0 is the first Helper that streams to Stream Gen 2
 * firmware; an older one leaves Studio's streams silent), so Studio shows the
 * outdated banner + the upgrade commands in the Helper Manage modal.
 *
 * The Windows app (hapbeat-studio-desktop, DEC-094) loads this Studio as soon
 * as it is deployed but bundles its helper. Before deploying a bump above the
 * app's bundled helper (`helper/helper-version.txt` there), publish an app
 * release with that helper, or app users are stuck with an outdated Helper.
 */
export const MIN_HELPER_VERSION = '0.5.0'

/** What the connected Helper declared in `helper_hello`. */
export interface HelperCaps {
  /** Helper's major (1.x); null for a 0.x Helper. */
  generation: number | null
  /** Request types Helper handles (1.x); null for a 0.x Helper. */
  types: string[] | null
  features: string[]
}

/** Request types added in Helper 1.x: a 0.x Helper (no `types`) lacks them. */
const HELPER_1X_TYPES: readonly string[] = ['reset_storage']
/** The `features` a 0.x Helper (0.5.0) has without declaring them. */
const HELPER_0X_FEATURES: readonly string[] = ['stream_gen2']

/** Reads `helper_hello`; unknown fields and values are ignored. */
export function parseHelperHello(payload: Record<string, unknown>): HelperCaps {
  const strings = (v: unknown): string[] | null =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null
  return {
    generation: typeof payload.generation === 'number' ? payload.generation : null,
    types: strings(payload.types),
    features: strings(payload.features) ?? [],
  }
}

/** Whether Helper handles the request `type`. False until `helper_hello` arrived. */
export function helperHasType(caps: HelperCaps | null, type: string): boolean {
  if (!caps) return false
  return caps.types ? caps.types.includes(type) : !HELPER_1X_TYPES.includes(type)
}

/** Whether Helper has the `features` value. False until `helper_hello` arrived. */
export function helperHasFeature(caps: HelperCaps | null, feature: string): boolean {
  if (!caps) return false
  return caps.types ? caps.features.includes(feature) : HELPER_0X_FEATURES.includes(feature)
}

/** Helper's major is above Studio's: Studio should be updated (`versioning.md` §3.3). */
export function helperNewerThanStudio(caps: HelperCaps | null, studioVersion: string): boolean {
  const m = /^v?(\d+)\./.exec(studioVersion.trim())
  return !!caps && caps.generation !== null && !!m && caps.generation > Number(m[1])
}

/**
 * Numeric-segment comparison of two Helper version strings.
 *
 * Helper versions follow `<major>.<minor>.<patch>` with an optional
 * `d<N>` dev counter suffix the Helper attaches to in-progress builds
 * (see `hapbeat-helper/scripts/gen_version.py`). For *compatibility*
 * we treat `0.1.3d2` as equivalent to `0.1.3` — a dev build that
 * claims a version has the WS surface of that version.
 *
 * Returns -1 / 0 / 1 like `Array#sort`. Unknown / malformed strings
 * compare as `0` (= treat as same version) rather than throwing, so a
 * Helper that mis-reports its version doesn't accidentally lock the
 * UI out of all features.
 */
export function compareVersion(a: string, b: string): number {
  if (!a || !b) return 0
  const norm = (v: string): number[] =>
    v
      .trim()
      .replace(/d\d+$/, '')  // strip dev counter
      .split('.')
      .map((n) => {
        const x = parseInt(n, 10)
        return Number.isFinite(x) ? x : 0
      })
  const av = norm(a)
  const bv = norm(b)
  const len = Math.max(av.length, bv.length)
  for (let i = 0; i < len; i++) {
    const x = av[i] ?? 0
    const y = bv[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * Three-way compat state:
 *  - `unknown`: no Helper connected, or `helper_hello` not received yet
 *  - `ok`:      a 1.x Helper (it declares `types`), or a 0.x Helper >= MIN_HELPER_VERSION
 *  - `outdated`: a 0.x Helper < MIN_HELPER_VERSION (upgrade needed)
 */
export type HelperCompat = 'unknown' | 'ok' | 'outdated'

export function checkHelperCompat(helperVersion: string | null, caps: HelperCaps | null = null): HelperCompat {
  if (caps?.types) return 'ok'
  if (!helperVersion) return 'unknown'
  return compareVersion(helperVersion, MIN_HELPER_VERSION) < 0 ? 'outdated' : 'ok'
}
