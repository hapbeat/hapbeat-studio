/**
 * Helper version compatibility — the contract Studio expects from the
 * `hapbeat-helper` daemon it talks to over WebSocket.
 *
 * Bump `MIN_HELPER_VERSION` whenever Studio depends on:
 *   - a new WS message type / field in a result payload
 *   - a behavioural fix in Helper that older builds can't fulfil
 *
 * Studio surfaces a warning banner + an "outdated" colour on the Helper
 * header pill whenever the connected Helper is older than this minimum,
 * with copy-paste-able upgrade commands in the Helper Manage modal.
 *
 * Why a separate file: this constant is the single source of truth for
 * "does this Studio + Helper combo work?". Keeping it out of code that
 * happens to call it makes it easy to grep + bump in a one-line PR
 * alongside the feature commit that introduced the dependency.
 */
export const MIN_HELPER_VERSION = '0.1.3'

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
 *  - `ok`:      Helper version >= MIN_HELPER_VERSION
 *  - `outdated`: Helper version <  MIN_HELPER_VERSION (upgrade needed)
 */
export type HelperCompat = 'unknown' | 'ok' | 'outdated'

export function checkHelperCompat(helperVersion: string | null): HelperCompat {
  if (!helperVersion) return 'unknown'
  return compareVersion(helperVersion, MIN_HELPER_VERSION) < 0 ? 'outdated' : 'ok'
}
