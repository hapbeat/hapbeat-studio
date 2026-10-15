import { describe, expect, it } from 'vitest'
import { chunkUiConfigPayload, crc32, writeUiConfigOverSerial, UI_CONFIG_CHUNK_BYTES } from './uiConfigSerial'

const enc = new TextEncoder()
const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

describe('crc32', () => {
  it('matches the zlib check value', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array())).toBe(0)
  })
})

describe('chunkUiConfigPayload', () => {
  it('splits into ≤225-byte pieces, each base64 on its own (≤300 chars, length % 4 = 0)', () => {
    const bytes = Uint8Array.from({ length: 1000 }, (_, i) => (i * 37) & 0xff)
    const chunks = chunkUiConfigPayload(bytes)
    expect(chunks).toHaveLength(Math.ceil(1000 / UI_CONFIG_CHUNK_BYTES))
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(300)
      expect(c.length % 4).toBe(0)
      expect(c).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    }
    expect(chunks.slice(0, -1).every((c) => !c.includes('='))).toBe(true)
    const joined = chunks.flatMap((c) => [...fromBase64(c)])
    expect(Uint8Array.from(joined)).toEqual(bytes)
  })
})

describe('writeUiConfigOverSerial', () => {
  const config = { pages: [{ name: 'メイン', elements: Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, type: 'volume', pos: [i, 0] })) }] }

  it('sends begin / sequential chunks / commit, each line under the 512 B serial buffer', async () => {
    const sent: Record<string, unknown>[] = []
    const send = async (cmd: Record<string, unknown>) => {
      sent.push(cmd)
      expect(JSON.stringify(cmd).length + 1).toBeLessThan(512)
      return cmd.cmd === 'ui_config_commit'
        ? { status: 'ok', message: 'ui config saved and applied' }
        : { status: 'ok' }
    }
    const message = await writeUiConfigOverSerial(config, send)
    expect(message).toBe('ui config saved and applied')

    const payload = enc.encode(JSON.stringify(config))
    expect(sent[0]).toEqual({ cmd: 'ui_config_begin', size: payload.length, crc32: crc32(payload) })
    const chunks = sent.slice(1, -1)
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i))
    const received = Uint8Array.from(chunks.flatMap((c) => [...fromBase64(c.data as string)]))
    expect(received).toEqual(payload)
    expect(sent[sent.length - 1]).toEqual({ cmd: 'ui_config_commit' })
  })

  it('aborts and reports the step when a chunk fails', async () => {
    const sent: string[] = []
    const send = async (cmd: Record<string, unknown>) => {
      sent.push(cmd.cmd as string)
      if (cmd.cmd === 'ui_config_chunk' && cmd.seq === 1) return { status: 'error', message: 'unexpected seq' }
      return { status: 'ok' }
    }
    await expect(writeUiConfigOverSerial(config, send)).rejects.toThrow('chunk: unexpected seq')
    expect(sent).toEqual(['ui_config_begin', 'ui_config_chunk', 'ui_config_chunk', 'ui_config_abort'])
  })

  it('reports no response without sending further chunks', async () => {
    const send = async () => null
    await expect(writeUiConfigOverSerial(config, send)).rejects.toThrow('begin: no response')
  })
})
