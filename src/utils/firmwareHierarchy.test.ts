import { describe, it, expect } from 'vitest'
import {
  entriesForSelection,
  familyOfEntry,
  hwOfEntry,
  listAvailability,
  listFamilies,
  listHw,
  parseHapbeatBoard,
  resolveDefaultSelection,
} from './firmwareHierarchy'
import type { FirmwareLibraryEntry } from './firmwareLibrary'

const entry = (env: string, extra: Partial<FirmwareLibraryEntry> = {}): FirmwareLibraryEntry =>
  ({ env, ...extra }) as FirmwareLibraryEntry

const LIB: FirmwareLibraryEntry[] = [
  entry('necklace_v3', { board: 'duo_wl_v3', hapbeat: true }),
  entry('necklace_v3_stream_espnow', { board: 'duo_wl_v3', hapbeat: true }),
  entry('duo_v4', { board: 'duo_wl_v4', hapbeat: true }),
  entry('band_v2', { board: 'band_wl_v2', hapbeat: true }),
  entry('band_v4', { board: 'band_wl_v4', hapbeat: true }),
  entry('band_v4_pwm', { board: 'band_wl_v4', hapbeat: true }),
  entry('atom_lite_sensor', { board: 'atom_lite', hapbeat: false }),
  entry('m5stack_espnow_stream_source', { board: 'm5stack_basic', hapbeat: false }),
]

describe('parseHapbeatBoard', () => {
  it('Hapbeat board を family + hw に分解する', () => {
    expect(parseHapbeatBoard('duo_wl_v4')).toEqual({ family: 'duo', hw: 'v4' })
    expect(parseHapbeatBoard('band_wl_v2')).toEqual({ family: 'band', hw: 'v2' })
  })
  it('非 Hapbeat / 未定義 / 解釈不能は null', () => {
    expect(parseHapbeatBoard('atom_s3')).toBeNull()
    expect(parseHapbeatBoard(undefined)).toBeNull()
    expect(parseHapbeatBoard(null)).toBeNull()
    expect(parseHapbeatBoard('duo_wl')).toBeNull()
    expect(parseHapbeatBoard('unknown')).toBeNull()
  })
})

describe('familyOfEntry / hwOfEntry', () => {
  it('board 明示の entry', () => {
    expect(familyOfEntry(LIB[0])).toBe('duo')
    expect(hwOfEntry(LIB[0])).toBe('v3')
    expect(familyOfEntry(LIB[3])).toBe('band')
    expect(hwOfEntry(LIB[3])).toBe('v2')
  })
  it('非 Hapbeat は peripheral、hw は持たない', () => {
    expect(familyOfEntry(LIB[6])).toBe('peripheral')
    expect(hwOfEntry(LIB[6])).toBeNull()
  })
  it('board 未指定でも env から推定する', () => {
    const e = entry('band_v3_mqtt', { hapbeat: true })
    expect(familyOfEntry(e)).toBe('band')
    expect(hwOfEntry(e)).toBe('v3')
  })
  it('Hapbeat フラグだが board が解釈できない → その他', () => {
    const e = entry('weird_env', { board: 'mystery', hapbeat: true })
    expect(familyOfEntry(e)).toBe('other')
    expect(hwOfEntry(e)).toBeNull()
  })
})

describe('listFamilies / listHw', () => {
  it('存在する family だけを表示順で返す', () => {
    expect(listFamilies(LIB)).toEqual(['duo', 'band', 'peripheral'])
    expect(listFamilies(LIB.filter((e) => familyOfEntry(e) === 'peripheral'))).toEqual(['peripheral'])
  })
  it('hw は昇順（自然順 v2 < v3 < v10）', () => {
    expect(listHw(LIB, 'duo')).toEqual(['v3', 'v4'])
    expect(listHw(LIB, 'band')).toEqual(['v2', 'v4'])
    expect(listHw(LIB, 'peripheral')).toEqual([])
    const many = [
      entry('band_v10', { board: 'band_wl_v10', hapbeat: true }),
      entry('band_v2', { board: 'band_wl_v2', hapbeat: true }),
      entry('band_v3', { board: 'band_wl_v3', hapbeat: true }),
    ]
    expect(listHw(many, 'band')).toEqual(['v2', 'v3', 'v10'])
  })
})

describe('entriesForSelection', () => {
  it('選択中の board に一致する variant だけ', () => {
    const shown = entriesForSelection(LIB, { family: 'duo', hw: 'v3' }).map((e) => e.env)
    expect(shown).toEqual(['necklace_v3', 'necklace_v3_stream_espnow'])
  })
  it('周辺機器は hw なしで全部', () => {
    const shown = entriesForSelection(LIB, { family: 'peripheral', hw: null }).map((e) => e.env)
    expect(shown).toEqual(['atom_lite_sensor', 'm5stack_espnow_stream_source'])
  })
  it('未選択は空', () => {
    expect(entriesForSelection(LIB, null)).toEqual([])
  })
})

describe('resolveDefaultSelection', () => {
  const available = listAvailability(LIB)

  it('ライブラリが空なら null', () => {
    expect(resolveDefaultSelection({ available: [] })).toBeNull()
  })

  it('1. groupFilter=peripheral は board を無視して周辺機器', () => {
    expect(resolveDefaultSelection({
      groupFilter: 'peripheral',
      knownBoard: 'duo_wl_v4',
      available,
    })).toEqual({ family: 'peripheral', hw: null })
  })

  it('1. groupFilter=hapbeat のとき周辺機器 board でも Hapbeat 側に落ちる', () => {
    expect(resolveDefaultSelection({
      groupFilter: 'hapbeat',
      knownBoard: 'atom_lite',
      available,
    })).toEqual({ family: 'duo', hw: 'v3' })
  })

  it('2. 接続デバイスの board を最優先（保存値より強い）', () => {
    expect(resolveDefaultSelection({
      knownBoard: 'band_wl_v4',
      saved: { family: 'duo', hw: 'v3' },
      available,
    })).toEqual({ family: 'band', hw: 'v4' })
  })

  it('2. 既知の非 Hapbeat board → 周辺機器', () => {
    expect(resolveDefaultSelection({ knownBoard: 'atom_lite', available }))
      .toEqual({ family: 'peripheral', hw: null })
  })

  it('2. board の hw がライブラリに無ければ同 family の先頭 hw', () => {
    expect(resolveDefaultSelection({ knownBoard: 'band_wl_v3', available }))
      .toEqual({ family: 'band', hw: 'v2' })
  })

  it('3. board 不明（undefined / unknown）なら保存値', () => {
    expect(resolveDefaultSelection({
      saved: { family: 'band', hw: 'v4' },
      available,
    })).toEqual({ family: 'band', hw: 'v4' })
    expect(resolveDefaultSelection({
      knownBoard: 'unknown',
      saved: { family: 'band', hw: 'v4' },
      available,
    })).toEqual({ family: 'band', hw: 'v4' })
  })

  it('3. 保存値の hw が消えていれば同 family の先頭 hw に寄せる', () => {
    expect(resolveDefaultSelection({
      saved: { family: 'duo', hw: 'v9' },
      available,
    })).toEqual({ family: 'duo', hw: 'v3' })
  })

  it('4. board も保存値も無ければ先頭 family の先頭 hw', () => {
    expect(resolveDefaultSelection({ available })).toEqual({ family: 'duo', hw: 'v3' })
  })

  it('4. 保存値の family がライブラリから消えたら先頭 family', () => {
    const bandOnly = listAvailability(LIB.filter((e) => familyOfEntry(e) === 'band'))
    expect(resolveDefaultSelection({
      saved: { family: 'duo', hw: 'v3' },
      available: bandOnly,
    })).toEqual({ family: 'band', hw: 'v2' })
  })
})
