/**
 * Clamp helpers for the SOLID48 (mode 9, Opus 48k stereo HP) transmitter
 * tuning controls (DEC-046 follow-up): Opus encoder complexity (TX-local,
 * `set_opus_complexity`) and the HP jitter-buffer target broadcast to the
 * fleet as 0xAC fleet-tune param 6 (`set_stream_hp_buffer`).
 *
 * Kept as pure functions (not inlined in the form component) so the clamp
 * boundaries — which must match the wire contract exactly — have a
 * testable seam independent of the DOM/state plumbing. The device (TX
 * firmware) re-validates on its own side; these just keep the UI honest
 * before the command is sent.
 */

/** Opus OPUS_SET_COMPLEXITY range accepted by `set_opus_complexity` (0..10). */
export function clampOpusComplexity(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(10, Math.round(value)))
}

/** `set_stream_hp_buffer` accepts 40..500 ms (the TX further maps this to
 *  deci-ms 4..50 for the 0xAC wire — that conversion is firmware-side). */
export function clampHpBufferMs(value: number): number {
  if (!Number.isFinite(value)) return 120
  return Math.max(40, Math.min(500, Math.round(value)))
}
