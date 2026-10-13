export function totalTokens(usage) {
  if (!usage) return null
  const total = usage.totalTokens ?? usage.total_tokens
  if (Number.isFinite(total) && total >= 0) return total
  const input = usage.inputTokens ?? usage.input_tokens
  const output = usage.outputTokens ?? usage.output_tokens
  // Cached tokens are a subset of input; reasoning is a subset of output.
  return Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0 ? input + output : null
}

export function compactTokens(value) {
  if (!Number.isFinite(value) || value < 0) return '—'
  const unit = value >= 1e9 ? [1e9, 'B'] : value >= 1e6 ? [1e6, 'M'] : value >= 1e3 ? [1e3, 'K'] : [1, '']
  const rounded = Number((value / unit[0]).toFixed(2))
  // Carry rounded boundary values into the next unit.
  if (rounded >= 1000 && unit[1] === 'K') return '1 M'
  if (rounded >= 1000 && unit[1] === 'M') return '1 B'
  return `${rounded}${unit[1] ? ` ${unit[1]}` : ''}`
}

export function formatCumulative(tokens, cost) {
  const amount = Number.isFinite(cost?.usd) && cost.usd >= 0
    ? `${cost.usd > 0 && cost.usd < 0.01 ? '<0.01' : cost.usd.toFixed(2)}$` : '—$'
  return `${compactTokens(tokens).replace(/ /g, '')}/${amount}`
}

export function costDescription(cost) {
  if (!cost) return '等待完整会话用量与模型价格。'
  const lines = [`按官方 API 模型价格估算，价格表：${cost.priceDate}；逐请求累计，包含缓存、缓存写入、输出和工具参数 token。`,
    'GPT-6.1 Sol 按设置的 500K 单次输入阈值计费；其它模型遵循价格表阈值。']
  if (cost.solThreshold !== 500_000) lines[1] = `GPT-6.1 Sol 单次输入阈值：${cost.solThreshold}。`
  if (cost.assumedTier) lines.push(`${cost.assumedTier} 次请求未记录速率模式，按标准价格估算。`)
  if (cost.unpriced) lines.push(`${cost.unpriced} 次请求缺少官方价格或完整用量；已知部分 ${cost.subtotalUsd.toFixed(2)}$，总费用未知。`)
  lines.push('显示 API 等价模型费用，不代表订阅账单；不计外部工具服务费。')
  return lines.join('\n')
}
