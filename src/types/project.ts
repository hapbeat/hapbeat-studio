// Shared types kept after the Projects store was removed (2026-06-21).
// The old HapbeatProject / IndexedDB "projects" feature was dead code; these
// two types are the only members still referenced:
//   - EventDefinition → src/components/pack/PackBuilder.tsx
//   - LedPattern      → src/components/led/LedEditor.tsx

export interface EventDefinition {
  eventId: string
  clipFile?: string // filename of wav
  intensity: number
  device_wiper?: number
  loop: boolean
  ledColor?: string
}

export type LedPattern = 'solid' | 'breathe' | 'pulse' | 'off'
