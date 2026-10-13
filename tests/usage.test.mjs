import { expect, it } from 'vitest'
import { compactTokens, totalTokens } from '../src/usage.mjs'

it('formats decimal K/M/B and does not duplicate cached input or reasoning', () => {
  expect(totalTokens({ inputTokens: 1000, cachedInputTokens: 800, outputTokens: 200, reasoningOutputTokens: 100 })).toBe(1200)
  expect(totalTokens({ input_tokens: 1000, cached_input_tokens: 800, output_tokens: 200 })).toBe(1200)
  expect(totalTokens({ total_tokens: 0 })).toBe(0)
  expect(totalTokens(null)).toBeNull()
  expect(totalTokens({ output_tokens: 20 })).toBeNull()
  expect([0, 999, 1234, 1_234_567, 1_234_567_890, 999_999, null].map(compactTokens)).toEqual(['0', '999', '1.23 K', '1.23 M', '1.23 B', '1 M', '—'])
})
