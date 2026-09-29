import { describe, expect, it } from 'vitest'
import { computeFeatures, fft, mixToMono } from './hapticFeatures'

const RATE = 48000
const signal = (seconds: number, fn: (t: number, i: number) => number) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => fn(i / RATE, i))
function noise(seed = 1) {
  let s = seed >>> 0
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1 }
}

describe('hapticFeatures', () => {
  it('fft matches a known transform', () => {
    const re = Float64Array.from([1, 0, 0, 0]), im = new Float64Array(4)
    fft(re, im)
    expect(Array.from(re)).toEqual([1, 1, 1, 1])
    const cos = Float64Array.from({ length: 8 }, (_, i) => Math.cos(2 * Math.PI * i / 8)), zero = new Float64Array(8)
    fft(cos, zero)
    expect(cos[1]).toBeCloseTo(4); expect(cos[2]).toBeCloseTo(0)
  })

  it('100 Hz sine: tonal, steady, energy in 80-160 Hz', () => {
    const f = computeFeatures(signal(1, t => 0.5 * Math.sin(2 * Math.PI * 100 * t)), RATE)
    expect(f.durationSec).toBe(1)
    expect(f.peakDb).toBeCloseTo(-6.02, 1)
    expect(f.rmsDb).toBeCloseTo(-9.03, 1)
    expect(f.crestDb).toBeCloseTo(3.01, 1)
    expect(Math.abs(f.dominantHz! - 100)).toBeLessThan(1)
    expect(Math.abs(f.centroidHz! - 100)).toBeLessThan(3)
    expect(f.flatness!).toBeLessThan(0.05)
    expect(f.bandEnergy['80-160']).toBeGreaterThan(0.99)
    expect(Object.values(f.bandEnergy).reduce((a, v) => a + v, 0)).toBeCloseTo(1, 3)
    expect(f.irregularity!).toBeLessThan(0.05)
    expect(f.amDepth!).toBeLessThan(0.05)
    expect(f.decayMs).toBeNull()
  })

  it('white noise: flat spectrum, most energy above 1 kHz', () => {
    const rand = noise(7)
    const f = computeFeatures(signal(1, () => 0.3 * rand()), RATE)
    expect(f.flatness!).toBeGreaterThan(0.4)
    expect(f.bandEnergy['>1000']).toBeGreaterThan(0.9)
    expect(f.centroidHz!).toBeGreaterThan(400)
    expect(f.centroidHz!).toBeLessThan(600)
  })

  it('20 Hz AM on 150 Hz: AM rate and depth', () => {
    const f = computeFeatures(signal(1, t => 0.4 * (1 + 0.8 * Math.sin(2 * Math.PI * 20 * t)) * Math.sin(2 * Math.PI * 150 * t)), RATE)
    expect(Math.abs(f.amRateHz! - 20)).toBeLessThan(1.5)
    expect(f.amDepth!).toBeGreaterThan(0.55)
    expect(f.amDepth!).toBeLessThan(0.95)
    expect(f.irregularity!).toBeGreaterThan(0.3)
    expect(Math.abs(f.dominantHz! - 150)).toBeLessThan(2)
  })

  it('decaying sine: fast attack and decay to -20 dB near tau * ln(10)', () => {
    const tau = 0.05
    const f = computeFeatures(signal(0.5, t => Math.exp(-t / tau) * Math.sin(2 * Math.PI * 80 * t)), RATE)
    expect(f.attackMs!).toBeLessThanOrEqual(5)
    expect(f.decayMs!).toBeGreaterThan(95)
    expect(f.decayMs!).toBeLessThan(130)
    expect(Math.abs(f.dominantHz! - 80)).toBeLessThan(5)
  })

  it('silence stays finite and JSON-safe', () => {
    const f = computeFeatures(new Float32Array(4800), RATE)
    expect(f.peakDb).toBe(-120)
    expect(f.centroidHz).toBeNull()
    expect(JSON.parse(JSON.stringify(f)).peakDb).toBe(-120)
  })

  it('long signals are frame-averaged', () => {
    const f = computeFeatures(signal(3, t => Math.sin(2 * Math.PI * 60 * t)), RATE)
    expect(Math.abs(f.dominantHz! - 60)).toBeLessThan(1)
  })

  it('mixToMono averages channels', () => {
    expect(Array.from(mixToMono([Float32Array.from([1, 0]), Float32Array.from([0, 1])]))).toEqual([0.5, 0.5])
  })
})
