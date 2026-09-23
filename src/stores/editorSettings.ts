import { create } from 'zustand'
interface Settings { columns: number; loop: boolean; loopDelay: number; height: number; layout: 'bottom' | 'right'; popupWidth: number; popupHeight: number }
const defaults: Settings = {columns: 0,loop: false, loopDelay: 0,height: 180, layout: 'bottom', popupWidth: 920, popupHeight: 760}
const clamp = (value: unknown, min: number, max: number, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
function read(): Settings {
  try {
    const value = JSON.parse(localStorage.getItem('hapbeat-editor-settings') ?? '{}')
    return {columns: [0,1,2,3].includes(value.columns) ? value.columns : 0, loop: value.loop === true, loopDelay: clamp(value.loopDelay, 0, 60, 0), height: clamp(value.height, 100, 700, 180), layout: value.layout === 'right' ? 'right' : 'bottom', popupWidth: clamp(value.popupWidth, 420, 2400, 920), popupHeight: clamp(value.popupHeight, 300, 1600, 760)}
  } catch { return defaults }
}
export const useEditorSettings = create<Settings & {update: (patch: Partial<Settings>) => void}>((set, get) => ({...read(), update: patch => {
  const next = {...get(), ...patch}; set(patch)
  try { localStorage.setItem('hapbeat-editor-settings', JSON.stringify({columns: next.columns, loop: next.loop, loopDelay: next.loopDelay, height: next.height, layout: next.layout, popupWidth: next.popupWidth, popupHeight: next.popupHeight})) } catch { /* UI preferences must not prevent editing. */ }
}}))
