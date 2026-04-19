import type { DisplayLayout } from './display'

export interface HapbeatProject {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  displayLayout: DisplayLayout
  events: EventDefinition[]
  ledConfig: LedConfig
}

export interface EventDefinition {
  eventId: string
  clipFile?: string // filename of wav
  intensity: number
  device_wiper?: number
  loop: boolean
  ledColor?: string
}

export interface LedConfig {
  idleColor: string
  idlePattern: LedPattern
  eventColors: Record<string, string> // eventId -> color
}

export type LedPattern = 'solid' | 'breathe' | 'pulse' | 'off'
