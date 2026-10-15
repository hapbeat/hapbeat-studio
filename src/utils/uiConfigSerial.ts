/**
 * UI config (ui-config.json) upload over USB serial — firmware feat/band-v5
 * fb5e337+, advertised by `"serial_ui_config": 1` in get_info.
 *
 * The serial line buffer is 512 B, so the payload (the same JSON object the
 * Wi-Fi path sends as `config` in write_ui_config) goes in chunks:
 *   {"cmd":"ui_config_begin","size":N,"crc32":C}   ← {"status":"ok","max_chunk":300}
 *   {"cmd":"ui_config_chunk","seq":i,"data":b64}   ← {"status":"ok","received":n}
 *   {"cmd":"ui_config_commit"}                     ← {"status":"ok","message":...}
 * Any error discards the transfer on the device; `ui_config_abort` is sent
 * best-effort so it does not wait for its 10 s timeout.
 */

/** Raw bytes per chunk: 225 B → 300 base64 chars, the firmware's max_chunk. */
export const UI_CONFIG_CHUNK_BYTES = 225
/** Firmware limit on the whole payload. */
export const UI_CONFIG_MAX_BYTES = 32768

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** Standard zlib CRC-32 (reflected 0xEDB88320, init / final xor 0xFFFFFFFF). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

/** Each ≤225-byte piece base64-encoded on its own (padding only at its end). */
export function chunkUiConfigPayload(bytes: Uint8Array, chunkBytes = UI_CONFIG_CHUNK_BYTES): string[] {
  const out: string[] = []
  for (let i = 0; i < bytes.length; i += chunkBytes) out.push(toBase64(bytes.subarray(i, i + chunkBytes)))
  return out
}

/** Serial request → firmware reply (null = no reply / timeout / no connection). */
export type SerialSend = (
  cmd: Record<string, unknown>,
  opts?: { timeoutMs?: number },
) => Promise<Record<string, unknown> | null>

/**
 * Upload `config` and have the device save + apply it. Resolves with the
 * firmware's success message; throws with the failing step and reason.
 * Commands go one at a time, each after the previous reply.
 */
export async function writeUiConfigOverSerial(
  config: unknown,
  send: SerialSend,
  onProgress?: (sentBytes: number, totalBytes: number) => void,
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(config))
  if (bytes.length > UI_CONFIG_MAX_BYTES) {
    throw new Error(`ui config is ${bytes.length} bytes (max ${UI_CONFIG_MAX_BYTES})`)
  }
  const step = async (name: string, cmd: Record<string, unknown>, timeoutMs?: number) => {
    const r = await send(cmd, timeoutMs ? { timeoutMs } : undefined)
    if (r?.status === 'ok') return r
    if (name !== 'begin') void send({ cmd: 'ui_config_abort' }).catch(() => { /* best-effort */ })
    throw new Error(`${name}: ${r ? String(r.message ?? r.error ?? 'error') : 'no response'}`)
  }
  await step('begin', { cmd: 'ui_config_begin', size: bytes.length, crc32: crc32(bytes) })
  const chunks = chunkUiConfigPayload(bytes)
  let sent = 0
  for (let seq = 0; seq < chunks.length; seq++) {
    await step('chunk', { cmd: 'ui_config_chunk', seq, data: chunks[seq] })
    sent = Math.min(bytes.length, sent + UI_CONFIG_CHUNK_BYTES)
    onProgress?.(sent, bytes.length)
  }
  // Commit writes LittleFS and applies the layout; allow more than the 2 s default.
  const done = await step('commit', { cmd: 'ui_config_commit' }, 5000)
  return String(done.message ?? 'ui config saved and applied')
}
