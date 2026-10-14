import { Tiktoken } from 'js-tiktoken/lite'
import ranks from 'js-tiktoken/ranks/o200k_base'
import { HostMessageDecoder, notificationFrom } from './protocol.mjs'
import { SpeedMetrics } from './metrics.mjs'
import { compactTokens, formatCumulative, costDescription } from './usage.mjs'
import { readComposer, effortLabel } from './composer.mjs'
import { gaugeMaximum, gaugeRatio } from './gauge.mjs'
import { panelMarkup, toolbarIcon } from './panel.mjs'
import { readActiveContext } from './context.mjs'

const VERSION = '0.4.6'
const KEY = '__codexSpeedHUD'

export function installHUD(window, countTokens) {
  if (window[KEY]?.version === VERSION) return window[KEY]
  window[KEY]?.destroy()
  const { document } = window
  const decoder = new HostMessageDecoder()
  const metrics = new SpeedMetrics({ countTokens, now: () => window.performance.now() })
  const root = document.createElement('div')
  root.id = 'codex-speed-hud'
  root.style.cssText = 'position:fixed;right:20px;bottom:100px;z-index:2147483000;width:min(320px,calc(100vw - 24px));color-scheme:light dark;'
  const shadow = root.attachShadow({ mode: 'open' })
  shadow.innerHTML = panelMarkup()
  const launcher = document.createElement('button')
  launcher.type = 'button'
  launcher.dataset.codexSpeedHudToggle = 'true'
  launcher.setAttribute('aria-controls', root.id)
  launcher.innerHTML = toolbarIcon
  launcher.style.cssText = 'color:light-dark(#9b75ed,#b498ff);width:28px;height:28px;padding:0;flex-shrink:0;'
  launcher.firstElementChild.style.cssText = 'width:18px;height:18px;'
  function mountToolbar() {
    const anchor = [...document.querySelectorAll('[data-app-shell-header-slot-content] button[data-app-shell-workspace-layout-toggle="main"]')]
      .find(button => !button.closest('[hidden],[inert],[aria-hidden="true"]'))
    const group = anchor?.parentElement?.parentElement
    if (!group || group.tagName !== 'DIV') { launcher.remove(); return }
    launcher.className = anchor.className
    launcher.style.colorScheme = root.style.colorScheme
    // Place the local UI control before the existing separator and new-tab button.
    // Never copy the App's action data attributes or route clicks to its native handlers.
    if (launcher.parentElement !== group) group.insertBefore(launcher, group.firstChild)
    launcher.setAttribute('aria-expanded', String(!closed))
    launcher.setAttribute('aria-label', closed ? '打开速率面板' : '隐藏速率面板')
    launcher.title = closed ? '打开速率面板' : '隐藏速率面板'
  }
  const nodes = Object.fromEntries(['model', 'effort', 'mode', 'fast', 'selection', 'first', 'speed', 'average', 'tokens', 'status', 'source', 'dot', 'needle', 'arc', 'caption'].map(name => [name, shadow.querySelector(`[data-${name}]`)]))
  nodes.average.title = '本次用户消息对应的整轮回复平均输出速度，包含中间多次输出，不计等待时间。下一条用户消息重新统计。'
  nodes.tokens.title = '当前聊天全部请求的累计用量：未缓存输入＋缓存输入＋输出。缓存已包含在输入里，推理已包含在输出里。K=千，M=百万，B=十亿；不是当前上下文长度。'
  const statusLabels = { waiting: '等待首次输出', streaming: '正在生成', paused: '等待后续输出', thinking: '正在思考', tool: '正在执行工具', compacting: '正在压缩上下文', completed: '已完成', interrupted: '已中断', failed: '失败', 'no-turn': '尚未观测到此聊天的回合' }
  let closed = false
  let stopped = false
  let pointer = null
  let collapsed = false
  let lastBridgeAt = null
  let lastState = {}
  let maximum = 200
  const storage = {
    get() { try { return JSON.parse(window.localStorage.getItem('codex-speed-hud-position') ?? 'null') } catch { return null } },
    set(value) { try { window.localStorage.setItem('codex-speed-hud-position', JSON.stringify(value)) } catch { /* Storage may be disabled by the host. */ } },
  }
  const saved = storage.get()
  const clampPosition = (left, top) => {
    root.style.left = `${Math.max(8, Math.min(left, Math.max(8, window.innerWidth - root.offsetWidth - 8)))}px`
    root.style.top = `${Math.max(8, Math.min(top, Math.max(8, window.innerHeight - root.offsetHeight - 8)))}px`
    root.style.right = 'auto'; root.style.bottom = 'auto'
  }
  if (document.body) document.body.append(root)
  else document.documentElement?.append(root)
  if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) clampPosition(saved.left, saved.top)

  function activeContext() {
    return readActiveContext(window, threadId => {
      const hosts = [...metrics.turns.values()].filter(turn => turn.threadId === threadId).map(turn => turn.hostId)
      for (const key of metrics.models.keys()) if (key.endsWith(`:${threadId}`)) hosts.push(key.slice(0, -threadId.length - 1))
      return hosts
    })
  }

  const ms = value => value === null || value === undefined ? '—' : `${(value / 1000).toFixed(2)} s`
  function render() {
    if (stopped) return
    const theme = document.documentElement?.dataset.theme
    const scheme = theme === 'dark' || theme === 'light' ? theme : 'light dark'
    if (root.style.colorScheme !== scheme) root.style.colorScheme = scheme
    if (!root.isConnected) document.body?.append(root)
    mountToolbar()
    const { threadId, hostId, source: contextSource } = activeContext()
    lastState = threadId && hostId ? metrics.snapshot(threadId, hostId) : { threadId, hostId, status: 'no-thread' }
    lastState.contextSource = contextSource
    nodes.model.textContent = lastState.recordedModel ?? (threadId || contextSource === 'pending-new-thread' ? '等待输出记录' : '请选择一个聊天')
    nodes.effort.textContent = effortLabel(lastState.recordedEffort)
    nodes.selection.title = '上一次结束输出所记录的模型和推理强度。'
    const fast = lastState.recordedFastMode
    nodes.mode.dataset.fastActive = fast == null ? 'unknown' : String(fast)
    nodes.fast.textContent = fast == null ? '待确认' : fast ? 'FAST' : '标准'
    nodes.mode.title = fast == null ? '上次输出的速率模式未记录。' : fast ? '上次输出：Fast 模式' : '上次输出：标准模式'
    nodes.first.textContent = ms(lastState.firstTokenMs)
    const nativeStream = lastState.nativeStream
    const frozen = lastState.nativeSpeedSnapshot
    const speedStream = nativeStream?.toolTPS != null || nativeStream?.kind === 'compaction' && nativeStream.totalAverageTPS != null
      ? nativeStream : frozen ?? nativeStream
    const compaction = lastState.compaction
    const compactStream = speedStream?.kind === 'compaction' ? speedStream : null
    const compactEpoch = compactStream ? compactStream.completedAt ?? compactStream.startedAt : compaction?.completedAt ?? compaction?.completedEpoch ?? compaction?.startedEpoch ?? 0
    const compactAverage = compactStream ? compactStream.totalAverageTPS : compaction?.totalAverageTPS
    const compactCurrent = compactEpoch >= Math.max(lastState.lastBodyAtEpoch ?? 0, speedStream?.kind === 'response' && speedStream.toolTPS != null ? speedStream.toolLastAt ?? 0 : 0) && (compactStream || compaction)
    const toolStream = speedStream?.kind === 'response' && speedStream.toolTPS != null && speedStream.toolLastAt >= (lastState.lastBodyAtEpoch ?? 0)
    const speed = compactCurrent && compactAverage != null ? compactAverage : toolStream ? speedStream.toolTPS : lastState.displayTPS
    const observedClient = nativeStream?.source === 'native-observer'
    const rawFirst = lastState.nativeFirstSnapshot?.basis === 'generation-trigger' ? lastState.nativeFirstSnapshot.ms : null
    const rawEpoch = lastState.nativeFirstSnapshot?.at ?? 0
    const showRawFirst = rawFirst != null && (observedClient
      || rawEpoch >= (lastState.lastModelAtEpoch ?? 0))
    if (showRawFirst) nodes.first.textContent = ms(rawFirst)
    nodes.speed.textContent = speed == null ? '—' : speed.toFixed(1)
    nodes.caption.textContent = '速率'
    nodes.speed.title = compactCurrent && compactAverage != null ? '上一次压缩的输出 token ÷ 压缩总耗时，包含等待；保留到下一次输出更新。' : toolStream ? speedStream.toolHeld || speedStream !== nativeStream ? '上一次工具参数输出的速率快照。' : '模型生成工具参数的速率，不包含工具执行输出。' : lastState.speedHeld ? '上一次输出的速率，下一次输出后更新。' : '最近约 2 秒的文字输出速度。'
    lastState.shownTPS = speed; lastState.shownFirstMs = showRawFirst ? rawFirst : lastState.firstTokenMs
    lastState.measurementKind = compactCurrent && compactAverage != null ? 'compaction-average' : toolStream ? 'tool-arguments' : lastState.bodyRateKind ?? 'body'
    if (lastState.measurementKind === 'cloud-message-average') nodes.speed.title = '上一次云端完整消息的输出 tok ÷ 官方消息起止时间；这是消息平均吞吐，保留到下一次有效输出。'
    const nextMaximum = gaugeMaximum(speed, maximum)
    if (nextMaximum !== maximum) {
      maximum = nextMaximum
      for (const label of shadow.querySelectorAll('[data-scale]')) label.textContent = compactTokens(maximum * Number(label.dataset.scale) / 4)
    }
    const ratio = gaugeRatio(speed, maximum)
    const rotation = `rotate(${-90 + ratio * 180}deg)`
    if (nodes.needle.style.transform !== rotation) nodes.needle.style.transform = rotation
    nodes.arc.style.strokeDashoffset = String(100 - ratio * 100)
    nodes.arc.style.opacity = ratio > 0 ? '1' : '0'
    shadow.querySelector('.meter').setAttribute('aria-label', `速率 ${nodes.speed.textContent} tok/s`)
    const average = observedClient ? nativeStream.turnAverageTPS : lastState.averageTPS
    nodes.average.textContent = average == null ? '—' : `${average.toFixed(1)} tok/s`
    nodes.average.title = observedClient ? '本次用户对话内已完成的模型调用：输出 token 总数 ÷ 调用总耗时，包含首流等待、工具参数和压缩；不包含历史轮次。' : '本次用户对话内观察到的正文流与带明确起止时间的云端完整消息平均速率；不包含历史轮次。'
    nodes.tokens.textContent = formatCumulative(lastState.sessionTokens, lastState.sessionCost)
    nodes.tokens.title = `当前聊天累计输入＋输出；缓存和推理不重复相加。K=千，M=百万，B=十亿。\n${costDescription(lastState.sessionCost)}`
    nodes.status.textContent = contextSource === 'pending-new-thread' ? '等待新聊天开始' : lastState.limited ? '长文本：实时估算已暂停' : statusLabels[lastState.status] ?? (threadId && !hostId ? '同名聊天：主机未确认' : '等待当前聊天')
    nodes.source.textContent = decoder.dropped ? `丢失 ${decoder.dropped}` : ''
    nodes.dot.dataset.connected = String(lastBridgeAt !== null)
    nodes.dot.title = lastBridgeAt === null ? '等待连接' : '流事件已连接'
    nodes.first.title = lastState.firstHeld ? '上一次测得的首流延迟，测到新值后更新。' : '本次回合开始至首个模型流事件的延迟，包含思考，不等待正文。'
    if (showRawFirst) nodes.first.title = '最近一次测得的 Codex 生成任务触发至第一条响应流事件，包含本机准备与连接等待；工具后的生成和压缩分别计时，不等待有效文字。'
  }
  function onMessage(event) {
    if (event.source && event.source !== window) return
    const decoded = decoder.accept(event.data)
    const notification = notificationFrom(decoded)
    if (!notification) return
    // Capture request settings once; live composer edits never change the displayed record.
    if (notification.method === 'turn/started' && notification.hostId !== 'durable') {
      const context = activeContext()
      const threadId = notification.params.threadId ?? notification.params.thread?.id
      if (threadId === context.threadId && notification.hostId === context.hostId) {
        const selection = readComposer(document, threadId)
        notification.settings = { modelLabel: selection.model, reasoningEffort: selection.effort, fastMode: selection.fast }
      }
    }
    lastBridgeAt = window.performance.now()
    metrics.accept(notification)
  }
  function onPointerDown(event) {
    if (event.target.closest('button')) return
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, left: root.getBoundingClientRect().left, top: root.getBoundingClientRect().top }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function onPointerMove(event) { if (pointer?.id === event.pointerId) clampPosition(pointer.left + event.clientX - pointer.x, pointer.top + event.clientY - pointer.y) }
  function onPointerUp() { if (pointer) storage.set({ left: root.getBoundingClientRect().left, top: root.getBoundingClientRect().top }); pointer = null }
  const header = shadow.querySelector('header')
  header.addEventListener('pointerdown', onPointerDown)
  header.addEventListener('pointermove', onPointerMove)
  header.addEventListener('pointerup', onPointerUp)
  header.addEventListener('pointercancel', onPointerUp)
  shadow.querySelector('[data-collapse]').addEventListener('click', event => {
    collapsed = !collapsed; shadow.querySelector('main').hidden = collapsed
    event.currentTarget.textContent = collapsed ? '+' : '−'
    event.currentTarget.setAttribute('aria-label', collapsed ? '展开面板' : '收起面板')
  })
  const panel = shadow.querySelector('section')
  function setClosed(value, focus = false) {
    closed = value
    panel.hidden = closed
    root.hidden = closed
    // Expansion near the screen edge must keep the entire panel reachable.
    if (root.style.left) clampPosition(parseFloat(root.style.left), parseFloat(root.style.top))
    render()
    if (focus) (closed ? launcher : shadow.querySelector('[data-close]')).focus()
  }
  shadow.querySelector('[data-close]').addEventListener('click', () => setClosed(true, true))
  launcher.addEventListener('click', () => {
    const opening = closed
    if (opening) { collapsed = false; shadow.querySelector('main').hidden = false; shadow.querySelector('[data-collapse]').textContent = '−'; shadow.querySelector('[data-collapse]').setAttribute('aria-label', '收起面板') }
    setClosed(opening ? false : true)
  })
  function onResize() { if (root.style.left) clampPosition(parseFloat(root.style.left), parseFloat(root.style.top)) }
  window.addEventListener('message', onMessage)
  window.addEventListener('resize', onResize)
  const timer = window.setInterval(render, 250)
  window[KEY] = {
    version: VERSION,
    snapshot() { render(); return { ...lastState, notifications: metrics.notifications, droppedTransfers: decoder.dropped, visible: !closed } },
    inspect(threadId, hostId) { return metrics.snapshot(threadId, hostId) },
    applyNative(value) { metrics.applyNative(value); render() },
    show() { setClosed(false) },
    destroy() { stopped = true; window.clearInterval(timer); window.removeEventListener('message', onMessage); window.removeEventListener('resize', onResize); root.remove(); launcher.remove(); delete window[KEY] },
  }
  render()
  return window[KEY]
}

if (typeof window !== 'undefined' && window.top === window && !window.__CODEX_SPEED_HUD_TEST__ && window[KEY]?.version !== VERSION) {
  // The public encoding supplies local estimates; service-side tokenization can differ.
  const encoder = new Tiktoken(ranks)
  installHUD(window, text => encoder.encode(text, [], []).length)
}
