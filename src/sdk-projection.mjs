import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { assistantIdentity } from './history-sync.mjs'
import { isNoResponsePlaceholder } from './sdk-message.mjs'
import { appendHistoryRecord, HISTORY_ASSISTANT } from './history-records.mjs'
import { contextSnapshot } from './context-usage.mjs'
import { RESPONSE_USAGE_RECORD, RUN_USAGE_RECORD, responseUsageFromSdk } from './response-usage.mjs'
import { createResponseTimingTracker, RESPONSE_TIMING_RECORD } from './response-timing.mjs'
import { observeResponseTiming } from './sdk-response-timing.mjs'

// DSH followers require dense revisions across the attached Agent lifecycle,
// including a stopped query followed by a fresh projection for the next turn.
const revisions = new WeakMap()

/** Project SDK text/thinking into DSH's existing live and durable renderers. */
export class SdkProjection {
  constructor({ agent, helpers, turn, step, model, runId, timingNow, onStarted, onUsage, onProgress, onModelStart, onFirstToken, onFirstText }) {
    Object.assign(this, { agent, helpers, turn, step, model, onStarted, onUsage, onProgress, onModelStart, onFirstToken, onFirstText })
    this.runId = runId ?? `turn:${turn}:step:${step}`
    this.startStep = step
    this.timingNow = timingNow ?? (() => performance.now())
    this.responseTiming = createResponseTimingTracker({ runId: this.runId, turn, now: this.timingNow,
      onRecord: record => helpers.appendPluginRecord(agent.session, RESPONSE_TIMING_RECORD, record) })
    this.active = undefined
    this.blocks = new Map()
    this.committedToolIds = new Set()
    this.committedToolCalls = new Map()
    this.committedText = new Set()
    this.committedContent = new Map()
    this.messageId = undefined
    this.startedModelIds = new Set()
    this.modelResponses = 0
    this.streamUsage = undefined
    this.streamUsageFinal = false
    this.responses = new Map()
    this.usageReported = false
  }

  advanceStep(step) {
    this.step = step
  }

  getCommittedToolCall(id) {
    const call = this.committedToolCalls.get(id)
    return call && { ...call }
  }

  emit(frame) {
    const revision = (revisions.get(this.agent) ?? 0) + 1
    revisions.set(this.agent, revision)
    this.agent.dispatch.emit('agent/assistant-stream', { frame: { ...frame, revision } })
  }

  start() {
    if (this.active) return
    this.active = {
      id: `${this.agent.id}:bridge:${randomUUID()}`,
      accumulator: new this.helpers.AssistantStreamAccumulator(),
      assembler: new this.helpers.BlockAssembler(), index: 0,
      // Native followers retain the first committed stream until Step end.
      // More blocks of that same API response update its durable snapshot;
      // opening another live attempt would force a client rebaseline.
      silent: this.committedContent.has(this.messageId),
    }
    if (!this.active.silent) this.emit({ type: 'start', attemptId: this.active.id, turn: this.turn, step: this.step })
  }

  push(chunk) {
    const token = ['text-delta', 'reasoning-delta'].includes(chunk.type) ? chunk.text
      : chunk.type === 'tool-call-delta' ? chunk.argumentsDelta : undefined
    if (typeof token === 'string' && token.length) {
      if (!this.firstToken) { this.firstToken = true; this.onFirstToken?.(chunk.type) }
      if (chunk.type === 'text-delta' && !this.firstText) { this.firstText = true; this.onFirstText?.() }
    }
    this.start()
    const active = this.active
    const timed = active.accumulator.push({ time: Date.now(), chunk })
    active.assembler.push(timed.chunk)
    if (!active.silent) this.emit({ type: 'chunk', attemptId: active.id,
      index: active.index++, time: timed.time, chunk: timed.chunk })
  }

  async accept(message) {
    if (this.interrupted) {
      if (message.type === 'system' && message.subtype === 'init') await this.onStarted?.()
      if (message.type === 'result') await this.settleUsage(message)
      return
    }
    if (message.type === 'system' && message.subtype === 'init') await this.onStarted?.()
    if (message.type === 'system' || message.type === 'bridge_context') await this.progress(message)
    if (message.type === 'stream_event') {
      const event = message.event
      const receivedAt = this.timingNow()
      if (event?.type === 'message_start') {
        if (this.active) this.finish({ usage: this.confirmedUsage() })
        this.recordResponseUsage(this.currentResponse)
        this.messageId = event.message?.id
        await this.modelStart(this.messageId, message.parent_tool_use_id == null
          ? { at: receivedAt, streamStarted: true } : {})
        if (this.interrupted) return
        this.streamUsage = event.message?.usage
        this.streamUsageFinal = false
        this.streamResponse = this.currentResponse
        if (this.streamResponse && !this.streamResponse.final) this.streamResponse.usage = this.streamUsage
      }
      observeResponseTiming(this.responseTiming, message, this.streamResponse ?? this.currentResponse, receivedAt)
      if (event?.type === 'message_delta' && event.usage) {
        const response = this.streamResponse ?? this.currentResponse
        const previous = response?.usage ?? this.streamUsage
        this.streamUsage = { ...previous, ...event.usage }
        // API output usage is cumulative, not a token delta. Replayed/older
        // samples cannot decrease the snapshot or be added a second time.
        if (Number.isFinite(previous?.output_tokens) && Number.isFinite(this.streamUsage.output_tokens)) {
          this.streamUsage.output_tokens = Math.max(previous.output_tokens, this.streamUsage.output_tokens)
        }
        this.streamUsageFinal = Number.isFinite(event.usage.output_tokens)
        if (response) {
          response.usage = this.streamUsage
          response.final ||= this.streamUsageFinal
          // Tools are advertised before SDK callbacks run. Their final usage
          // can arrive afterward, so settle numerical metadata independently.
          if (this.committedContent.has(response.id)) this.recordResponseUsage(response)
        }
      }
      if (event?.type === 'content_block_start' && ['text', 'thinking', 'tool_use'].includes(event.content_block?.type)) {
        const type = event.content_block.type === 'thinking' ? 'reasoning'
          : event.content_block.type === 'tool_use' ? 'tool-call' : 'text'
        const index = this.blocks.size
        const block = { index, type, text: '', ...(type === 'tool-call' ? {
          id: event.content_block.id, name: event.content_block.name.replace(/^mcp__dsh__/, ''),
          arguments: '', initialInput: event.content_block.input ?? {},
        } : {}) }
        this.blocks.set(event.index, block)
        this.push({ type: 'block-start', index, blockType: type })
        if (type === 'tool-call') this.push({ type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: '' })
      } else if (event?.type === 'content_block_delta') {
        const block = this.blocks.get(event.index)
        const delta = event.delta?.type === 'text_delta' ? event.delta.text
          : event.delta?.type === 'thinking_delta' ? event.delta.thinking : undefined
        if (block?.type === 'tool-call' && event.delta?.type === 'input_json_delta') {
          block.arguments += event.delta.partial_json
          this.push({ type: 'tool-call-delta', index: block.index, id: block.id, argumentsDelta: event.delta.partial_json })
        } else if (block && typeof delta === 'string') {
          block.text += delta
          this.push({ type: `${block.type}-delta`, index: block.index, text: delta })
        }
      } else if (event?.type === 'content_block_stop') {
        const block = this.blocks.get(event.index)
        if (block) {
          this.push({ type: 'block-end', index: block.index, block: this.finalBlock(block) })
          block.ended = true
        }
      } else if (event?.type === 'message_stop') {
        if (this.active && this.streamUsageFinal
          && ![...this.blocks.values()].some(block => block.type === 'tool-call')) {
        // The complete response is durable before query-level bookkeeping or a
        // later synthetic message can arrive. Result usage is still recorded.
          this.finish({ usage: this.confirmedUsage() })
        }
        this.recordResponseUsage(this.streamResponse ?? this.currentResponse)
      }
    }
    if (message.type === 'assistant') {
      if (isNoResponsePlaceholder(message.message)) return
      const content = message.message?.content
      if (!Array.isArray(content)) return
      this.messageId = message.message?.id ?? this.messageId
      await this.modelStart(this.messageId)
      if (this.interrupted) return
      if (typeof message.message.model === 'string') this.model = message.message.model
      // Partial JSON is for display. The final SDK input is the authority for
      // execution, including escaped Unicode and other normalization details.
      // Never advertise a streamed tool before this final input is available.
      for (const item of content) {
        if (item.type !== 'tool_use' || this.committedToolIds.has(item.id)) continue
        const block = [...this.blocks.values()].find(block => block.type === 'tool-call' && block.id === item.id)
        if (!block) continue
        const name = item.name.replace(/^mcp__dsh__/, '')
        const args = JSON.stringify(item.input ?? {})
        if (block.name !== name || block.arguments !== args) {
          // Escaping and whitespace can differ without losing any raw output.
          // A missing JSON tail or changed value instead needs full-message
          // supplementation, so its receive window cannot cover all output.
          let equivalent = false
          if (block.name === name) {
            try { equivalent = isDeepStrictEqual(block.arguments ? JSON.parse(block.arguments) : block.initialInput ?? {}, item.input ?? {}) }
            catch {}
          }
          if (!equivalent) this.timingSupplement()
          block.name = name
          block.arguments = args
          this.active.canonicalToolInput = true
          this.finalOrder ??= [...this.blocks.values()]
        }
      }
      if (!this.active) {
        for (const item of content) {
          if (!['text', 'thinking', 'tool_use'].includes(item.type)) continue
          if (item.type === 'tool_use') {
            if (this.committedToolIds.has(item.id)) continue
            this.timingSupplement()
            const index = this.blocks.size
            const block = { index, type: 'tool-call', id: item.id,
              name: item.name.replace(/^mcp__dsh__/, ''), arguments: JSON.stringify(item.input ?? {}), ended: true }
            this.blocks.set(index, block)
            this.push({ type: 'block-start', index, blockType: 'tool-call' })
            this.push({ type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments })
            this.push({ type: 'block-end', index, block: this.finalBlock(block) })
            continue
          }
          const type = item.type === 'thinking' ? 'reasoning' : 'text'
          const text = item.text ?? item.thinking
          if (typeof text !== 'string' || !text) continue
          if (this.committedText.has(JSON.stringify([this.messageId, type, text]))) continue
          this.timingSupplement()
          const index = this.blocks.size
          this.blocks.set(index, { index, type, text, ended: true })
          this.push({ type: 'block-start', index, blockType: type })
          this.push({ type: `${type}-delta`, index, text })
          this.push({ type: 'block-end', index, block: { type, text } })
        }
      }
      let supplementedText = false
      for (const item of content) {
        if (!['text', 'thinking'].includes(item.type)) continue
        const type = item.type === 'thinking' ? 'reasoning' : 'text'
        const text = item.text ?? item.thinking
        if (typeof text !== 'string' || !text || this.committedText.has(JSON.stringify([this.messageId, type, text]))) continue
        const current = [...this.blocks.values()].find(block => block.type === type && text.startsWith(block.text))
        if (current) {
          if (current.text === text) continue
          const tail = text.slice(current.text.length)
          current.text = text
          if (!current.ended) this.push({ type: `${type}-delta`, index: current.index, text: tail })
          supplementedText = true
          continue
        }
        const index = this.blocks.size
        const block = { index, type, text, ended: true }
        this.blocks.set(`full:${randomUUID()}`, block)
        this.push({ type: 'block-start', index, blockType: type })
        this.push({ type: `${type}-delta`, index, text })
        this.push({ type: 'block-end', index, block: { type, text } })
        supplementedText = true
      }
      // Partial events can omit a tool block even when the authoritative full
      // assistant message contains it. Preserve text already streamed, and
      // supplement each missing call by its SDK id before local execution.
      for (const item of content) {
        if (item.type !== 'tool_use' || this.committedToolIds.has(item.id)
          || [...this.blocks.values()].some(block => block.type === 'tool-call' && block.id === item.id)) continue
        this.timingSupplement()
        const index = this.blocks.size
        const block = { index, type: 'tool-call', id: item.id,
          name: item.name.replace(/^mcp__dsh__/, ''), arguments: JSON.stringify(item.input ?? {}), ended: true }
        this.blocks.set(`full:${randomUUID()}`, block)
        this.push({ type: 'block-start', index, blockType: 'tool-call' })
        this.push({ type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments })
        this.push({ type: 'block-end', index, block: this.finalBlock(block) })
      }
      if (supplementedText) this.timingSupplement()
      if (supplementedText || this.finalOrder) {
        const blocks = [...this.blocks.values()]
        const order = this.finalOrder ? [...this.finalOrder, ...blocks.filter(block => !this.finalOrder.includes(block))] : blocks
        const preferred = content.flatMap(item => {
          const type = item.type === 'thinking' ? 'reasoning' : item.type === 'text' ? 'text' : 'tool-call'
          const block = blocks.find(block => block.type === type && (type === 'tool-call'
            ? block.id === item.id : block.text === (item.text ?? item.thinking)))
          return block ? [block] : []
        })
        const chosen = new Set(preferred)
        const first = order.findIndex(block => chosen.has(block))
        const remaining = order.filter(block => !chosen.has(block))
        remaining.splice(Math.max(0, first), 0, ...new Set(preferred))
        this.finalOrder = remaining
      }
      // Full block messages can carry placeholder usage. API stream usage and
      // query-level result accounting have distinct settlements below.
      // Tool calls must be committed before the local DSH tool pipeline runs.
      if (content.some(item => item.type === 'tool_use')) this.finish({
        usage: this.confirmedUsage(),
      })
    }
    if (message.type === 'result') {
      this.finish({ usage: this.confirmedUsage() })
      for (const response of this.responses.values()) this.recordResponseUsage(response)
      this.responseTiming.close()
      await this.settleUsage(message)
    }
  }

  async modelStart(id, timing = {}) {
    const key = id ?? 'unidentified-response'
    if (this.startedModelIds.has(key)) {
      this.currentResponse = this.responses.get(key)
      this.responseTiming.responseStarted({ responseId: id, step: this.currentResponse.step, ...timing })
      return
    }
    this.recordResponseUsage(this.currentResponse)
    if (this.currentResponse?.id) this.responseTiming.responseCompleted({ responseId: this.currentResponse.id })
    this.startedModelIds.add(key)
    this.modelResponses++
    const step = await this.onModelStart?.(id)
    if (step !== undefined) this.advanceStep(step)
    this.currentResponse = { id, turn: this.turn, step: this.step }
    this.responses.set(key, this.currentResponse)
    this.responseTiming.responseStarted({ responseId: id, step: this.step, ...timing })
  }

  confirmedUsage() {
    const response = this.currentResponse
    const usage = response?.final && responseUsageFromSdk(response.usage)
    if (!usage) return undefined
    return { inputTokens: usage.uncachedInputTokens, outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens }
  }

  timingSupplement() {
    if (this.currentResponse?.id) this.responseTiming.failCapture({
      responseId: this.currentResponse.id, reason: 'assistant-supplement' })
  }

  recordResponseUsage(response) {
    if (!response?.final || typeof response.id !== 'string' || !response.id || response.id.length > 256) return
    const usage = responseUsageFromSdk(response.usage)
    if (!usage) return
    this.responseTiming.responseUsage({ responseId: response.id, outputTokens: usage.outputTokens, final: true })
    const signature = JSON.stringify(usage)
    if (signature === response.recorded) return
    this.helpers.appendPluginRecord(this.agent.session, RESPONSE_USAGE_RECORD, { version: 1,
      runId: this.runId, responseId: response.id, turn: response.turn, step: response.step,
      source: 'sdk-stream', usage })
    response.recorded = signature
  }

  async settleUsage(message) {
    const usage = responseUsageFromSdk(message.usage)
    const signature = usage && JSON.stringify(usage)
    if (signature && signature !== this.runUsageRecorded) {
      this.helpers.appendPluginRecord(this.agent.session, RUN_USAGE_RECORD, { version: 1,
        runId: this.runId, turn: this.turn, startStep: this.startStep, endStep: this.step,
        source: 'sdk-result-main-agent', usage })
      this.runUsageRecorded = signature
    }
    if (!this.usageReported) { this.usageReported = true; await this.onUsage?.(message) }
  }

  async progress(message) {
    if (typeof this.onProgress !== 'function') return
    const count = n => Number.isSafeInteger(n) && n >= 0
    if (message.type === 'system' && message.subtype === 'status'
      && (message.status === 'compacting' || message.status === null)) {
      await this.onProgress({ type: 'status', status: message.status })
    } else if (message.type === 'system' && message.subtype === 'compact_boundary') {
      const metadata = message.compact_metadata
      const event = { type: 'compact-boundary', trigger: ['auto', 'manual'].includes(metadata?.trigger) ? metadata.trigger : 'unknown' }
      for (const [key, input] of [['preTokens', 'pre_tokens'], ['postTokens', 'post_tokens'], ['durationMs', 'duration_ms']]) {
        if (count(metadata?.[input])) event[key] = metadata[input]
      }
      await this.onProgress(event)
    } else if (message.type === 'bridge_context') {
      const observedAt = count(message.observedAt) ? message.observedAt : Date.now()
      const snapshot = contextSnapshot(message.context, observedAt)
      const event = { type: 'context', context: snapshot.status === 'known'
        ? { ...snapshot, source: 'sdk-summary-approximate' } : { status: 'unknown' }, observedAt }
      if (['CONTEXT_SUMMARY_TIMEOUT', 'CONTEXT_SUMMARY_UNAVAILABLE'].includes(message.code)) event.code = message.code
      await this.onProgress(event)
    }
  }

  interrupt() {
    this.interrupted = true
    this.finish({ interrupted: true })
  }

  finalBlock(block) {
    return block.type === 'tool-call' ? { type: 'tool-call', id: block.id, name: block.name,
      arguments: block.arguments || JSON.stringify(block.initialInput ?? {}) }
      : { type: block.type, text: block.text }
  }

  finish({ interrupted = false, usage } = {}) {
    if (interrupted) this.responseTiming.interrupt()
    // Usage-only results must never settle a second empty assistant message.
    if (!this.active) return
    for (const block of this.blocks.values()) {
      if (!block.ended) this.push({ type: 'block-end', index: block.index, block: this.finalBlock(block) })
    }
    if (usage) this.push({ type: 'usage', usage })
    this.push({ type: 'finish', reason: { kind: 'stop' } })
    const active = this.active
    const fresh = this.finalOrder ? this.finalOrder.map(block => this.finalBlock(block)) : active.assembler.blocks()
    const previousContent = this.committedContent.get(this.messageId)
    const content = [...(previousContent ?? [])]
    const journalContent = fresh.filter(block => block.type === 'tool-call'
      ? !this.committedToolIds.has(block.id)
      : !this.committedText.has(JSON.stringify([this.messageId, block.type, block.text])))
    for (const block of fresh) {
      const previous = content.findIndex(old => old.type === block.type && (block.type === 'tool-call'
        ? old.id === block.id : block.text.startsWith(old.text)))
      if (previous < 0) content.push(block)
      else content[previous] = block
    }
    if (this.messageId) this.committedContent.set(this.messageId, content)
    for (const block of content) {
      if (block.type === 'tool-call') {
        this.committedToolIds.add(block.id)
        this.committedToolCalls.set(block.id, { name: block.name, arguments: block.arguments })
      }
      else if (['text', 'reasoning'].includes(block.type)) this.committedText.add(JSON.stringify([this.messageId, block.type, block.text]))
    }
    const data = {
      turn: this.turn, step: this.step,
      message: { ...this.helpers.createAssistantMessage({ content,
        source: { provider: 'claude-sdk-remote', model: this.model } }),
        ...(this.messageId ? { id: assistantIdentity(this.messageId, content) } : {}) },
      stream: active.canonicalToolInput ? [] : [...active.accumulator.snapshot()],
      ...(interrupted ? { interrupted: true } : {}),
      ...(usage ? { usage } : {}),
    }
    // Native messages advertise each tool exactly once. The cumulative view is
    // an ignorable plugin record, so replay cannot reopen completed tool calls.
    let committed
    if (!previousContent || journalContent.length) {
      committed = this.agent.session.append('assistant/message', { ...data,
        ...(previousContent ? { message: { ...data.message, content: journalContent }, stream: [] } : {}),
      }, { surfaceOp: 'append' })
    }
    if (previousContent) appendHistoryRecord(this.agent.session, HISTORY_ASSISTANT, data, this.helpers)
    this.recordResponseUsage(this.currentResponse)
    if (!active.silent) this.emit({ type: 'end', attemptId: active.id, index: active.index,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: committed.seq } })
    this.active = undefined
    this.blocks.clear()
    this.finalOrder = undefined
  }
}

/** SDK main-agent usage is per result; DSH keeps cache counts disjoint. */
export function dshUsage(result) {
  const usage = result?.usage
  if (!usage || typeof usage !== 'object') return undefined
  const read = name => Number.isFinite(usage[name]) && usage[name] >= 0 ? usage[name] : 0
  return {
    inputTokens: read('input_tokens'), outputTokens: read('output_tokens'),
    cacheReadTokens: read('cache_read_input_tokens'), cacheWriteTokens: read('cache_creation_input_tokens'),
  }
}
