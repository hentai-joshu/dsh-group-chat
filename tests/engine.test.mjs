import test from 'node:test'
import assert from 'node:assert/strict'
import { GroupChatEngine, GROUP_CHAT_LIMITS } from '../lib/engine.js'

function harness({ maxTurns = 12, routing = 'auto' } = {}) {
  const calls = []
  let clock = 1000
  let serial = 0
  const engine = new GroupChatEngine({
    prompt: async (sessionId, text, requestId) => {
      calls.push({ sessionId, text, requestId })
      return { accepted: true }
    },
    now: () => clock,
    newId: () => `id${++serial}`,
    persist: () => {},
  })
  const room = engine.create({
    title: '测试群',
    topic: '要不要重构',
    maxTurns,
    routing,
    members: [
      { sessionId: 's1', title: '前端' },
      { sessionId: 's2', title: '后端' },
      { sessionId: 's3', title: '测试' },
    ],
  })
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  const advance = (ms = 10) => {
    clock += ms
    return clock
  }
  const session = (id) => ({ id })
  const userMessage = (id, rpcId, text = 'hello') => ({
    type: 'user/message',
    seq: ++serial,
    time: clock,
    data: { source: { kind: 'user', rpcId }, message: { role: 'user', content: [{ type: 'text', text }] } },
  })
  const assistantMessage = (turn, text, time = clock) => ({
    type: 'assistant/message',
    seq: ++serial,
    time,
    data: { turn, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  })
  const turnEnd = (turn, kind = 'completed') => ({
    type: 'turn/end',
    seq: ++serial,
    time: clock,
    data: { turn, reason: { kind } },
  })
  const turnStart = () => ({ type: 'turn/start', seq: ++serial, time: clock, data: {} })
  const contextMessage = (id) => ({
    type: 'user/message',
    seq: ++serial,
    time: clock,
    data: { source: { kind: 'runtime-context' }, message: { role: 'user', content: [{ type: 'text', text: 'ctx' }] } },
  })
  return { engine, calls, room, tick, advance, session, userMessage, assistantMessage, turnEnd, turnStart, contextMessage }
}

async function startRoom(ctx) {
  ctx.engine.start(ctx.room.id)
  await ctx.tick()
  return ctx.calls.at(-1)
}

async function reply(ctx, sessionId, turn, text) {
  const request = ctx.calls.at(-1)
  assert.equal(request.sessionId, sessionId)
  ctx.engine.handleEvent(ctx.session(sessionId), ctx.userMessage(sessionId, request.requestId, '轮到我'))
  ctx.engine.handleEvent(ctx.session(sessionId), ctx.assistantMessage(turn, text))
  ctx.engine.handleEvent(ctx.session(sessionId), ctx.turnEnd(turn))
  await ctx.tick()
}

test('create 需要至少两个成员', () => {
  const engine = new GroupChatEngine({ prompt: async () => {} })
  assert.throws(() => engine.create({ members: [{ sessionId: 's1' }] }), /至少/)
})

test('start 把第一位成员叫起来，信封里有话题和成员', async () => {
  const ctx = harness()
  await startRoom(ctx)
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.calls[0].sessionId, 's1')
  assert.match(ctx.calls[0].text, /要不要重构/)
  assert.match(ctx.calls[0].text, /前端/)
  const room = ctx.engine.get(ctx.room.id)
  assert.equal(room.status, 'running')
  assert.equal(room.pending.sessionId, 's1')
})

test('回复结束后转给下一位，并写入群聊记录', async () => {
  const ctx = harness()
  await startRoom(ctx)
  await reply(ctx, 's1', 0, '我觉得先补测试')
  assert.equal(ctx.calls.length, 2)
  assert.equal(ctx.calls[1].sessionId, 's2')
  assert.match(ctx.calls[1].text, /我觉得先补测试/)
  const room = ctx.engine.get(ctx.room.id)
  assert.equal(room.turn, 1)
  assert.equal(room.messages.at(-1).role, 'member')
  assert.equal(room.messages.at(-1).alias, '前端')
})

test('达到轮数上限后停止', async () => {
  const ctx = harness({ maxTurns: 2 })
  await startRoom(ctx)
  await reply(ctx, 's1', 0, '第一条')
  assert.equal(ctx.calls.length, 2)
  await reply(ctx, 's2', 1, '第二条')
  const room = ctx.engine.get(ctx.room.id)
  assert.equal(room.status, 'done')
  assert.equal(ctx.calls.length, 2)
})

test('maxTurns=0 表示不限制，继续轮转', async () => {
  const ctx = harness({ maxTurns: 0 })
  await startRoom(ctx)
  await reply(ctx, 's1', 0, '第一条')
  await reply(ctx, 's2', 1, '第二条')
  await reply(ctx, 's3', 2, '第三条')
  const room = ctx.engine.get(ctx.room.id)
  assert.equal(room.maxTurns, 0)
  assert.equal(room.status, 'running')
  assert.equal(room.turn, 3)
  assert.equal(ctx.calls.length, 4)
})

test('setUnlimited 解除已有上限', async () => {
  const ctx = harness({ maxTurns: 2 })
  await startRoom(ctx)
  ctx.engine.setUnlimited(ctx.room.id)
  assert.equal(ctx.engine.get(ctx.room.id).maxTurns, 0)
  await reply(ctx, 's1', 0, '第一条')
  await reply(ctx, 's2', 1, '第二条')
  await reply(ctx, 's3', 2, '第三条')
  const room = ctx.engine.get(ctx.room.id)
  assert.equal(room.status, 'running')
  assert.equal(room.turn, 3)
  assert.equal(ctx.calls.length, 4)
})

test('[讨论结束] 立即收口', async () => {
  const ctx = harness()
  await startRoom(ctx)
  await reply(ctx, 's1', 0, '[讨论结束] 结论是先生成测试')
  const room = ctx.engine.get(ctx.room.id)
  assert.equal(room.status, 'done')
  assert.equal(ctx.calls.length, 1)
})

test('@ 点名会跳过轮转，直接叫被点名的人', async () => {
  const ctx = harness()
  ctx.engine.say(ctx.room.id, '@测试 你先说')
  await ctx.tick()
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.calls[0].sessionId, 's3')
  assert.match(ctx.calls[0].text, /点名了你/)
})

test('成员可以用 [[next: 别名]] 决定下一位，指令不进入群聊记录', async () => {
  const ctx = harness()
  await startRoom(ctx)
  await reply(ctx, 's1', 0, '这段更该测试看\n[[next: 测试]]')
  assert.equal(ctx.calls.length, 2)
  assert.equal(ctx.calls[1].sessionId, 's3')
  const last = ctx.engine.get(ctx.room.id).messages.at(-1)
  assert.equal(last.text, '这段更该测试看')
})

test('[[all]] 并行广播给其他成员，全部回复后讨论结束（不再自动轮转）', async () => {
  const ctx = harness()
  await startRoom(ctx)
  await reply(ctx, 's1', 0, '大家都说说\n[[all]]')

  // 同时投递给 s2、s3（不是依次等一个说完再叫下一个）
  assert.equal(ctx.calls.length, 3)
  assert.deepEqual(ctx.calls.slice(1).map((call) => call.sessionId).sort(), ['s2', 's3'])

  const reqOf = (sid) => ctx.calls.find((call) => call.sessionId === sid).requestId
  ctx.engine.handleEvent(ctx.session('s2'), ctx.userMessage('s2', reqOf('s2')))
  ctx.engine.handleEvent(ctx.session('s2'), ctx.assistantMessage(1, '我来说一句'))
  ctx.engine.handleEvent(ctx.session('s2'), ctx.turnEnd(1))
  ctx.engine.handleEvent(ctx.session('s3'), ctx.userMessage('s3', reqOf('s3')))
  ctx.engine.handleEvent(ctx.session('s3'), ctx.assistantMessage(1, '我也说完了'))
  ctx.engine.handleEvent(ctx.session('s3'), ctx.turnEnd(1))
  await ctx.tick()

  const room = ctx.engine.get(ctx.room.id)
  assert.equal(ctx.calls.length, 3) // 收齐后不再叫下一位
  assert.equal(room.status, 'done')
  assert.match(room.messages.at(-1).text, /全员回应完成/)
})

test('用户 @所有人 会并行发给每位成员，全部回复后结束', async () => {
  const ctx = harness()
  ctx.engine.say(ctx.room.id, '@所有人 每个人都报一下自己的角色')
  await ctx.tick()

  assert.equal(ctx.calls.length, 3)
  assert.deepEqual(ctx.calls.map((call) => call.sessionId).sort(), ['s1', 's2', 's3'])
  assert.match(ctx.calls[0].text, /用户 @所有人/)

  const reqOf = (sid) => ctx.calls.find((call) => call.sessionId === sid).requestId
  for (const sid of ['s1', 's2', 's3']) {
    ctx.engine.handleEvent(ctx.session(sid), ctx.userMessage(sid, reqOf(sid)))
    ctx.engine.handleEvent(ctx.session(sid), ctx.assistantMessage(0, `我是${sid}`))
    ctx.engine.handleEvent(ctx.session(sid), ctx.turnEnd(0))
  }
  await ctx.tick()

  const room = ctx.engine.get(ctx.room.id)
  assert.equal(ctx.calls.length, 3)
  assert.equal(room.status, 'done')
})

test('[[end]] 立即收口', async () => {
  const ctx = harness()
  await startRoom(ctx)
  await reply(ctx, 's1', 0, '结论已经够了\n[[end]]')
  assert.equal(ctx.engine.get(ctx.room.id).status, 'done')
  assert.equal(ctx.calls.length, 1)
})

test('setRouting 切到 round 后忽略 [[next]]', async () => {
  const ctx = harness()
  await startRoom(ctx)
  ctx.engine.setRouting(ctx.room.id, 'round')
  await reply(ctx, 's1', 0, '按顺序来\n[[next: 测试]]')
  assert.equal(ctx.calls[1].sessionId, 's2')
})

test('正在生成时用户插话会排队，本轮结束后处理', async () => {
  const ctx = harness()
  await startRoom(ctx)
  ctx.engine.say(ctx.room.id, '先别急，补一句')
  await ctx.tick()
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.engine.get(ctx.room.id).pendingUser.text, '先别急，补一句')

  await reply(ctx, 's1', 0, '收到')
  assert.equal(ctx.calls.length, 2)
  assert.equal(ctx.calls[1].sessionId, 's2')
  assert.match(ctx.calls[1].text, /先别急，补一句/)
})

test('暂停后回复只入档，不再叫下一位；继续后再叫', async () => {
  const ctx = harness()
  await startRoom(ctx)
  ctx.engine.pause(ctx.room.id)
  await reply(ctx, 's1', 0, '暂停前说完')
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.engine.get(ctx.room.id).status, 'paused')

  ctx.engine.resume(ctx.room.id)
  await ctx.tick()
  assert.equal(ctx.calls.length, 2)
  assert.equal(ctx.calls[1].sessionId, 's2')
})

test('会话被其他输入占用时暂停，不把别人的话当成群聊回复', async () => {
  const ctx = harness()
  await startRoom(ctx)
  ctx.engine.handleEvent(ctx.session('s1'), ctx.userMessage('s1', 'human-rpc', '我自己说一句'))
  ctx.engine.handleEvent(ctx.session('s1'), ctx.assistantMessage(0, '回用户'))
  ctx.engine.handleEvent(ctx.session('s1'), ctx.turnEnd(0))
  const room = ctx.engine.get(ctx.room.id)
  assert.equal(room.status, 'paused')
  assert.equal(ctx.calls.length, 1)
})

test('非 completed 的 turn/end 会暂停', async () => {
  const ctx = harness()
  await startRoom(ctx)
  const request = ctx.calls.at(-1)
  ctx.engine.handleEvent(ctx.session('s1'), ctx.userMessage('s1', request.requestId))
  ctx.engine.handleEvent(ctx.session('s1'), ctx.turnEnd(0, 'error'))
  const room = ctx.engine.get(ctx.room.id)
  assert.equal(room.status, 'paused')
  assert.match(room.messages.at(-1).text, /没有正常结束/)
})

test('冷恢复时 turn/start 先于 user/message 也能正常转发', async () => {
  const ctx = harness()
  await startRoom(ctx)
  const request = ctx.calls.at(-1)

  // 真实日志顺序：seq 7 turn/start，seq 11 群聊 user/message，seq 24 turn/end
  ctx.engine.handleEvent(ctx.session('s1'), ctx.turnStart())
  ctx.engine.handleEvent(ctx.session('s1'), ctx.userMessage('s1', request.requestId, '群聊消息'))
  ctx.engine.handleEvent(ctx.session('s1'), ctx.assistantMessage(0, '这是群聊回复'))
  ctx.engine.handleEvent(ctx.session('s1'), ctx.turnEnd(0))
  await ctx.tick()

  assert.equal(ctx.calls.length, 2)
  assert.equal(ctx.calls[1].sessionId, 's2')
  assert.match(ctx.engine.get(ctx.room.id).messages.at(-1).text, /这是群聊回复/)
})

test('runtime-context 等 user/message 不会覆盖群聊 requestId', async () => {
  const ctx = harness()
  await startRoom(ctx)
  const request = ctx.calls.at(-1)

  ctx.engine.handleEvent(ctx.session('s1'), ctx.userMessage('s1', request.requestId, '群聊消息'))
  ctx.engine.handleEvent(ctx.session('s1'), ctx.contextMessage('s1'))
  ctx.engine.handleEvent(ctx.session('s1'), ctx.assistantMessage(0, '群聊回复'))
  ctx.engine.handleEvent(ctx.session('s1'), ctx.turnEnd(0))
  await ctx.tick()

  assert.equal(ctx.calls.length, 2)
  assert.equal(ctx.calls[1].sessionId, 's2')
})

test('toJSON / load 保留房间，运行中的房间重启后暂停', async () => {
  const ctx = harness()
  await startRoom(ctx)
  const snapshot = ctx.engine.toJSON()
  const next = new GroupChatEngine({ prompt: async () => {}, newId: () => 'x' })
  next.load(snapshot)
  const room = next.get(ctx.room.id)
  assert.equal(room.status, 'paused')
  assert.equal(room.members.length, 3)
  assert.match(room.messages.at(-1).text, /重启/)
})

test('remove 删掉房间', async () => {
  const ctx = harness()
  assert.equal(ctx.engine.remove(ctx.room.id), true)
  assert.equal(ctx.engine.get(ctx.room.id), null)
})

test('引擎拒绝空消息', () => {
  const ctx = harness()
  assert.throws(() => ctx.engine.say(ctx.room.id, '   '), /不能为空/)
})

function inbox(rpcId) {
  return { type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [{ source: { kind: 'user', rpcId } }] } }
}

test('压缩在 user/message 前失败时报告实际错误，而非上一轮输入占用', async () => {
  const ctx = harness()
  ctx.engine.handleEvent(ctx.session('s1'), ctx.userMessage('s1', 'old-human-rpc'))
  const request = await startRoom(ctx)
  ctx.engine.handleEvent(ctx.session('s1'), inbox(request.requestId))
  ctx.engine.handleEvent(ctx.session('s1'), ctx.turnStart())
  ctx.engine.handleEvent(ctx.session('s1'), { type: 'agent/inbox/spliced', data: { target: 'next-turn', removedCount: 1, inserted: [] } })
  ctx.engine.handleEvent(ctx.session('s1'), { type: 'compaction/end', data: { error: '429: OpenCode Zen Free: Free usage limit reached' } })
  ctx.engine.handleEvent(ctx.session('s1'), ctx.turnEnd(1, 'blocked'))
  const room = ctx.engine.get(ctx.room.id)
  assert.equal(room.status, 'paused')
  assert.equal(room.pending, null)
  assert.equal(ctx.calls.length, 1)
  assert.match(room.messages.at(-1).text, /上下文压缩失败.*429.*Free usage limit/)
  assert.doesNotMatch(room.messages.at(-1).text, /其他输入/)
})

test('inbox 接收群聊请求后正常回复可继续轮转', async () => {
  const ctx = harness()
  const request = await startRoom(ctx)
  ctx.engine.handleEvent(ctx.session('s1'), inbox(request.requestId))
  ctx.engine.handleEvent(ctx.session('s1'), ctx.assistantMessage(1, '正常群聊回复'))
  ctx.engine.handleEvent(ctx.session('s1'), ctx.turnEnd(1))
  await ctx.tick()
  assert.equal(ctx.calls.length, 2)
  assert.equal(ctx.engine.get(ctx.room.id).turn, 1)
})

test('inbox 中确有别的用户请求时仍然防止串话', async () => {
  const ctx = harness()
  const request = await startRoom(ctx)
  ctx.engine.handleEvent(ctx.session('s1'), inbox(request.requestId))
  ctx.engine.handleEvent(ctx.session('s1'), inbox('another-human'))
  ctx.engine.handleEvent(ctx.session('s1'), ctx.assistantMessage(1, '不应进入群聊'))
  ctx.engine.handleEvent(ctx.session('s1'), ctx.turnEnd(1))
  assert.equal(ctx.engine.get(ctx.room.id).status, 'paused')
  assert.match(ctx.engine.get(ctx.room.id).messages.at(-1).text, /其他输入/)
  assert.equal(ctx.calls.length, 1)
})

test('常量上限合理', () => {
  assert.ok(GROUP_CHAT_LIMITS.HARD_MAX_TURNS >= GROUP_CHAT_LIMITS.DEFAULT_MAX_TURNS)
  assert.ok(GROUP_CHAT_LIMITS.MAX_MEMBERS >= 2)
})

test('updateMembers 调整成员（增删），保留老成员颜色', () => {
  const ctx = harness()
  const room = ctx.engine.get(ctx.room.id)
  const originalColor = room.members[0].color
  const updated = ctx.engine.updateMembers(ctx.room.id, [
    { sessionId: 's1', title: '前端' },
    { sessionId: 's2', title: '后端' },
    { sessionId: 'new', title: '新成员' },
  ])
  assert.equal(updated.members.length, 3)
  assert.equal(updated.members[0].color, originalColor)
  assert.deepEqual(updated.members.map((m) => m.sessionId), ['s1', 's2', 'new'])
})

test('updateMembers 少于两个成员时报错', () => {
  const ctx = harness()
  assert.throws(() => ctx.engine.updateMembers(ctx.room.id, [{ sessionId: 's1' }]), /至少保留两个成员/)
})

test('讨论中移除当前发言人会暂停', async () => {
  const ctx = harness()
  await startRoom(ctx)
  const room = ctx.engine.get(ctx.room.id)
  assert.equal(room.pending.sessionId, 's1')
  const updated = ctx.engine.updateMembers(ctx.room.id, [
    { sessionId: 's2', title: '后端' },
    { sessionId: 's3', title: '测试' },
  ])
  assert.equal(updated.status, 'paused')
  assert.equal(updated.pending, null)
  assert.equal(updated.members.length, 2)
})

test('非运行状态调整成员不改变状态', () => {
  const ctx = harness()
  const room = ctx.engine.get(ctx.room.id)
  assert.equal(room.status, 'idle')
  const updated = ctx.engine.updateMembers(ctx.room.id, [
    { sessionId: 's1', title: '前端' },
    { sessionId: 's3', title: '测试' },
  ])
  assert.equal(updated.status, 'idle')
})

test('clearHistory 清空成员/用户消息，保留系统提示，后续信封不再带旧发言', async () => {
  const ctx = harness()
  await startRoom(ctx)
  await reply(ctx, 's1', 0, '这是第一句旧发言')
  assert.ok(ctx.engine.get(ctx.room.id).messages.some((message) => message.role === 'member'))

  const view = ctx.engine.clearHistory(ctx.room.id)
  assert.equal(view.messages.some((message) => message.role === 'member' || message.role === 'user'), false)
  assert.match(view.messages.at(-1).text, /已清空历史消息/)

  ctx.engine.pause(ctx.room.id)
  ctx.engine.start(ctx.room.id)
  await ctx.tick()
  assert.doesNotMatch(ctx.calls.at(-1).text, /这是第一句旧发言/)
})


