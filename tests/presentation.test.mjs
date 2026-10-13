import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { readComposer } from '../src/composer.mjs'
import { gaugeMaximum, gaugeRatio } from '../src/gauge.mjs'

describe('model selection metadata', () => {
  it('reads native fast/ultrafast icons, excludes daybreak, and handles ambiguity', () => {
    const dom = new JSDOM('<body><button data-codex-intelligence-trigger="true" data-selected-reasoning-effort="xhigh"><span class="_ModelPickerTriggerModelText_abc">GPT-6.1 Sol</span><svg class="_ModelPickerTriggerInlineModeIcon_abc"></svg></button></body>')
    const doc = dom.window.document
    const visible = () => true
    expect(readComposer(doc, 't', visible)).toMatchObject({ model: 'GPT-6.1 Sol', effortLabel: 'Extra High', fast: true })
    doc.querySelector('svg').setAttribute('data-daybreak-indicator', 'true')
    expect(readComposer(doc, 't', visible).fast).toBeNull()
    doc.querySelector('svg').remove()
    expect(readComposer(doc, 't', visible).fast).toBe(false)
    doc.body.append(doc.querySelector('button').cloneNode(true))
    expect(readComposer(doc, 't', visible).trigger).toBeNull()
    dom.window.close()
  })
  it('chooses the matching conversation rather than an unrelated composer', () => {
    const dom = new JSDOM('<body><div data-conversation-id="a"><button data-codex-intelligence-trigger="true" data-selected-model-label="A"></button></div><div data-conversation-id="b"><button data-codex-intelligence-trigger="true" data-selected-model-label="B"></button></div></body>')
    expect(readComposer(dom.window.document, 'b', () => true).model).toBe('B')
    dom.window.close()
  })
})

it('expands speedometer scale without clipping the numerical rate', () => {
  expect(gaugeMaximum(180)).toBe(200)
  expect(gaugeMaximum(205)).toBe(400)
  expect(gaugeMaximum(850)).toBe(1600)
  expect(gaugeMaximum(null, 400)).toBe(400)
  expect(gaugeRatio(64.8, 200)).toBeCloseTo(0.324)
  expect(gaugeRatio(null, 200)).toBe(0)
  expect(gaugeRatio(900, 200)).toBe(1)
})
