import { describe, expect, it } from 'vitest'
import { formatMessage, messages } from './messages'

describe('Studio message catalogue', () => {
  it('defines both locales for every message', () => {
    for (const [id, message] of Object.entries(messages)) {
      expect(message.ja, `${id} must define Japanese`).not.toBe('')
      expect(message.en, `${id} must define English`).not.toBe('')
    }
  })

  it('keeps interpolation placeholders aligned between locales', () => {
    const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    for (const [id, message] of Object.entries(messages)) {
      expect(placeholders(message.en), `${id} placeholder mismatch`).toEqual(placeholders(message.ja))
    }
  })

  it('formats dynamic values without changing the message ID', () => {
    expect(formatMessage(messages['header.helperUpdate'].en, { version: '0.7.1' }))
      .toBe('Helper v0.7.1 available')
  })
})
