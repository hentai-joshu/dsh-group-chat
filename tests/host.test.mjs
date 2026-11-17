import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-group-chat-'))
process.env.DSH_HOME = home

const { apply } = await import('../lib/index.js')

function makeCtx() {
  const routes = new Map()
  const listeners = new Map()
  const disposers = []
  const prompts = []
  const sessions = [
    { sessionId: 's1', projections: { values: { title: '前端重构' } }, cwd: 'C:/work/web', running: false, updatedAt: 3 },
    { sessionId: 's2', projections: { values: { title: '后端设计' } }, cwd: 'C:/work/api', running: false, updatedAt: 2 },
    { sessionId: 's3', parentSessionId: 's1', origin: 'subagent', projections: { values: { title: '子代理' } }, cwd: 'C:/work/web', running: false, updatedAt: 1 },
    { sessionId: 's4', projections: { values: {} }, cwd: 'C:/tmp', running: false, blank: true, updatedAt: 4 },
    { sessionId: 's5', projections: { values: { title: '归档会话' } }, cwd: 'C:/work/old', running: false, updatedAt: 5 },
    { sessionId: 's6', parentSessionId: 's1', projections: { values: { title: '派生会话' } }, cwd: 'C:/work/web', running: false, updatedAt: 6 },
  ]
  const ctx = {
    connection: { requestRejection: () => undefined, isTrusted: () => true },
    workspaceRegistry: { archivedSessionIds: ['s5'] },
    get(name) {
      if (name === 'connection') return this.connection
      if (name === 'workspaceRegistry') return this.workspaceRegistry
      return undefined
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    effect(factory) {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    webServer: {
      register(definition) {
        if (routes.has(definition.path)) throw new Error(`duplicate route ${definition.path}`)
        routes.set(definition.path, definition)
        return () => routes.delete(definition.path)
      },
    },
    sessionController: {
      list: async () => ({ items: sessions }),
      prompt: async (request) => {
        prompts.push(request)
        return { accepted: true }
      },
    },
  }
  return { ctx, routes, listeners, disposers, prompts }
}

function makeRequest({ method = 'GET', url = '/', body } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:49913' }
  if (body !== undefined) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
  } else {
    process.nextTick(() => req.emit('end'))
  }
  return req
}

function makeResponse() {
  return {
    headersSent: false,
    statusCode: 200,
    headers: null,
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
      this.headersSent = true
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk)
      this.headersSent = true
    },
    json() {
      return JSON.parse(this.body)
    },
  }
}

test('apply 注册 host 路由并过滤子代理会话', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)

  assert.ok(routes.has('/dsh-group-chat/api/sessions'))
  assert.ok(routes.has('/dsh-group-chat/api/rooms'))
  assert.ok(routes.has('/dsh-group-chat/api/room'))
  assert.ok(routes.has('/dsh-group-chat/api/action'))

  const res = makeResponse()
  await routes.get('/dsh-group-chat/api/sessions').handler(makeRequest({ url: '/dsh-group-chat/api/sessions' }), res)
  const data = res.json()
  assert.equal(data.ok, true)
  assert.deepEqual(data.sessions.map((session) => session.id), ['s6', 's1', 's2'])
})

test('建群 + 开始会向第一位成员投递', async () => {
  const { ctx, routes, prompts } = makeCtx()
  apply(ctx)

  const created = makeResponse()
  await routes.get('/dsh-group-chat/api/rooms').handler(
    makeRequest({
      method: 'POST',
      url: '/dsh-group-chat/api/rooms',
      body: { title: '评审', topic: '拆不拆', memberIds: ['s1', 's2'], maxTurns: 4 },
    }),
    created,
  )
  const room = created.json().room
  assert.equal(room.title, '评审')
  assert.equal(room.members.length, 2)
  assert.equal(room.members[0].alias, '前端重构')

  const started = makeResponse()
  await routes.get('/dsh-group-chat/api/action').handler(
    makeRequest({
      method: 'POST',
      url: '/dsh-group-chat/api/action',
      body: { id: room.id, action: 'start' },
    }),
    started,
  )
  assert.equal(started.json().ok, true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionId, 's1')
  assert.match(prompts[0].content[0].text, /拆不拆/)
})

test('非回环且没有 connection 服务时拒绝访问', async () => {
  const { ctx, routes } = makeCtx()
  ctx.connection = null
  apply(ctx)

  const res = makeResponse()
  const req = makeRequest({ url: '/dsh-group-chat/api/rooms' })
  req.headers.host = 'example.com'
  await routes.get('/dsh-group-chat/api/rooms').handler(req, res)
  assert.equal(res.statusCode, 403)
})

test('同一路径只注册一次，方法错误返回 405', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  assert.equal(routes.size, 4)

  const res = makeResponse()
  await routes.get('/dsh-group-chat/api/rooms').handler(
    makeRequest({ method: 'PUT', url: '/dsh-group-chat/api/rooms' }),
    res,
  )
  assert.equal(res.statusCode, 405)
  assert.equal(res.json().ok, false)
})

test('默认不列出已归档会话；includeArchived=1 时列出并标记 archived', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const plain = makeResponse()
  await routes.get('/dsh-group-chat/api/sessions').handler(makeRequest({ url: '/dsh-group-chat/api/sessions' }), plain)
  assert.deepEqual(plain.json().sessions.map((s) => s.id), ['s6', 's1', 's2'])

  const withArchived = makeResponse()
  await routes.get('/dsh-group-chat/api/sessions').handler(
    makeRequest({ url: '/dsh-group-chat/api/sessions?includeArchived=1' }),
    withArchived,
  )
  const list = withArchived.json().sessions
  const s5 = list.find((s) => s.id === 's5')
  assert.ok(s5)
  assert.equal(s5.archived, true)
})

test('建群时不能选已归档会话', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const res = makeResponse()
  await routes.get('/dsh-group-chat/api/rooms').handler(
    makeRequest({ method: 'POST', url: '/dsh-group-chat/api/rooms', body: { title: 'x', memberIds: ['s1', 's5'] } }),
    res,
  )
  assert.equal(res.statusCode, 400)
  assert.match(res.json().error, /已归档/)
})

test('action members 可以调整成员；添加已归档会话被拒', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const created = makeResponse()
  await routes.get('/dsh-group-chat/api/rooms').handler(
    makeRequest({ method: 'POST', url: '/dsh-group-chat/api/rooms', body: { title: '评审', memberIds: ['s1', 's2'] } }),
    created,
  )
  const roomId = created.json().room.id

  const ok = makeResponse()
  await routes.get('/dsh-group-chat/api/action').handler(
    makeRequest({ method: 'POST', url: '/dsh-group-chat/api/action', body: { id: roomId, action: 'members', memberIds: ['s1', 's3'] } }),
    ok,
  )
  assert.equal(ok.json().ok, true)
  assert.deepEqual(ok.json().room.members.map((m) => m.sessionId), ['s1', 's3'])

  const bad = makeResponse()
  await routes.get('/dsh-group-chat/api/action').handler(
    makeRequest({ method: 'POST', url: '/dsh-group-chat/api/action', body: { id: roomId, action: 'members', memberIds: ['s1', 's5'] } }),
    bad,
  )
  assert.equal(bad.statusCode, 400)
  assert.match(bad.json().error, /已归档/)
})

