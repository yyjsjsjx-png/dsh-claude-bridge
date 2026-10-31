import { randomUUID } from 'node:crypto'
import { assistantIdentity } from './history-sync.mjs'

/** Project SDK text/thinking into DSH's existing live and durable renderers. */
export class SdkProjection {
  constructor({ agent, helpers, turn, step, model, onStarted, onUsage, onModelStart }) {
    Object.assign(this, { agent, helpers, turn, step, model, onStarted, onUsage, onModelStart })
    this.active = undefined
    this.revision = 0
    this.blocks = new Map()
    this.committedToolIds = new Set()
    this.committedToolCalls = new Map()
    this.committedText = new Set()
    this.messageId = undefined
    this.startedModelIds = new Set()
    this.modelResponses = 0
    this.streamUsage = undefined
    this.streamUsageFinal = false
  }

  emit(frame) { this.agent.dispatch.emit('agent/assistant-stream', { frame }) }

  start() {
    if (this.active) return
    this.active = {
      id: `${this.agent.id}:bridge:${randomUUID()}`,
      accumulator: new this.helpers.AssistantStreamAccumulator(),
      assembler: new this.helpers.BlockAssembler(), index: 0,
    }
    this.emit({ type: 'start', attemptId: this.active.id, revision: ++this.revision, turn: this.turn, step: this.step })
  }

  push(chunk) {
    this.start()
    const active = this.active
    const timed = active.accumulator.push({ time: Date.now(), chunk })
    active.assembler.push(timed.chunk)
    this.emit({ type: 'chunk', attemptId: active.id, revision: ++this.revision,
      index: active.index++, time: timed.time, chunk: timed.chunk })
  }

  async accept(message) {
    if (this.interrupted) {
      if (message.type === 'system' && message.subtype === 'init') await this.onStarted?.()
      if (message.type === 'result') await this.onUsage?.(message)
      return
    }
    if (message.type === 'system' && message.subtype === 'init') await this.onStarted?.()
    if (message.type === 'stream_event') {
      const event = message.event
      if (event?.type === 'message_start') {
        if (this.active) this.finish()
        this.messageId = event.message?.id
        await this.modelStart(this.messageId)
        if (this.interrupted) return
        this.streamUsage = event.message?.usage
        this.streamUsageFinal = false
      }
      if (event?.type === 'message_delta' && event.usage) {
        this.streamUsage = { ...this.streamUsage, ...event.usage }
        this.streamUsageFinal = Number.isFinite(event.usage.output_tokens)
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
      }
    }
    if (message.type === 'assistant') {
      const content = message.message?.content
      if (!Array.isArray(content)) return
      this.messageId = message.message?.id
      await this.modelStart(this.messageId)
      if (this.interrupted) return
      if (typeof message.message.model === 'string') this.model = message.message.model
      if (!this.active) {
        for (const item of content) {
          if (!['text', 'thinking', 'tool_use'].includes(item.type)) continue
          if (item.type === 'tool_use') {
            if (this.committedToolIds.has(item.id)) continue
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
        const index = this.blocks.size
        const block = { index, type: 'tool-call', id: item.id,
          name: item.name.replace(/^mcp__dsh__/, ''), arguments: JSON.stringify(item.input ?? {}), ended: true }
        this.blocks.set(`full:${randomUUID()}`, block)
        this.push({ type: 'block-start', index, blockType: 'tool-call' })
        this.push({ type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments })
        this.push({ type: 'block-end', index, block: this.finalBlock(block) })
      }
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
      // The SDK's per-message output usage is a placeholder. The authoritative
      // current-turn main-agent usage arrives on the terminal result message.
      // Tool calls must be committed before the local DSH tool pipeline runs.
      if (content.some(item => item.type === 'tool_use')) this.finish({
        usage: this.streamUsageFinal ? dshUsage({ usage: this.streamUsage }) : undefined,
      })
    }
    if (message.type === 'result') {
      this.finish({ usage: !this.active ? undefined : this.streamUsageFinal
        ? dshUsage({ usage: this.streamUsage }) : this.modelResponses <= 1 ? dshUsage(message) : undefined })
      await this.onUsage?.(message)
    }
  }

  async modelStart(id) {
    const key = id ?? 'unidentified-response'
    if (this.startedModelIds.has(key)) return
    this.startedModelIds.add(key)
    this.modelResponses++
    const step = await this.onModelStart?.(id)
    if (step !== undefined) this.step = step
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
    if (!this.active && !usage) return
    this.start()
    for (const block of this.blocks.values()) {
      if (!block.ended) this.push({ type: 'block-end', index: block.index, block: this.finalBlock(block) })
    }
    if (usage) this.push({ type: 'usage', usage })
    this.push({ type: 'finish', reason: { kind: 'stop' } })
    const active = this.active
    const content = this.finalOrder ? this.finalOrder.map(block => this.finalBlock(block)) : active.assembler.blocks()
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
      stream: [...active.accumulator.snapshot()],
      ...(interrupted ? { interrupted: true } : {}),
      ...(usage ? { usage } : {}),
    }
    const committed = this.agent.session.append('assistant/message', data, { surfaceOp: 'append' })
    this.emit({ type: 'end', attemptId: active.id, revision: ++this.revision, index: active.index,
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
