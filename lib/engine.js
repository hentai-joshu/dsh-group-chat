/**
 * dsh-group-chat —— 群聊引擎（host 侧，纯逻辑，不依赖 DSH 运行时）
 *
 * 一个「房间」= 群名 + 话题 + 2~6 个会话成员。引擎只做三件事：
 *   1. 轮转：当前发言人回复结束后，把下一位叫起来；
 *   2. 转述：每次叫人都带上最近的群聊记录，让每个会话都像在群里；
 *   3. 闸门：轮数、停止词、暂停、人工插话、@ 点名。
 *
 * 会话事件由 index.js 转发进来；真正投递由注入的 prompt() 完成，
 * 这样引擎可以在没有 DSH 的环境里用假 prompt 做单元测试。
 */

const DEFAULT_MAX_TURNS = 12
const HARD_MAX_TURNS = 40
const MAX_MEMBERS = 6
const MAX_MESSAGES = 400
const MAX_TEXT = 6000
const MAX_TRANSCRIPT_MESSAGES = 6
const MAX_TRANSCRIPT_CHARS = 1600
const MAX_LINE_CHARS = 260
const STOP_MARKERS = ['[讨论结束]', '【讨论结束】', '（讨论结束）', '/结束']

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0))
const clean = (value, max = MAX_TEXT) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max)

/**
 * 轮数上限：0 = 不限制（只能手动暂停/结束/停止词收口）。
 * 省略或非法值仍落到默认 12，避免误传空值变成无限。
 */
function normalizeMaxTurns(value) {
  if (value === null || value === 0 || value === '0') return 0
  const turns = Number(value)
  if (!Number.isFinite(turns) || turns <= 0) return DEFAULT_MAX_TURNS
  return clamp(turns, 2, HARD_MAX_TURNS)
}

/** 发言方式：auto = 发言者自己选下一位；round = 按成员顺序轮流。 */
function normalizeRouting(value) {
  return value === 'round' ? 'round' : 'auto'
}

/**
 * 把 [{sessionId,title,alias,cwd}] 规整成成员名册：去重、去空、别名唯一、颜色轮转。
 * create 和 updateMembers 共用，保证两处行为一致。
 */
function buildRoster(input) {
  const list = Array.isArray(input) ? input : []
  const seen = new Set()
  const aliases = new Set()
  const roster = []
  for (const raw of list) {
    const sessionId = clean(raw?.sessionId, 200)
    if (!sessionId || seen.has(sessionId)) continue
    seen.add(sessionId)
    let alias = clean(raw?.alias || raw?.title || `会话 ${roster.length + 1}`, 60) || `会话 ${roster.length + 1}`
    let suffix = 2
    while (aliases.has(alias)) alias = `${alias.replace(/\s*\(\d+\)$/, '')} (${suffix++})`
    aliases.add(alias)
    roster.push({ sessionId, alias, title: clean(raw?.title, 200), cwd: clean(raw?.cwd, 300), color: roster.length % 6 })
  }
  return roster
}

/**
 * 从回复里取出路由指令并把它从展示内容中移除。
 * 支持 [[next: 别名]] / [[all]] / [[end]]，模型偶尔会写在正文中间，也一并处理。
 */
export function parseDirective(text) {
  const raw = String(text ?? '')
  const next = raw.match(/\[\[\s*next\s*:\s*([^\]\n]+?)\s*\]\]/i)
  const all = /\[\[\s*all\s*\]\]/i.test(raw)
  const end = /\[\[\s*end\s*\]\]/i.test(raw)
  let kind = null
  let alias = null
  if (next) {
    kind = 'next'
    alias = next[1].trim()
  } else if (all) {
    kind = 'all'
  } else if (end) {
    kind = 'end'
  }
  const cleaned = raw
    .replace(/\[\[\s*(?:next\s*:\s*[^\]\n]+|all|end)\s*\]\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { kind, alias, text: cleaned }
}

function memberLabel(member) {
  const cwd = String(member?.cwd ?? '').replace(/[\\/]+$/, '')
  const base = cwd ? cwd.split(/[\\/]/).pop() : ''
  return base && base !== member?.alias ? `${member.alias}（${base}）` : member?.alias
}

function defaultId() {
  return Math.random().toString(36).slice(2, 10)
}

function textOfMessage(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

export class GroupChatEngine {
  /**
   * @param {object} options
   * @param {(sessionId: string, text: string, requestId: string) => Promise<unknown>} options.prompt
   * @param {() => number} [options.now]
   * @param {() => string} [options.newId]
   * @param {(snapshot: object) => void} [options.persist]
   * @param {(message: string) => void} [options.log]
   */
  constructor({ prompt, now = Date.now, newId = defaultId, persist = () => {}, log = () => {} } = {}) {
    if (typeof prompt !== 'function') throw new Error('GroupChatEngine requires a prompt function')
    this.prompt = prompt
    this.now = now
    this.newId = newId
    this.persist = persist
    this.log = log
    this.rooms = new Map()
    this.assistant = new Map()
    this.lastRpc = new Map()
    this.disposed = false
    this.counter = 0
  }

  // ── 房间生命周期 ──────────────────────────────────────────────────────────

  list() {
    return [...this.rooms.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((room) => this.summary(room))
  }

  get(id) {
    return this.rooms.get(id) ?? null
  }

  create({ title, topic, members, maxTurns, routing } = {}) {
    const input = Array.isArray(members) ? members : []
    if (input.length < 2) throw new Error('至少选择两个对话作为成员')
    if (input.length > MAX_MEMBERS) throw new Error(`最多 ${MAX_MEMBERS} 个成员`)

    const roster = buildRoster(input)
    if (roster.length < 2) throw new Error('至少选择两个有效对话作为成员')

    const id = `room-${this.newId()}`
    const room = {
      id,
      title: clean(title, 80) || '未命名群聊',
      topic: clean(topic, 500) || '自由讨论',
      members: roster,
      status: 'idle',
      turn: 0,
      nextIndex: 0,
      current: null,
      maxTurns: normalizeMaxTurns(maxTurns),
      routing: normalizeRouting(routing),
      broadcastQueue: [],
      batch: null,
      messages: [],
      pending: null,
      pendingUser: null,
      error: null,
      createdAt: this.now(),
      updatedAt: this.now(),
    }
    this.rooms.set(id, room)
    this.persist(this.toJSON())
    return this.roomView(room)
  }

  /**
   * 调整已有房间的成员（增/删/换），至少保留两个。
   * 若正在讨论且被移除的正是当前发言人，则暂停等待用户点「继续」；
   * 其他情况保留状态，并清空全员广播队列以免下标错位。
   */
  updateMembers(id, input) {
    const room = this.require(id)
    const roster = buildRoster(input)
    if (roster.length < 2) throw new Error('至少保留两个成员')
    if (roster.length > MAX_MEMBERS) throw new Error(`最多 ${MAX_MEMBERS} 个成员`)

    // 保留老成员的颜色，让气泡颜色稳定
    const colorById = new Map((room.members ?? []).map((member) => [member.sessionId, member.color]))
    for (const member of roster) {
      if (colorById.has(member.sessionId)) member.color = colorById.get(member.sessionId)
    }

    const ids = new Set(roster.map((member) => member.sessionId))
    const pendingStillThere = room.pending
      ? ids.has(room.pending.sessionId)
      : room.batch
        ? room.batch.entries.every((entry) => ids.has(entry.sessionId))
        : false
    const wasRunning = room.status === 'running'

    room.members = roster
    room.broadcastQueue = []
    room.nextIndex = roster.length === 0 ? 0 : (room.nextIndex ?? 0) % roster.length

    if (wasRunning && !pendingStillThere) {
      room.batch = null
      room.pending = null
      room.current = null
      room.status = 'paused'
      this.system(room, '群成员已更新；当前发言人已被移除，讨论已暂停，点「继续」恢复。')
    } else {
      this.system(room, '群成员已更新。')
    }

    room.updatedAt = this.now()
    this.persist(this.toJSON())
    return this.roomView(room)
  }

  start(id) {
    const room = this.require(id)
    if (room.members.length < 2) throw new Error('至少需要两个成员')
    if (room.status === 'running') return this.roomView(room)
    room.status = 'running'
    room.error = null
    room.pending = null
    room.pendingUser = null
    room.batch = null
    room.broadcastQueue = []
    room.turn = 0
    room.nextIndex = 0
    room.current = null
    this.system(room, room.messages.length > 0 ? '讨论重新开始。' : '讨论开始。')
    this.persist(this.toJSON())
    this.speak(room, room.members[0], 'kickoff')
    return this.roomView(room)
  }

  pause(id) {
    const room = this.require(id)
    if (room.status === 'done' || room.status === 'idle') return this.roomView(room)
    room.status = 'paused'
    room.batch = null
    this.system(room, '讨论已暂停。')
    this.persist(this.toJSON())
    return this.roomView(room)
  }

  resume(id) {
    const room = this.require(id)
    if (room.status === 'running' || room.status === 'idle') return this.roomView(room)
    if (room.maxTurns > 0 && room.turn >= room.maxTurns) throw new Error('已达到轮数上限，请点「开始」开启新一轮')
    room.status = 'running'
    room.error = null
    if (room.pending) {
      this.persist(this.toJSON())
      return this.roomView(room)
    }
    this.system(room, '讨论继续。')
    if (room.pendingUser) {
      const queued = room.pendingUser
      room.pendingUser = null
      if (queued.all) {
        this.speakBroadcast(room, room.members.map((_, index) => index), { fromUser: true, userText: queued.text, excludeId: queued.excludeId })
      } else {
        const member = queued.memberIndex === null ? room.members[room.nextIndex] : room.members[queued.memberIndex]
        this.speak(room, member ?? room.members[room.nextIndex], 'user', { targeted: queued.memberIndex !== null, userText: queued.text, excludeId: queued.excludeId })
      }
    } else {
      this.speak(room, room.members[room.nextIndex] ?? room.members[0], 'turn')
    }
    this.persist(this.toJSON())
    return this.roomView(room)
  }

  /**
   * 解除轮数上限（0 = 不限制）。只影响后续自动轮转；
   * 停止词、暂停、结束按钮仍然有效，避免无人看管时无限烧 token。
   */
  setUnlimited(id) {
    const room = this.require(id)
    room.maxTurns = 0
    room.updatedAt = this.now()
    this.system(room, '已解除轮数上限；可随时暂停或结束。')
    this.persist(this.toJSON())
    return this.roomView(room)
  }

  /** 切换发言方式：auto = 发言者自己选下一位；round = 按顺序轮流。 */
  setRouting(id, routing) {
    const room = this.require(id)
    room.routing = normalizeRouting(routing)
    room.updatedAt = this.now()
    this.system(room, room.routing === 'auto' ? '发言方式已切换为：成员自己决定下一位。' : '发言方式已切换为：按顺序轮流。')
    this.persist(this.toJSON())
    return this.roomView(room)
  }

  /**
   * 清空群聊历史：删掉会随每轮转述给各会话的「成员/用户」消息，只留系统提示，
   * 并在末尾留一条说明。用于让讨论摆脱过长的旧上下文，避免模型只顾续写历史。
   */
  clearHistory(id) {
    const room = this.require(id)
    const removed = room.messages.filter((message) => message.role === 'member' || message.role === 'user').length
    room.messages = room.messages.filter((message) => message.role === 'system')
    room.updatedAt = this.now()
    this.system(room, `已清空历史消息（${removed} 条）；后续每轮只带新的发言，旧记录不再转述。`)
    this.persist(this.toJSON())
    return this.roomView(room)
  }

  stop(id) {
    const room = this.require(id)
    room.status = 'done'
    room.pending = null
    room.pendingUser = null
    room.batch = null
    room.broadcastQueue = []
    room.current = null
    this.system(room, '讨论已结束。')
    this.persist(this.toJSON())
    return this.roomView(room)
  }

  remove(id) {
    if (!this.rooms.has(id)) return false
    this.rooms.delete(id)
    this.persist(this.toJSON())
    return true
  }

  /**
   * 用户插话。空闲/结束/暂停/出错时都会把讨论拉起来；正在生成时会排队，
   * 等本轮回复结束再转给目标（或下一位）。
   */
  say(id, text) {
    const room = this.require(id)
    const content = clean(text, MAX_TEXT)
    if (!content) throw new Error('消息不能为空')
    const target = this.resolveMention(room, content)
    const all = target === 'all'
    const targetIndex = typeof target === 'number' ? target : null
    const userMsg = this.userMessage(room, content)
    const opts = { userText: content, excludeId: userMsg?.id }

    if (room.status === 'idle' || room.status === 'done' || room.status === 'error') {
      room.status = 'running'
      room.error = null
      room.turn = 0
      room.pending = null
      room.pendingUser = null
      room.batch = null
      room.broadcastQueue = []
      room.nextIndex = targetIndex === null ? 0 : (targetIndex + 1) % room.members.length
      this.system(room, all ? '用户 @所有人，全员同时回应。' : '用户发起了新的话题。')
      this.persist(this.toJSON())
      if (all) this.speakBroadcast(room, room.members.map((_, index) => index), { fromUser: true, ...opts })
      else this.speak(room, room.members[targetIndex ?? 0], 'user', { targeted: targetIndex !== null, ...opts })
      return this.roomView(room)
    }

    if (room.status === 'paused') {
      room.status = 'running'
      room.error = null
      if (room.pending || room.batch) {
        room.pendingUser = { text: content, memberIndex: targetIndex, all, excludeId: opts.excludeId }
        room.broadcastQueue = []
        this.persist(this.toJSON())
        return this.roomView(room)
      }
      room.broadcastQueue = []
      this.persist(this.toJSON())
      if (all) this.speakBroadcast(room, room.members.map((_, index) => index), { fromUser: true, ...opts })
      else this.speak(room, room.members[targetIndex ?? room.nextIndex] ?? room.members[0], 'user', { targeted: targetIndex !== null, ...opts })
      return this.roomView(room)
    }

    // running：正在生成（单轮或全员并行批次）时插话先入群，等这一轮结束再处理。
    if (room.pending || room.batch) {
      room.pendingUser = { text: content, memberIndex: targetIndex, all, excludeId: opts.excludeId }
      room.broadcastQueue = []
    } else {
      room.broadcastQueue = []
      if (all) this.speakBroadcast(room, room.members.map((_, index) => index), { fromUser: true, ...opts })
      else this.speak(room, room.members[targetIndex ?? room.nextIndex] ?? room.members[0], 'user', { targeted: targetIndex !== null, ...opts })
    }
    this.persist(this.toJSON())
    return this.roomView(room)
  }

  // ── 会话事件 ──────────────────────────────────────────────────────────────

  handleEvent(session, event) {
    if (this.disposed || !session || !event) return
    const sessionId = session.id
    try {
      // A request reaches the inbox before compaction. Compaction may fail before
      // user/message is emitted, so correlate the accepted request at this stage too.
      if (event.type === 'agent/inbox/spliced') {
        if (event.data?.target !== 'next-turn') return
        for (const entry of event.data?.inserted ?? []) {
          const source = entry?.source
          if (source?.kind !== 'user') continue
          this.lastRpc.set(sessionId, typeof source.rpcId === 'string' ? source.rpcId : null)
        }
        return
      }
      if (event.type === 'compaction/end') {
        const room = this.roomOfPending(sessionId, this.lastRpc.get(sessionId))
        if (room?.pending && event.data?.error) {
          room.pending.failureDetail = `上下文压缩失败：${String(event.data.error).slice(0, 600)}`
        }
        return
      }
      if (event.type === 'user/message') {
        // 只认真正的人类/群聊 user 消息；runtime-context、skill-catalog、time-context
        // 这些也是 user/message，但它们会把 lastRpc 覆盖成 null，导致群聊回复被误判为“被其他输入占用”。
        const source = event.data?.source
        if (source?.kind !== 'user') return
        const rpcId = source.rpcId
        this.lastRpc.set(sessionId, typeof rpcId === 'string' ? rpcId : null)
        return
      }
      if (event.type === 'assistant/message') {
        const text = textOfMessage(event.data?.message)
        if (!text) return
        const list = this.assistant.get(sessionId) ?? []
        list.push({ seq: event.seq, turn: event.data?.turn, text, time: event.time ?? this.now() })
        while (list.length > 60) list.shift()
        this.assistant.set(sessionId, list)
        return
      }
      if (event.type === 'turn/end') this.onTurnEnd(session, event)
    } catch (error) {
      this.log(`group-chat: 处理会话事件失败：${String(error?.message ?? error)}`)
    }
  }

  onTurnEnd(session, event) {
    const rpc = this.lastRpc.get(session.id)
    const batchRoom = this.roomOfBatch(session.id)
    if (batchRoom) {
      this.onBatchTurnEnd(batchRoom, session, event, typeof rpc === 'string' ? rpc : undefined)
      return
    }
    const room = this.roomOfPending(session.id, typeof rpc === 'string' ? rpc : undefined)
    if (!room) {
      const occupied = this.roomOfPending(session.id)
      if (occupied && typeof rpc === 'string' && occupied.pending.requestId !== rpc) {
        occupied.pending = null
        occupied.current = null
        this.pauseWith(occupied, '这个会话被其他输入占用了，讨论已暂停。')
      }
      return
    }
    if (!room.pending || room.pending.sessionId !== session.id) return
    const pending = room.pending
    room.pending = null
    room.current = null

    // 注意：冷恢复的会话会先 turn/start，再追加我们的 user/message（实测 seq 7 vs 11），
    // 但这一轮确实会包含并回应群聊消息。因此不能按 seq 先后丢弃 turn/end；
    // 只靠 requestId（lastRpc）和本轮最后的 assistant/message 对齐。
    if (event.data?.reason?.kind !== 'completed') {
      const reason = event.data?.reason
      const detail = pending.failureDetail || reason?.error?.message || reason?.kind || '未知原因'
      this.pauseWith(room, `「${pending.alias}」这一轮没有正常结束（${String(detail).slice(0, 650)}），讨论已暂停。`)
      return
    }
    if (this.lastRpc.get(session.id) !== pending.requestId) {
      this.pauseWith(room, '这个会话被其他输入占用了，讨论已暂停。')
      return
    }

    const rawText = this.lastAssistantText(session.id, pending.startedAt, event.data?.turn)
    if (!rawText) {
      this.pauseWith(room, '没有拿到有效回复，讨论已暂停。')
      return
    }
    const parsed = parseDirective(rawText)
    const text = parsed.text
    if (text) this.memberMessage(room, pending, text, event.time ?? this.now())
    room.turn += 1

    if (parsed.kind === 'end' || STOP_MARKERS.some((marker) => text.includes(marker))) {
      room.status = 'done'
      room.pendingUser = null
      room.broadcastQueue = []
      this.system(room, '讨论结束（成员给出了结束标记）。')
      this.persist(this.toJSON())
      return
    }
    if (room.maxTurns > 0 && room.turn >= room.maxTurns) {
      room.status = 'done'
      room.pendingUser = null
      room.broadcastQueue = []
      this.system(room, `达到 ${room.maxTurns} 轮上限，讨论结束。`)
      this.persist(this.toJSON())
      return
    }

    const lastIndex = room.members.findIndex((member) => member.sessionId === pending.sessionId)
    room.nextIndex = (lastIndex + 1) % room.members.length

    if (room.status !== 'running') {
      this.persist(this.toJSON())
      return
    }
    if (room.pendingUser) {
      const queued = room.pendingUser
      room.pendingUser = null
      room.broadcastQueue = []
      if (queued.all) {
        this.speakBroadcast(room, room.members.map((_, index) => index), { fromUser: true, userText: queued.text, excludeId: queued.excludeId })
        return
      }
      const member = queued.memberIndex === null ? room.members[room.nextIndex] : room.members[queued.memberIndex]
      this.speak(room, member ?? room.members[room.nextIndex], 'user', { targeted: queued.memberIndex !== null, userText: queued.text, excludeId: queued.excludeId })
      return
    }

    // 发言者自己选下一位 / 选全员 / 选结束。全员回应已改为并行广播，不在这里排队。
    if (room.routing === 'auto' && !pending.broadcast) {
      if (parsed.kind === 'all') {
        const others = room.members.map((_, index) => index).filter((index) => index !== lastIndex)
        if (others.length > 0) {
          this.speakBroadcast(room, others, {})
          return
        }
      }
      if (parsed.kind === 'next') {
        const index = this.memberIndexByAlias(room, parsed.alias)
        if (index >= 0 && index !== lastIndex) {
          room.nextIndex = (index + 1) % room.members.length
          this.speak(room, room.members[index], 'turn')
          return
        }
      }
    }

    this.speak(room, room.members[room.nextIndex], 'turn')
  }

  onSessionDisposed(session) {
    for (const room of this.rooms.values()) {
      if (!room.members.some((member) => member.sessionId === session?.id)) continue
      if (room.status !== 'running' && room.status !== 'paused') continue
      room.pending = null
      room.pendingUser = null
      room.batch = null
      this.pauseWith(room, '有成员会话被关闭，讨论已暂停。')
    }
  }

  // ── 投递 ──────────────────────────────────────────────────────────────────

  /**
   * 全员回应：一次性把同一条消息并行投递给所有目标成员，
   * 全部回复到齐后本轮结束（不再自动往下轮转）。
   */
  speakBroadcast(room, indices, { fromUser = false, userText = '', excludeId = null } = {}) {
    if (this.disposed || room.status !== 'running') return false
    const queue = [...new Set(indices)].filter((index) => Number.isInteger(index) && index >= 0 && index < room.members.length)
    if (queue.length === 0) return false
    const entries = queue.map((index) => {
      const member = room.members[index]
      return {
        index,
        sessionId: member.sessionId,
        alias: member.alias,
        requestId: `gc:${room.id}:b${room.turn}:${index}:${this.newId()}`,
        turn: room.turn,
        startedAt: this.now(),
        done: false,
        text: null,
      }
    })
    room.batch = { fromUser, entries, pending: entries.length }
    room.pending = null
    room.current = null
    this.persist(this.toJSON())
    for (const entry of entries) {
      const member = room.members[entry.index]
      const text = this.envelope(room, member, 'broadcast', { fromUser, broadcast: true, userText, excludeId })
      Promise.resolve()
        .then(() => this.prompt(entry.sessionId, text, entry.requestId))
        .catch((error) => {
          const live = room.batch?.entries.find((item) => item.requestId === entry.requestId)
          if (!live || live.done) return
          room.batch = null
          room.status = 'error'
          room.error = String(error?.message ?? error).slice(0, 300)
          this.system(room, `投递失败：${room.error}`)
          this.persist(this.toJSON())
        })
    }
    return true
  }

  /** 全员并行批次里某一位结束时的处理：收齐所有人的回复后本轮结束。 */
  onBatchTurnEnd(room, session, event, rpc) {
    const batch = room.batch
    if (!batch) return
    const entry = batch.entries.find((item) => item.sessionId === session.id && !item.done)
    if (!entry) return

    if (event.data?.reason?.kind !== 'completed') {
      const reason = event.data?.reason
      const detail = reason?.error?.message || reason?.kind || '未知原因'
      room.batch = null
      this.pauseWith(room, `「${entry.alias}」这一轮没有正常结束（${String(detail).slice(0, 650)}），讨论已暂停。`)
      return
    }
    if (typeof rpc === 'string' && rpc !== entry.requestId) {
      room.batch = null
      this.pauseWith(room, '这个会话被其他输入占用了，讨论已暂停。')
      return
    }

    const rawText = this.lastAssistantText(session.id, entry.startedAt, event.data?.turn)
    if (!rawText) {
      room.batch = null
      this.pauseWith(room, '没有拿到有效回复，讨论已暂停。')
      return
    }
    const parsed = parseDirective(rawText)
    entry.done = true
    entry.text = parsed.text
    if (parsed.text) this.memberMessage(room, { sessionId: entry.sessionId, alias: entry.alias }, parsed.text, event.time ?? this.now())
    batch.pending -= 1
    if (batch.pending > 0) {
      this.persist(this.toJSON())
      return
    }

    // 所有成员都回复完毕：本轮结束，不再自动轮转。
    room.batch = null
    room.turn += 1
    room.current = null
    room.pendingUser = null
    room.status = 'done'
    this.system(room, '全员回应完成，讨论结束。')
    this.persist(this.toJSON())
  }

  speak(room, member, kind, { targeted = false, broadcast = false, fromUser = false, userText = '', excludeId = null } = {}) {
    if (this.disposed || !member || room.status !== 'running') return
    const requestId = `gc:${room.id}:${room.turn}:${this.newId()}`
    room.current = member.sessionId
    room.pending = {
      sessionId: member.sessionId,
      alias: member.alias,
      requestId,
      turn: room.turn,
      broadcast,
      fromUser,
      startedAt: this.now(),
    }
    const text = this.envelope(room, member, kind, { targeted, broadcast, fromUser, userText, excludeId })
    this.persist(this.toJSON())
    Promise.resolve()
      .then(() => this.prompt(member.sessionId, text, requestId))
      .catch((error) => {
        if (room.pending?.requestId !== requestId) return
        room.pending = null
        room.current = null
        room.status = 'error'
        room.error = String(error?.message ?? error).slice(0, 300)
        this.system(room, `投递失败：${room.error}`)
        this.persist(this.toJSON())
      })
  }

  envelope(room, member, kind, { targeted = false, broadcast = false, fromUser = false, userText = '', excludeId = null } = {}) {
    const transcript = this.transcript(room, excludeId)
    const round = room.turn + 1
    const members = room.members.map((item) => memberLabel(item)).join('、')
    const quoted = userText ? `\n「${userText}」` : ''

    // 本轮任务放最前面：历史只是背景，模型容易顺着旧内容续写而忽略当前这一轮。
    let task
    if (kind === 'kickoff') {
      task = '请围绕话题给出你的核心观点，开启讨论（3-5 句即可）。'
    } else if (kind === 'user') {
      task = targeted
        ? `用户刚在群里点名了你（${member.alias}）并说：${quoted}\n请只针对这条最新消息回应，不要跑题，也不要复述历史。`
        : `用户刚在群里说：${quoted}\n请只针对这条最新消息回应，不要跑题，也不要复述历史。`
    } else if (kind === 'broadcast' || broadcast) {
      task = fromUser
        ? `用户 @所有人，要求全员同时回应。用户说：${quoted}\n请针对这条最新消息给出你的回应。`
        : '这是全员回应轮：请针对群里最近的问题给出你的回应。'
    } else {
      task = `现在轮到你（${member.alias}）发言，请针对本轮话题继续讨论。`
    }

    const lines = [
      `【群聊「${room.title}」· 第 ${round} 轮 · 你是「${member.alias}」】`,
      '',
      '━━ 本轮要做的事（最重要，以此为准）━━',
      task,
      '',
      '如果这件事需要实际动手（改文件、跑脚本、清理归档、下载等），请直接在你的会话里做完，并汇报关键结果与证据（命令、退出码、文件、行数、SHA 等）；不要只回「收到」「我来做」「计划是」。',
      '',
      '━━ 话题与成员 ━━',
      `话题：${room.topic}`,
      `成员：${members}`,
      '',
      '━━ 最近群聊片段（只是背景，仅供参考）━━',
      transcript || '（还没有人发言）',
    ]
    if (transcript && room.messages.length > MAX_TRANSCRIPT_MESSAGES) {
      lines.push('（更早的记录已省略）')
    }
    lines.push(
      '',
      '注意：上面的片段只是背景，不要逐条复述、不要续写旧结论，也不要重复别人说过的话；一切以「本轮要做的事」为准。',
    )
    if (room.routing === 'auto' && kind !== 'broadcast' && !broadcast) {
      lines.push(
        '',
        '发言结束后另起一行，只写一条路由指令（系统会移除，不会展示）：',
        '[[next: 成员别名]] 最该接话的一位 ｜ [[all]] 需要全员回应 ｜ [[end]] 可以结束',
        '请按成员身份和最近发言判断，不要习惯性选下一位；默认只选一位。',
      )
    } else if (room.routing === 'round') {
      lines.push('', '本轮按成员顺序轮转，不需要路由指令。')
    }
    lines.push(
      '',
      '这是跨对话群聊的转述，不是你的人类用户单独对你说话。请直接输出发言正文（不加姓名前缀），简洁明确。',
      '若讨论已经得出结论，请以「[讨论结束]」开头给出结论。',
    )
    return lines.join('\n')
  }

  transcript(room, excludeId = null) {
    const recent = room.messages
      .filter((message) => message.role === 'member' || message.role === 'user')
      .filter((message) => !excludeId || message.id !== excludeId)
      .slice(-MAX_TRANSCRIPT_MESSAGES)
    if (recent.length === 0) return ''
    const lines = []
    let total = 0
    for (const message of recent) {
      const label = message.role === 'user' ? '我' : message.alias
      const flat = String(message.text ?? '').replace(/\s+/g, ' ')
      const text = flat.length > MAX_LINE_CHARS ? `${flat.slice(0, MAX_LINE_CHARS)}…` : flat
      const line = `[${label}] ${text}`
      total += line.length
      if (total > MAX_TRANSCRIPT_CHARS) break
      lines.push(line)
    }
    return lines.join('\n')
  }

  // ── 消息与状态 ────────────────────────────────────────────────────────────

  userMessage(room, text) {
    return this.push(room, { role: 'user', alias: '我', text })
  }

  memberMessage(room, pending, text, at) {
    this.push(room, { role: 'member', sessionId: pending.sessionId, alias: pending.alias, text, at })
  }

  system(room, text) {
    this.push(room, { role: 'system', text })
  }

  push(room, message) {
    this.counter += 1
    room.messages.push({
      id: `m-${this.counter}-${this.newId()}`,
      at: message.at ?? this.now(),
      ...message,
    })
    while (room.messages.length > MAX_MESSAGES) room.messages.shift()
    room.updatedAt = this.now()
    return room.messages[room.messages.length - 1]
  }

  pauseWith(room, text) {
    room.status = 'paused'
    this.system(room, text)
    this.persist(this.toJSON())
  }

  resolveMention(room, text) {
    if (/@(所有人|全体成员)/.test(text) || /@all(?![a-z0-9_])/i.test(text) || /@everyone(?![a-z0-9_])/i.test(text)) return 'all'
    let best = null
    for (let index = 0; index < room.members.length; index += 1) {
      const alias = room.members[index].alias
      const position = text.indexOf(`@${alias}`)
      if (position < 0) continue
      if (best === null || position < best.position) best = { index, position }
    }
    return best === null ? null : best.index
  }

  /** 把 [[next: 别名]] 里的别名解析成成员下标；支持去 @、大小写不敏感和包含匹配。 */
  memberIndexByAlias(room, alias) {
    const norm = (value) => String(value ?? '').trim().replace(/^@/, '').toLowerCase()
    const wanted = norm(alias)
    if (!wanted) return -1
    let index = room.members.findIndex((member) => norm(member.alias) === wanted)
    if (index >= 0) return index
    index = room.members.findIndex((member) => {
      const candidate = norm(member.alias)
      return candidate.includes(wanted) || wanted.includes(candidate)
    })
    return index
  }

  roomOfSession(sessionId) {
    for (const room of this.rooms.values()) {
      if (room.members.some((member) => member.sessionId === sessionId)) return room
    }
    return null
  }

  roomOfPending(sessionId, requestId) {
    for (const room of this.rooms.values()) {
      if (!room.pending || room.pending.sessionId !== sessionId) continue
      if (requestId !== undefined && room.pending.requestId !== requestId) continue
      return room
    }
    return null
  }

  /** 找 sessionId 所属、且仍有未完成条目的并行广播批次。 */
  roomOfBatch(sessionId) {
    for (const room of this.rooms.values()) {
      if (!room.batch) continue
      if (room.batch.entries.some((entry) => entry.sessionId === sessionId && !entry.done)) return room
    }
    return null
  }

  lastAssistantText(sessionId, startedAt, turn) {
    const list = this.assistant.get(sessionId) ?? []
    let found = null
    for (const item of list) {
      if (item.time < startedAt - 1000) continue
      if (turn !== undefined && item.turn !== turn) continue
      if (item.text) found = item
    }
    return found?.text ?? null
  }

  require(id) {
    const room = this.rooms.get(id)
    if (!room) throw new Error('群聊不存在')
    return room
  }

  summary(room) {
    const last = room.messages[room.messages.length - 1]
    return {
      id: room.id,
      title: room.title,
      topic: room.topic,
      status: room.status,
      turn: room.turn,
      maxTurns: room.maxTurns,
      routing: room.routing,
      members: room.members.map(({ sessionId, alias, color }) => ({ sessionId, alias, color })),
      messageCount: room.messages.length,
      last: last ? { role: last.role, alias: last.alias ?? null, text: String(last.text).slice(0, 120), at: last.at } : null,
      pending: room.pending
        ? { sessionId: room.pending.sessionId, alias: room.pending.alias }
        : room.batch
          ? (() => {
              const entry = room.batch.entries.find((item) => !item.done)
              return entry ? { sessionId: entry.sessionId, alias: entry.alias } : null
            })()
          : null,
      error: room.error,
      updatedAt: room.updatedAt,
    }
  }

  roomView(room) {
    return {
      ...this.summary(room),
      messages: room.messages.map((message) => ({ ...message })),
    }
  }

  // ── 持久化 ────────────────────────────────────────────────────────────────

  toJSON() {
    return {
      version: 1,
      rooms: [...this.rooms.values()].map((room) => ({
        ...room,
        messages: room.messages.slice(-MAX_MESSAGES),
      })),
    }
  }

  load(snapshot) {
    const rooms = Array.isArray(snapshot) ? snapshot : snapshot?.rooms
    if (!Array.isArray(rooms)) return
    for (const raw of rooms) {
      if (!raw || typeof raw.id !== 'string' || !Array.isArray(raw.members) || raw.members.length < 2) continue
      const members = raw.members
        .filter((member) => member && typeof member.sessionId === 'string')
        .map((member, index) => ({
          sessionId: member.sessionId,
          alias: clean(member.alias, 60) || `会话 ${index + 1}`,
          title: clean(member.title, 200),
          cwd: clean(member.cwd, 300),
          color: Number(member.color) || index % 6,
        }))
      if (members.length < 2) continue
      const room = {
        id: raw.id,
        title: clean(raw.title, 80) || '未命名群聊',
        topic: clean(raw.topic, 500) || '自由讨论',
        members,
        status: ['idle', 'running', 'paused', 'done', 'error'].includes(raw.status) ? raw.status : 'paused',
        turn: clamp(raw.turn, 0, HARD_MAX_TURNS),
        nextIndex: clamp(raw.nextIndex, 0, members.length - 1),
        current: null,
        maxTurns: normalizeMaxTurns(raw.maxTurns),
        routing: normalizeRouting(raw.routing),
        broadcastQueue: [],
        batch: null,
        messages: Array.isArray(raw.messages)
          ? raw.messages
              .filter((message) => message && typeof message.text === 'string')
              .map((message) => ({
                id: String(message.id ?? `m-${this.newId()}`),
                role: ['member', 'user', 'system'].includes(message.role) ? message.role : 'system',
                sessionId: typeof message.sessionId === 'string' ? message.sessionId : undefined,
                alias: typeof message.alias === 'string' ? message.alias : undefined,
                text: String(message.text).slice(0, MAX_TEXT),
                at: Number(message.at) || this.now(),
              }))
              .slice(-MAX_MESSAGES)
          : [],
        pending: null,
        pendingUser: null,
        error: typeof raw.error === 'string' ? raw.error : null,
        createdAt: Number(raw.createdAt) || this.now(),
        updatedAt: Number(raw.updatedAt) || this.now(),
      }
      if (room.status === 'running') {
        room.status = 'paused'
        this.system(room, 'DSH 重启过，讨论已暂停；点「继续」恢复。')
      }
      this.rooms.set(room.id, room)
      for (const message of room.messages) {
        const counter = Number(String(message.id).match(/^m-(\d+)/)?.[1])
        if (Number.isFinite(counter)) this.counter = Math.max(this.counter, counter)
      }
    }
  }

  dispose() {
    this.disposed = true
  }
}

export const GROUP_CHAT_LIMITS = {
  DEFAULT_MAX_TURNS,
  HARD_MAX_TURNS,
  MAX_MEMBERS,
  MAX_MESSAGES,
  MAX_TEXT,
  STOP_MARKERS,
}
