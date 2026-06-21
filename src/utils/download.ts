/**
 * Trigger a browser download of in-memory text as a file.
 *
 * Used for small JSON backups (MQTT topics, etc.) so a user can carry data
 * across an origin change — browser storage (localStorage / IndexedDB) is
 * partitioned per origin, so moving Studio to a new host (e.g.
 * `devtools.hapbeat.com/studio/` → `studio.hapbeat.com`) leaves the new
 * origin's storage empty. A manual export → import is the recovery path.
 */
export function downloadTextFile(
  filename: string,
  text: string,
  mime = 'application/json',
): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
