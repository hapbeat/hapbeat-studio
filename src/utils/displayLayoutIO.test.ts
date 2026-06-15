import { describe, it, expect } from 'vitest'
import {
  toFirmwareFormat,
  fromFirmwareFormat,
  type DisplaySavedState,
  type FirmwareUiConfig,
} from './displayLayoutIO'
import {
  DEFAULT_LED_RULES,
  DEFAULT_VOLUME_CONFIG,
  DEFAULT_UI_SETTINGS,
  type DisplayLayout,
} from '@/types/display'
import { DEFAULT_SIM_STATE } from './displayPreview'

const layout: DisplayLayout = {
  grid: [16, 2],
  pages: [
    {
      name: 'Alert',
      elements: [
        { id: 'e1', type: 'device_name', pos: [0, 0] },
        { id: 'e2', type: 'battery', pos: [12, 0], variant: 'bar' },
        { id: 'e3', type: 'custom_text', pos: [0, 1], text: 'Hi' },
        { id: 'e4', type: 'alert_limit_mode', pos: [6, 1] },
      ],
    },
  ],
  buttons: { short_press: 'next_page', long_press: 'none' },
}

function makeState(): DisplaySavedState {
  return {
    layoutByModel: { duo_wl: layout, band_wl: layout },
    deviceModel: 'band_wl',
    orientationByModel: { duo_wl: 'normal', band_wl: 'normal' },
    perButtonActions: {},
    simState: DEFAULT_SIM_STATE,
    ledConfig: { globalBrightness: 255, rules: [...DEFAULT_LED_RULES] },
    volumeConfig: { ...DEFAULT_VOLUME_CONFIG },
    uiSettings: { ...DEFAULT_UI_SETTINGS },
  }
}

describe('toFirmwareFormat (Studio → firmware)', () => {
  const fw = toFirmwareFormat(makeState())

  it('grid と page 名を保持', () => {
    expect(fw.display.grid).toEqual([16, 2])
    expect(fw.display.pages[0].name).toBe('Alert')
  })
  it('要素は type + position + (getElementSize 由来の) size を出力', () => {
    const els = fw.display.pages[0].elements
    expect(els[0]).toMatchObject({ type: 'device_name', position: [0, 0], size: [8, 1] })
    // battery "bar" は size [8,1] + variant 'bar'
    expect(els[1]).toMatchObject({ type: 'battery', position: [12, 0], size: [8, 1], variant: 'bar' })
    // custom_text は text を保持
    expect(els[2]).toMatchObject({ type: 'custom_text', position: [0, 1], text: 'Hi' })
    // alert_limit_mode は 10 セル幅
    expect(els[3]).toMatchObject({ type: 'alert_limit_mode', size: [10, 1] })
  })
  it('perButtonActions が空なら button_actions も空', () => {
    expect(fw.display.button_actions).toEqual({})
  })
  it('led / volume / ui セクションを必ず出力', () => {
    expect(fw.led).toBeDefined()
    expect(fw.volume).toBeDefined()
    expect(fw.ui).toBeDefined()
  })
})

describe('fromFirmwareFormat (firmware → Studio)', () => {
  const fwIn: FirmwareUiConfig = {
    display: {
      grid: [16, 2],
      device_model: 'band_wl',
      pages: [
        {
          id: 'page_0',
          name: 'P',
          elements: [
            { type: 'group_id', position: [0, 0], size: [5, 1] },
            { type: 'custom_text', position: [6, 0], size: [8, 1], text: 'X' },
          ],
        },
      ],
      button_actions: {
        btn_l: { short_press: 'volume_up', long_press: 'mode_toggle', hold: 'next_page', hold_mode: 'latch' },
      },
    },
    led: { global_brightness: 200, rules: [] },
    volume: { steps: 8, direction: 'ascending', default_level: 4 },
  }
  const out = fromFirmwareFormat(fwIn)

  it('grid / deviceModel / 要素を復元', () => {
    expect(out.deviceModel).toBe('band_wl')
    expect(out.layout?.grid).toEqual([16, 2])
    expect(out.layout?.pages[0].elements[0]).toMatchObject({ type: 'group_id', pos: [0, 0] })
    expect(out.layout?.pages[0].elements[1]).toMatchObject({ type: 'custom_text', pos: [6, 0], text: 'X' })
  })
  it('ボタンアクションを正規化 (mode_toggle → vib_mode、latch 展開)', () => {
    const b = out.perButtonActions?.btn_l
    expect(b?.short_press).toBe('volume_up')
    expect(b?.long_press).toBe('vib_mode') // mode_toggle が正規化される
    expect(b?.hold_mode).toBe('latch')
    expect(b?.hold_latch).toBe('next_page')
    expect(b?.hold_tmp).toBe('none')
  })
  it('volume を復元', () => {
    expect(out.volumeConfig?.steps).toBe(8)
    expect(out.volumeConfig?.default_level).toBe(4)
  })
})
