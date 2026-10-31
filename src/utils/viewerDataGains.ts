/**
 * Writes firing gains (`events[i].gain`, scene-recording §2) into the text of viewer-data.json without rewriting the
 * rest: only the changed `gain` values are replaced (or one `gain` member inserted after the firing's last member, in
 * the style of that member), so every other field, the number formats (`13.0`), the indentation, the line endings and
 * the trailing newline stay as the recorder wrote them. A gain that is absent and still 1 stays absent.
 */

/** One firing's new gain; `name` / `t` are what Studio read at that index (checked before writing). */
export interface FiringGainChange { index: number; name: string; t: number; gain: number }
export type ViewerDataRewrite = { ok: true; text: string } | { ok: false; reason: 'mismatch'; index: number } | { ok: false; reason: 'invalid'; error: string }

interface Member { key: string; lead: string; keyEnd: number; valueStart: number; valueEnd: number }

/** A small JSON scanner that keeps positions (the parsed values come from JSON.parse of each slice). */
class Scanner {
  constructor(readonly text: string) {}
  ws(i: number): number { while (i < this.text.length && ' \t\r\n'.includes(this.text[i])) i++; return i }
  fail(i: number, what: string): never { throw new Error(`${what} at ${i}`) }
  string(i: number): number {
    if (this.text[i] !== '"') this.fail(i, 'string expected')
    for (let k = i + 1; k < this.text.length; k++) { if (this.text[k] === '\\') k++; else if (this.text[k] === '"') return k + 1 }
    return this.fail(i, 'unterminated string')
  }
  /** End of the value starting at `i` (after whitespace). */
  value(i: number): number {
    const c = this.text[i]
    if (c === '"') return this.string(i)
    if (c === '{') return this.object(i).end
    if (c === '[') return this.array(i).end
    let k = i
    while (k < this.text.length && !',]} \t\r\n'.includes(this.text[k])) k++
    return k > i ? k : this.fail(i, 'value expected')
  }
  object(i: number): { members: Member[]; end: number } {
    const members: Member[] = []
    let k = this.ws(i + 1)
    if (this.text[k] === '}') return { members, end: k + 1 }
    let sepEnd = i + 1
    for (;;) {
      const keyStart = this.ws(sepEnd), keyEnd = this.string(keyStart), colon = this.ws(keyEnd)
      if (this.text[colon] !== ':') this.fail(colon, '":" expected')
      const valueStart = this.ws(colon + 1), valueEnd = this.value(valueStart)
      members.push({ key: JSON.parse(this.text.slice(keyStart, keyEnd)) as string, lead: this.text.slice(sepEnd, keyStart), keyEnd, valueStart, valueEnd })
      k = this.ws(valueEnd)
      if (this.text[k] === '}') return { members, end: k + 1 }
      if (this.text[k] !== ',') this.fail(k, '"," or "}" expected')
      sepEnd = k + 1
    }
  }
  array(i: number): { items: number[]; end: number } {
    const items: number[] = []
    let k = this.ws(i + 1)
    if (this.text[k] === ']') return { items, end: k + 1 }
    for (;;) {
      items.push(k)
      k = this.ws(this.value(k))
      if (this.text[k] === ']') return { items, end: k + 1 }
      if (this.text[k] !== ',') this.fail(k, '"," or "]" expected')
      k = this.ws(k + 1)
    }
  }
}

/**
 * A gain as written: its shortest exact form (no rounding here — Studio rounds only the gains it makes, so an undo
 * writes the recorded value back exactly).
 */
export const formatGain = (gain: number) => String(gain)

export function rewriteViewerDataGains(text: string, changes: readonly FiringGainChange[]): ViewerDataRewrite {
  const sc = new Scanner(text)
  const edits: { at: number; end: number; text: string }[] = []
  try {
    const start = sc.ws(text.charCodeAt(0) === 0xfeff ? 1 : 0)
    if (text[start] !== '{') sc.fail(start, '"{" expected')
    const root = sc.object(start), events = root.members.find(m => m.key === 'events')
    if (!events || text[events.valueStart] !== '[') return { ok: false, reason: 'invalid', error: 'events is missing' }
    const items = sc.array(events.valueStart).items
    for (const change of changes) {
      const at = items[change.index]
      if (at === undefined || text[at] !== '{') return { ok: false, reason: 'mismatch', index: change.index }
      const members = sc.object(at).members, value = (key: string) => { const m = members.find(x => x.key === key); return m ? JSON.parse(text.slice(m.valueStart, m.valueEnd)) as unknown : undefined }
      const t = value('t')
      if (value('name') !== change.name || typeof t !== 'number' || Math.abs(t - change.t) > 1e-6) return { ok: false, reason: 'mismatch', index: change.index }
      const gain = members.find(m => m.key === 'gain'), written = formatGain(change.gain)
      // The same number in another form (`1.0`) is left as written.
      if (gain) { if (JSON.parse(text.slice(gain.valueStart, gain.valueEnd)) !== change.gain) edits.push({ at: gain.valueStart, end: gain.valueEnd, text: written }) }
      else if (change.gain !== 1) {
        // After the last member, in its style: its lead (newline + indent) and its key-to-value separator.
        const last = members[members.length - 1]
        if (!last) return { ok: false, reason: 'mismatch', index: change.index }
        edits.push({ at: last.valueEnd, end: last.valueEnd, text: `,${last.lead}"gain"${text.slice(last.keyEnd, last.valueStart)}${written}` })
      }
    }
  } catch (error) { return { ok: false, reason: 'invalid', error: error instanceof Error ? error.message : String(error) } }
  let out = text
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.end)
  return { ok: true, text: out }
}
