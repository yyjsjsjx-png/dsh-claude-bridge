import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RUN_STATES = new Set(['prepared', 'sent', 'completed', 'cancelled', 'failed', 'unknown', 'not-sent'])
const FINAL_RUN_STATES = new Set(['completed', 'cancelled', 'failed', 'not-sent'])
const TOOL_STATES = new Set(['prepared', 'dispatched', 'completed', 'unknown', 'not-sent'])
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
  && !['__proto__', 'constructor', 'prototype'].includes(value)
const position = value => Number.isSafeInteger(value) && value >= 0
const needsReview = run => !run.acknowledgedAt && (!FINAL_RUN_STATES.has(run.status) || run.requiresReview === true)
function journalError(code, message) { return Object.assign(new Error(message), { code }) }
function runOf(state, sessionId, runId) {
  const runs = state.sessions[sessionId]?.runs
  if (!runs || !Object.hasOwn(runs, runId)) throw journalError('RUN_RECORD_MISSING', '缺少持久运行记录，已停止执行。')
  return runs[runId]
}

/** Device-local bindings. Conversation text stays in the DSH event store. */
export class BridgeState {
  constructor(directory) {
    if (!directory) throw new TypeError('缺少桥接状态目录')
    this.directory = directory
    this.file = join(directory, 'state.json')
    this.queue = Promise.resolve()
    this.ready = this.load()
  }

  async load() {
    await mkdir(this.directory, { recursive: true })
    try {
      this.value = JSON.parse(await readFile(this.file, 'utf8'))
      if (this.value.version !== 1 || !UUID.test(this.value.deviceId)
        || !this.value.sessions || Array.isArray(this.value.sessions)) throw new Error('状态格式不兼容')
      for (const session of Object.values(this.value.sessions)) {
        if (!session || typeof session !== 'object' || !UUID.test(session.sdkSessionId)
          || typeof session.projectPath !== 'string' || !session.projectPath
          || typeof session.started !== 'boolean') throw new Error('会话绑定无效')
        if (session.historyCursor !== undefined && (!session.historyCursor
          || !position(session.historyCursor.offset) || session.historyCursor.offset > 100_000
          || (session.historyCursor.offset > 0 && !safeId(session.historyCursor.lastUuid))
          || (session.historyCursor.offset === 0 && session.historyCursor.lastUuid !== null))) throw new Error('恢复游标无效')
        if (session.lastRecoveryNoticeKey !== undefined && !/^[a-f0-9]{64}$/.test(session.lastRecoveryNoticeKey)) throw new Error('恢复说明标识无效')
        if (session.runs === undefined) continue
        if (!session.runs || typeof session.runs !== 'object' || Array.isArray(session.runs)) throw new Error('运行记录无效')
        for (const [runId, run] of Object.entries(session.runs)) {
          if (!safeId(runId) || !RUN_STATES.has(run.status) || !['query', 'compact'].includes(run.kind)
            || !run.tools || typeof run.tools !== 'object' || Array.isArray(run.tools)
            || typeof run.requiresReview !== 'boolean'
            || ['acknowledgedAt', 'reconciledAt', 'turn', 'step'].some(key => run[key] !== undefined && !position(run[key]))) throw new Error('运行记录无效')
          for (const [callId, tool] of Object.entries(run.tools)) {
            if (!safeId(callId) || !safeId(tool.name) || !TOOL_STATES.has(tool.status)
              || !/^[0-9a-f]{64}$/.test(tool.signature)
              || ['callSeq', 'resultSeq'].some(key => tool[key] !== undefined && !position(tool[key]))) throw new Error('工具记录无效')
          }
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const failure = new Error('桥接状态损坏或无法读取；为避免串会话，未创建替代状态。')
        failure.code = 'LOCAL_STATE_UNAVAILABLE'
        throw failure
      }
      this.value = { version: 1, deviceId: randomUUID(), sessions: {} }
      await this.save()
    }
  }

  async save() {
    const temporary = join(this.directory, `state.${randomUUID()}.tmp`)
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(this.value, null, 2) + '\n'); await file.sync() }
    finally { await file.close() }
    await rename(temporary, this.file)
  }

  async update(action) {
    await this.ready
    const operation = this.queue.then(async () => {
      const previous = this.value
      this.value = structuredClone(previous)
      try { const result = action(this.value); await this.save(); return result }
      catch (error) { this.value = previous; throw error }
    })
    this.queue = operation.catch(() => {})
    return operation
  }

  async binding(dshSessionId, projectPath) {
    if (typeof dshSessionId !== 'string' || !dshSessionId || typeof projectPath !== 'string' || !projectPath) {
      throw new TypeError('会话标识或项目路径无效')
    }
    return this.update(state => {
      if (!Object.hasOwn(state.sessions, dshSessionId)) {
        state.sessions[dshSessionId] = {
          sdkSessionId: randomUUID(), projectPath, started: false,
          createdAt: new Date().toISOString(), usage: {},
        }
      }
      const binding = state.sessions[dshSessionId]
      if (!UUID.test(binding.sdkSessionId) || binding.projectPath !== projectPath) {
        const error = new Error('会话与本机项目的绑定不一致，已停止连接。')
        error.code = 'SESSION_BINDING_MISMATCH'
        throw error
      }
      return { ...structuredClone(binding), deviceId: state.deviceId, dshSessionId }
    })
  }

  async markStarted(dshSessionId) {
    return this.update(state => {
      if (!Object.hasOwn(state.sessions, dshSessionId)) throw new Error('缺少会话绑定')
      state.sessions[dshSessionId].started = true
    })
  }

  async recordUsage(dshSessionId, runId, report) {
    return this.update(state => {
      const session = state.sessions[dshSessionId]
      if (!session) throw new Error('缺少会话绑定')
      // One terminal report per run. Replayed notifications never add usage twice.
      if (Object.hasOwn(session.usage, runId)) return false
      session.usage[runId] = structuredClone(report)
      return true
    })
  }

  /** Metadata only: arguments and tool bodies remain in DSH's private log. */
  async beginRun(sessionId, runId, kind = 'query', position = {}) {
    if (!safeId(runId) || !['query', 'compact'].includes(kind)) throw new TypeError('运行记录参数无效')
    return this.update(state => {
      const session = state.sessions[sessionId]
      if (!session) throw new Error('缺少会话绑定')
      const runs = session.runs ??= {}
      if (Object.hasOwn(runs, runId)) throw journalError('RUN_ALREADY_RECORDED', '运行已登记，不能自动重发。')
      if (Object.values(runs).some(run => needsReview(run) && !run.reconciledAt)) {
        throw journalError('RECOVERY_REQUIRED', '上一轮执行结果待核实。请先使用 /bridge-recovery 查看；核实后用 /bridge-recovery confirm 允许后续对话。')
      }
      if (Object.values(runs).filter(needsReview).length >= 64) {
        throw journalError('RECOVERY_JOURNAL_FULL', '待核实运行已达保存上限，请先核实已有结果。')
      }
      const now = Date.now()
      runs[runId] = { kind, status: 'prepared', requiresReview: false, createdAt: now, updatedAt: now, tools: {} }
      if (Number.isSafeInteger(position.turn) && Number.isSafeInteger(position.step)) {
        runs[runId].turn = position.turn; runs[runId].step = position.step
      }
      const removable = Object.entries(runs).filter(([id, run]) => id !== runId && !needsReview(run))
      while (Object.keys(runs).length > 64 && removable.length) delete runs[removable.shift()[0]]
    })
  }

  async markRunSent(sessionId, runId) {
    return this.update(state => {
      const run = runOf(state, sessionId, runId)
      if (run.status !== 'prepared' || run.stopRequestedAt) throw journalError('RUN_NOT_SENDABLE', '运行已停止或发送状态不明确，未重发。')
      run.status = 'sent'; run.updatedAt = Date.now()
    })
  }

  async requestStop(sessionId, runId) {
    return this.update(state => {
      const run = runOf(state, sessionId, runId)
      run.stopRequestedAt ??= Date.now()
      run.updatedAt = Date.now()
    })
  }

  async finishRun(sessionId, runId, status, requiresReview = false) {
    if (!RUN_STATES.has(status) || ['prepared', 'sent'].includes(status)) throw new TypeError('运行终态无效')
    return this.update(state => {
      const run = runOf(state, sessionId, runId)
      run.status = status
      run.requiresReview = requiresReview || status === 'unknown'
        || Object.values(run.tools).some(tool => ['dispatched', 'unknown'].includes(tool.status))
      run.updatedAt = Date.now()
    })
  }

  async beginTool(sessionId, runId, callId, name, signature) {
    if (!safeId(callId) || !safeId(name) || !/^[0-9a-f]{64}$/.test(signature)) throw new TypeError('工具记录参数无效')
    return this.update(state => {
      const run = runOf(state, sessionId, runId)
      if (run.status !== 'sent' || run.stopRequestedAt) throw journalError('RUN_STOPPED', '运行已停止，不再派发新工具。')
      if (Object.hasOwn(run.tools, callId)) throw journalError('TOOL_ALREADY_RECORDED', '工具已登记，不能在结果未知时自动重跑。')
      if (Object.keys(run.tools).length >= 4096) throw journalError('TOOL_JOURNAL_FULL', '本轮工具记录已满，已停止派发。')
      run.tools[callId] = { name, signature, status: 'prepared', updatedAt: Date.now() }
      run.updatedAt = Date.now()
    })
  }

  async markToolDispatched(sessionId, runId, callId, callSeq) {
    return this.update(state => {
      const run = runOf(state, sessionId, runId)
      const tool = run.tools[callId]
      if (run.stopRequestedAt || run.status !== 'sent' || tool?.status !== 'prepared') {
        throw journalError('RUN_STOPPED', '运行已停止，不再派发新工具。')
      }
      if (!Number.isSafeInteger(callSeq) || callSeq < 0) throw new TypeError('工具事件序号无效')
      tool.status = 'dispatched'; tool.callSeq = callSeq; tool.updatedAt = Date.now()
      run.updatedAt = Date.now()
    })
  }

  async finishTool(sessionId, runId, callId, status, resultSeq) {
    if (!['completed', 'unknown', 'not-sent'].includes(status)) throw new TypeError('工具终态无效')
    return this.update(state => {
      const run = runOf(state, sessionId, runId)
      const tool = run.tools[callId]
      if (!tool) throw journalError('TOOL_RECORD_MISSING', '缺少工具记录')
      tool.status = status; tool.updatedAt = Date.now()
      if (resultSeq !== undefined) {
        if (!Number.isSafeInteger(resultSeq) || resultSeq < 0) throw new TypeError('结果事件序号无效')
        tool.resultSeq = resultSeq
      }
      if (status === 'unknown') run.requiresReview = true
      run.updatedAt = Date.now()
    })
  }

  async recoveryStatus(sessionId) {
    await this.ready; await this.queue
    return Object.entries(this.value.sessions[sessionId]?.runs ?? {})
      .filter(([, run]) => needsReview(run)).map(([runId, run]) => ({ runId, ...structuredClone(run) }))
  }

  async acknowledgeRecovery(sessionId) {
    return this.update(state => {
      let count = 0
      for (const run of Object.values(state.sessions[sessionId]?.runs ?? {})) if (needsReview(run)) {
        run.acknowledgedAt = Date.now(); count++
      }
      return count
    })
  }

  async reconcileRecovery(sessionId, updates, cursor) {
    if (!Array.isArray(updates) || (cursor && (!position(cursor.offset) || cursor.offset > 100_000
      || (cursor.offset > 0 ? !safeId(cursor.lastUuid) : cursor.lastUuid !== null)))) throw new TypeError('恢复记录参数无效')
    return this.update(state => {
      for (const update of updates) {
        const run = runOf(state, sessionId, update.runId)
        run.originalStatus ??= run.status
        if (['completed', 'cancelled', 'failed', 'not-sent'].includes(update.status)) run.status = update.status
        else if (!FINAL_RUN_STATES.has(run.status)) run.status = 'unknown'
        for (const [callId, found] of Object.entries(update.tools ?? {})) {
          const tool = run.tools[callId]
          if (!tool || !['completed', 'unknown', 'not-sent'].includes(found.status)) throw journalError('RECOVERY_METADATA_INVALID', '核实结果与原工具不一致。')
          tool.status = found.status
          if (found.resultSeq !== undefined) {
            if (!Number.isSafeInteger(found.resultSeq) || found.resultSeq < 0) throw new TypeError('核实结果序号无效')
            tool.resultSeq = found.resultSeq
          }
          tool.updatedAt = Date.now()
        }
        run.requiresReview = Object.values(run.tools).some(tool => ['dispatched', 'unknown'].includes(tool.status))
        run.reconciledAt = Date.now(); run.updatedAt = run.reconciledAt
      }
      if (cursor) state.sessions[sessionId].historyCursor = structuredClone(cursor)
    })
  }

  async previousTool(sessionId, callId) {
    await this.ready; await this.queue
    for (const [runId, run] of Object.entries(this.value.sessions[sessionId]?.runs ?? {})) {
      if (Object.hasOwn(run.tools, callId)) return { runId, ...structuredClone(run.tools[callId]) }
    }
  }

  async markRecoveryNotice(sessionId, key) {
    if (key !== null && !/^[a-f0-9]{64}$/.test(key)) throw new TypeError('恢复说明标识无效')
    return this.update(state => {
      const session = state.sessions[sessionId]
      if (!session) throw new Error('缺少会话绑定')
      if (key === null) delete session.lastRecoveryNoticeKey
      else session.lastRecoveryNoticeKey = key
    })
  }

  async flush() { await this.ready; await this.queue }
}
