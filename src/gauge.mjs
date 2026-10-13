export function gaugeMaximum(rate, previous = 200) {
  let maximum = previous
  if (Number.isFinite(rate)) while (rate > maximum && maximum < 1e9) maximum *= 2
  return maximum
}

export function gaugeRatio(rate, maximum) {
  return Number.isFinite(rate) && rate >= 0 ? Math.min(1, rate / maximum) : 0
}

export function gaugeMarkup() {
  const tick = (i) => {
    const angle = Math.PI - i * Math.PI / 20
    const major = i % 5 === 0
    const point = radius => `${(140 + radius * Math.cos(angle)).toFixed(2)} ${(139 - radius * Math.sin(angle)).toFixed(2)}`
    return `<path class="tick${major ? ' major' : ''}" d="M${point(major ? 91 : 97)}L${point(104)}"/>`
  }
  const labels = Array.from({ length: 5 }, (_, i) => {
    const angle = Math.PI - i * Math.PI / 4
    const x = 140 + 76 * Math.cos(angle)
    const y = i === 0 || i === 4 ? 152 : 139 - 76 * Math.sin(angle) + 4
    return `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" data-scale="${i}">${i * 50}</text>`
  }).join('')
  return `<svg class="dial" viewBox="0 0 280 155" aria-hidden="true" focusable="false">
    <path class="track" d="M28 139 A112 112 0 0 1 252 139"/>
    <path class="progress" d="M28 139 A112 112 0 0 1 252 139" pathLength="100" data-arc/>
    ${Array.from({ length: 21 }, (_, i) => tick(i)).join('')}${labels}
    <g class="needle" data-needle><path d="M140 139 L140 58"/><circle cx="140" cy="139" r="5"/></g>
    <circle class="hub" cx="140" cy="139" r="2"/>
  </svg>`
}
