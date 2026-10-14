import { totalTokens } from './usage.mjs'
import { modelLabel } from './composer.mjs'

const LIMIT = 64
const TEXT_LIMIT = 256_000
const validMs = (n) => Number.isFinite(n) && n >= 0 ? n : null
const newItem = () => ({ text: '', tokens: 0, dirty: false, firstAt: null, lastAt: null, completed: false, lifecycleStart: null, serverStart: null })

export class SpeedMetrics {
  constructor({ countTokens, now = () => performance.now() }) {
    this.countTokens = countTokens
    this.now = now
    this.turns = new Map()
    this.models = new Map()
    this.lastTurns = new Map()
    this.notifications = 0
    this.sessions = new Map()
  }

  session(hostId, threadId) {
    const key = JSON.stringify([hostId, threadId])
    if (!this.sessions.has(key)) {
      this.sessions.set(key, { usage: null, cost: null, lastTPS: null, lastFirst: null, lastResponse: null, compaction: null, nativeStream: null })
      while (this.sessions.size > LIMIT) this.sessions.delete(this.sessions.keys().next().value)
    }
    return this.sessions.get(key)
  }

  key(hostId, threadId, turnId) { return JSON.stringify([hostId, threadId, turnId]) }

  captureFirst(turn) {
    const ms = turn.firstStreamMs
    if (ms === null) return
    const session = this.session(turn.hostId, turn.threadId)
    // Older records may fill missing observations, never replace a newer retained turn.
    if (this.lastTurns.get(`${turn.hostId}:${turn.threadId}`) === turn.turnId || session.lastFirst?.turnId === turn.turnId) {
      session.lastFirst = { turnId: turn.turnId, ms, source: 'stream-event' }
    }
  }

  freezeResponse(turn) {
    const session = this.session(turn.hostId, turn.threadId)
    if (this.lastTurns.get(`${turn.hostId}:${turn.threadId}`) !== turn.turnId && session.lastResponse?.turnId !== turn.turnId) return
    session.lastResponse = {
      turnId: turn.turnId,
      model: modelLabel(turn.model) ?? turn.settings?.modelLabel ?? null,
      reasoningEffort: turn.settings?.reasoningEffort ?? null,
      fastMode: turn.settings?.fastMode ?? null,
    }
  }

  ensure(hostId, threadId, turnId, started = false, at = this.now()) {
    const key = this.key(hostId, threadId, turnId)
    let turn = this.turns.get(key)
    const fresh = !turn
    if (!turn) {
      turn = { hostId, threadId, turnId, startedAt: started ? at : null, status: 'waiting', model: this.models.get(`${hostId}:${threadId}`) ?? 'unknown', items: new Map(), tools: new Set(), firstVisibleMs: null, firstStreamMs: null, firstEventSeen: false, nativeTTFT: null, usage: null, samples: [], visibleTokens: 0, streamTokens: 0, streamMs: 0, liveTPS: null, limited: false }
      this.turns.set(key, turn)
      while (this.turns.size > LIMIT) {
        const oldestKey = this.turns.keys().next().value
        const oldest = this.turns.get(oldestKey)
        const contextKey = `${oldest.hostId}:${oldest.threadId}`
        if (this.lastTurns.get(contextKey) === oldest.turnId) this.lastTurns.delete(contextKey)
        this.turns.delete(oldestKey)
      }
    }
    if (fresh || started) this.lastTurns.set(`${hostId}:${threadId}`, turnId)
    return turn
  }

  accept({ method, params: p, hostId = 'local', settings }, at = this.now()) {
    this.notifications++
    const threadId = p.threadId ?? p.thread?.id
    if (!threadId) return
    const session = this.session(hostId, threadId)
    if (method === 'thread/tokenUsage/updated' && p.tokenUsage?.total) session.usage = p.tokenUsage.total
    if (method === 'thread/started') {
      if (p.thread?.model) this.models.set(`${hostId}:${threadId}`, p.thread.model)
      while (this.models.size > LIMIT) this.models.delete(this.models.keys().next().value)
      return
    }
    const turnId = p.turnId ?? p.turn?.id
    if (!turnId) return
    const turn = this.ensure(hostId, threadId, turnId, method === 'turn/started', at)
    if (['completed', 'interrupted', 'failed'].includes(turn.status) && !['thread/tokenUsage/updated', 'turn/completed', 'model/rerouted'].includes(method)) return
    if (method === 'turn/started') {
      if (!turn.settings && settings) turn.settings = { ...settings }
      // Do not reset timing or counters on a duplicate lifecycle notification.
      if (turn.startedAt === null && !turn.items.size && !turn.firstEventSeen) turn.startedAt = at
      return
    }
    const modelStreamEvent = ['item/agentMessage/delta', 'item/reasoning/summaryPartAdded', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta', 'rawResponseItem/completed'].includes(method)
      || (method === 'item/started' && ['agentMessage', 'reasoning'].includes(p.item?.type))
    if (modelStreamEvent && !turn.firstEventSeen) {
      turn.firstEventSeen = true
      session.lastModelAtEpoch = Date.now()
      if (turn.startedAt !== null) turn.firstStreamMs = validMs(at - turn.startedAt)
      this.captureFirst(turn)
    }
    if (method === 'model/rerouted') turn.model = p.toModel ?? turn.model
    if (method === 'thread/tokenUsage/updated') turn.usage = p.tokenUsage?.last ?? null
    if (method === 'error' && !p.willRetry) turn.status = 'failed'
    if (method === 'item/started' || method === 'item/completed') {
      const item = p.item
      if (!item?.id) return
      if (item.type === 'contextCompaction') {
        if (method === 'item/started') {
          this.sample(turn, at)
          session.compaction = { itemId: item.id, turnId, status: 'running', startedAt: at, startedEpoch: Date.now(), elapsedMs: null, outputTokens: null, responseId: null }
        } else if (session.compaction?.itemId === item.id && session.compaction.status === 'running') {
          session.compaction.status = 'completed'
          session.compaction.elapsedMs = Math.max(0, at - session.compaction.startedAt)
          session.compaction.completedEpoch = Date.now()
        }
      } else if (item.type === 'agentMessage') {
        let state = turn.items.get(item.id)
        if (!state) {
          state = newItem()
          turn.items.set(item.id, state)
        }
        if (state.completed) return
        if (method === 'item/started' && state.lifecycleStart === null) {
          state.lifecycleStart = at
          state.serverStart = validMs(p.startedAtMs)
        }
        if (method === 'item/completed') {
          // Capture the final dirty delta while the message is still active.
          this.sample(turn, at)
          // Hydrated final text supplies a count, never invented streaming timing.
          const text = typeof item.text === 'string' ? item.text : state.text
          if (hostId === 'durable' && state.firstAt === null && state.lifecycleStart !== null && text.length <= TEXT_LIMIT) {
            const finish = validMs(p.completedAtMs)
            // Both timestamps must belong to this observed item on the same cloud clock.
            // Batches received milliseconds apart are not instantaneous model generation.
            const duration = state.serverStart !== null && finish !== null ? finish - state.serverStart : null
            if (duration >= 250 && duration <= 86_400_000) {
              state.completionTokens = this.countTokens(text)
              state.completionMs = duration
              session.lastTPS = state.completionTokens * 1000 / duration
              session.lastRateKind = 'cloud-message-average'
              session.lastBodyAtEpoch = Date.now()
              this.freezeResponse(turn)
            }
          }
          // A mid-stream attachment must not count unobserved hydrated text as live output.
          if (state.firstAt === null) { state.text = text.slice(0, TEXT_LIMIT); state.dirty = true }
          state.completed = true
          if (state.firstAt !== null) this.freezeResponse(turn)
          if (text.length > TEXT_LIMIT) turn.limited = true
        }
      } else if (!['userMessage', 'reasoning', 'plan'].includes(item.type)) {
        if (method === 'item/started') this.sample(turn, at)
        if (method === 'item/started') turn.tools.add(item.id)
        else turn.tools.delete(item.id)
      }
    }
    if (method === 'item/agentMessage/delta' && typeof p.delta === 'string' && p.delta.length) {
      if (['completed', 'interrupted', 'failed'].includes(turn.status)) return
      let state = turn.items.get(p.itemId)
      if (!state) { state = newItem(); turn.items.set(p.itemId, state) }
      if (state.completed) return
      if (state.firstAt === null) {
        state.firstAt = at
        // Samples begin at the first visible delta, not at turn start/tool waits.
        turn.samples = [{ at, tokens: turn.visibleTokens }]
      }
      if (turn.firstVisibleMs === null && turn.startedAt !== null) turn.firstVisibleMs = validMs(at - turn.startedAt)
      this.captureFirst(turn)
      const elapsed = state.lastAt === null ? 0 : at - state.lastAt
      // Text can stream while a parallel tool is still running; count actual text intervals.
      if (elapsed >= 0 && elapsed < 1500) state.streamMs = (state.streamMs ?? 0) + elapsed
      state.lastAt = at
      session.lastBodyAtEpoch = Date.now()
      state.text = (state.text + p.delta).slice(0, TEXT_LIMIT)
      state.dirty = true
      if (state.text.length === TEXT_LIMIT) turn.limited = true
      turn.status = 'streaming'
    }
    if (['item/reasoning/summaryPartAdded', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'].includes(method)
      || method === 'item/started' && p.item?.type === 'reasoning') turn.status = 'thinking'
    if (method === 'turn/completed') {
      this.sample(turn, at)
      turn.status = p.turn.status ?? 'completed'
      turn.tools.clear()
      turn.liveTPS = null
      if (session.compaction?.status === 'running' && session.compaction.turnId === turnId) {
        session.compaction.status = turn.status === 'completed' ? 'completed' : 'interrupted'
        session.compaction.elapsedMs = Math.max(0, at - session.compaction.startedAt)
        session.compaction.completedEpoch = Date.now()
      }
      if (turn.firstEventSeen) this.freezeResponse(turn)
      for (const item of turn.items.values()) item.text = ''
    }
  }

  sample(turn, at = this.now()) {
    let changed = false
    for (const item of turn.items.values()) {
      if (item.dirty) { item.tokens = this.countTokens(item.text); item.dirty = false; changed = true }
    }
    // One user turn owns all intermediate messages and tool cycles, never historical turns.
    if (!turn.limited) {
      const streamed = [...turn.items.values()].filter(item => item.firstAt !== null && item.streamMs > 0)
      turn.streamTokens = streamed.reduce((sum, item) => sum + item.tokens, 0) + [...turn.items.values()].reduce((sum, item) => sum + (item.completionTokens ?? 0), 0)
      turn.streamMs = streamed.reduce((sum, item) => sum + item.streamMs, 0) + [...turn.items.values()].reduce((sum, item) => sum + (item.completionMs ?? 0), 0)
    }
    turn.visibleTokens = [...turn.items.values()].reduce((sum, item) => sum + item.tokens, 0)
    const active = [...turn.items.values()].some(item => !item.completed && item.lastAt !== null && at - item.lastAt < 1500)
    if (!active || turn.limited) { turn.liveTPS = null; return }
    if (changed || turn.samples.length) turn.samples.push({ at, tokens: turn.visibleTokens })
    while (turn.samples.length > 2 && turn.samples[1].at < at - 2000) turn.samples.shift()
    const first = turn.samples[0]
    turn.liveTPS = first && at - first.at >= 250 ? Math.max(0, (turn.visibleTokens - first.tokens) * 1000 / (at - first.at)) : null
    // Only fresh text updates the retained snapshot; idle polling must not decay it.
    if (changed && turn.liveTPS !== null && turn.liveTPS > 0) {
      const session = this.session(turn.hostId, turn.threadId)
      session.lastTPS = turn.liveTPS
      session.lastRateKind = 'body'
    }
    if (turn.tools.size) turn.liveTPS = null
  }

  applyNative(value) {
    if (value.nativeStream?.source === 'native-observer' && ((value.hostId ?? 'local') !== 'local'
      || value.nativeStream.threadId !== value.threadId || value.nativeStream.turnId !== value.turnId)) return
    const session = this.session(value.hostId ?? 'local', value.threadId)
    if (value.sessionUsage) session.usage = value.sessionUsage
    if (value.sessionCost) session.cost = value.sessionCost
    if (value.nativeStream !== undefined) session.nativeStream = value.nativeStream
    const stream = value.nativeStream
    if (stream?.source === 'native-observer' && stream.threadId === value.threadId && stream.turnId === value.turnId) {
      if (!stream.limited && stream.firstFlowBasis === 'generation-trigger' && stream.generationId
        && validMs(stream.firstStreamMs) !== null && validMs(stream.firstEventAt) !== null && validMs(stream.generationStartedAt) !== null
        && Math.abs(stream.firstEventAt - stream.generationStartedAt - stream.firstStreamMs) <= 5
        && (session.nativeFirstSnapshot?.at ?? 0) <= stream.firstEventAt) {
        session.nativeFirstSnapshot = { ms: stream.firstStreamMs, at: stream.firstEventAt, generationId: stream.generationId, basis: stream.firstFlowBasis }
      }
      if (stream.toolTPS != null) session.nativeSpeedSnapshot = { ...stream }
      if (stream.kind === 'compaction' && stream.totalAverageTPS != null) session.nativeSpeedSnapshot = { ...stream }
    }
    const compaction = session.compaction
    if (compaction?.startedEpoch && compaction.firstStreamMs == null) {
      const first = value.nativeCompactionEvents?.filter(e => e.turnId === compaction.turnId && e.firstEventAt >= compaction.startedEpoch
        && (compaction.status === 'running' || e.firstEventAt <= compaction.completedEpoch)).sort((a, b) => a.firstEventAt - b.firstEventAt)[0]
      if (first) compaction.firstStreamMs = first.firstEventAt - compaction.startedEpoch
    }
    const compact = value.previousCompaction
    if (compact?.responseId) {
      const observed = session.compaction
      if (!observed) session.compaction = { ...compact, status: 'completed', elapsedMs: null, startedAt: null }
      else if (observed.responseId === compact.responseId || observed.turnId === compact.turnId && compact.completedAt >= observed.startedEpoch) {
        observed.outputTokens = compact.outputTokens; observed.responseId = compact.responseId
      } else if (observed.startedAt === null && compact.completedAt > (observed.completedAt ?? 0)) session.compaction = { ...compact, status: 'completed', elapsedMs: null, startedAt: null }
    }
    // Historical TTFT ends on effective content, so it cannot fill the first-flow field.
    const response = value.previousResponse
    const latestTurnId = this.lastTurns.get(`${value.hostId ?? 'local'}:${value.threadId}`)
    if (response?.turnId && (!session.lastResponse || session.lastResponse.turnId === response.turnId || latestTurnId === response.turnId)) {
      const saved = this.turns.get(this.key(value.hostId ?? 'local', value.threadId, response.turnId))
      const prior = session.lastResponse?.turnId === response.turnId ? session.lastResponse : null
      session.lastResponse = {
        turnId: response.turnId,
        model: modelLabel(response.model) ?? prior?.model ?? saved?.settings?.modelLabel ?? null,
        reasoningEffort: response.reasoningEffort ?? saved?.settings?.reasoningEffort ?? prior?.reasoningEffort ?? null,
        fastMode: response.fastMode ?? saved?.settings?.fastMode ?? prior?.fastMode ?? null,
      }
    }
    const turn = this.turns.get(this.key(value.hostId ?? 'local', value.threadId, value.turnId))
    if (!turn) return
    if (value.nativeTTFT !== undefined && value.nativeTTFT !== null) turn.nativeTTFT = validMs(value.nativeTTFT)
    this.captureFirst(turn)
    if (value.model) turn.model = value.model
    if (value.reasoningEffort) { turn.settings ??= {}; turn.settings.reasoningEffort = value.reasoningEffort }
    if (typeof value.fastMode === 'boolean') { turn.settings ??= {}; turn.settings.fastMode = value.fastMode }
    if (session.lastResponse?.turnId === turn.turnId) this.freezeResponse(turn)
    if (value.usage) turn.usage = value.usage
  }

  snapshot(threadId, hostId = 'local') {
    const session = this.session(hostId, threadId)
    const id = this.lastTurns.get(`${hostId}:${threadId}`)
    const turn = this.turns.get(this.key(hostId, threadId, id))
    const first = {
      firstTokenMs: session.lastFirst?.ms ?? null,
      firstTokenSource: session.lastFirst?.source ?? null,
      firstTokenTurnId: session.lastFirst?.turnId ?? null,
      firstHeld: session.lastFirst !== null && (!turn || session.lastFirst.turnId !== turn.turnId || ['completed', 'interrupted', 'failed'].includes(turn.status)),
    }
    const recorded = {
      recordedModel: session.lastResponse?.model ?? null,
      recordedEffort: session.lastResponse?.reasoningEffort ?? null,
      recordedFastMode: session.lastResponse?.fastMode ?? null,
      recordedTurnId: session.lastResponse?.turnId ?? null,
      sessionCost: session.cost,
      lastBodyAtEpoch: session.lastBodyAtEpoch ?? 0,
      lastModelAtEpoch: session.lastModelAtEpoch ?? 0,
      bodyRateKind: session.lastRateKind ?? 'body',
      nativeStream: session.nativeStream,
      nativeFirstSnapshot: session.nativeFirstSnapshot ?? null,
      nativeSpeedSnapshot: session.nativeSpeedSnapshot ?? null,
      compaction: session.compaction ? { ...session.compaction,
        elapsedMs: session.compaction.status === 'running' ? Math.max(0, this.now() - session.compaction.startedAt) : session.compaction.elapsedMs,
        totalAverageTPS: session.compaction.elapsedMs > 0 && session.compaction.outputTokens !== null ? session.compaction.outputTokens * 1000 / session.compaction.elapsedMs : null } : null,
    }
    if (!turn) return { threadId, hostId, status: 'no-turn', ...first, ...recorded, sessionTokens: totalTokens(session.usage), averageTPS: null, displayTPS: session.lastTPS, speedHeld: session.lastTPS !== null, notifications: this.notifications }
    this.sample(turn)
    const status = session.compaction?.status === 'running' ? 'compacting' : turn.tools.size ? 'tool' : turn.status === 'streaming' && turn.liveTPS === null ? 'paused' : turn.status
    return {
      hostId, threadId, turnId: turn.turnId, model: turn.model, status,
      requestSettings: turn.settings ? { fastMode: turn.settings.fastMode ?? null } : null,
      nativeTTFT: turn.nativeTTFT, firstVisibleMs: turn.firstVisibleMs, firstStreamMs: turn.firstStreamMs,
      ...first,
      ...recorded,
      visibleTokens: turn.visibleTokens, liveTPS: turn.liveTPS, limited: turn.limited,
      displayTPS: turn.liveTPS ?? session.lastTPS,
      speedHeld: turn.liveTPS === null && session.lastTPS !== null,
      averageTPS: turn.streamMs >= 250 ? turn.streamTokens * 1000 / turn.streamMs : null,
      observedStreamMs: turn.streamMs,
      sessionTokens: totalTokens(session.usage),
      outputTokens: turn.usage?.outputTokens ?? turn.usage?.output_tokens ?? null,
      reasoningTokens: turn.usage?.reasoningOutputTokens ?? turn.usage?.reasoning_output_tokens ?? null,
      notifications: this.notifications,
    }
  }
}
