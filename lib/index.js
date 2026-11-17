/**
 * dsh-group-chat —— Host 插件入口
 *
 * 只做四件事：
 *   1. 把 DSH 的会话事件转发给群聊引擎；
 *   2. 提供同源 HTTP API（会话列表 / 房间列表 / 房间详情 / 操作）；
 *   3. 把引擎状态落到 ~/.dsh/group-chat/rooms.json；
 *   4. 用 DSH 的 connection 信任栅栏保护所有路由（回环 + 登录态）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GroupChatEngine } from './engine.js'

export const name = 'dsh-group-chat'
export const inject = ['sessionController', 'webServer', 'connection', 'workspaceRegistry']

const API_PREFIX = '/dsh-group-chat/api'
const BODY_LIMIT = 256 * 1024

function json(res, code, value) {
  if (res.headersSent) return
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sessionTitle(item) {
  const title = item?.projections?.values?.title
  return typeof title === 'string' && title.trim() ? title.trim() : null
}

export function apply(ctx) {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const dataDir = path.join(dshHome, 'group-chat')
  const dataFile = path.join(dataDir, 'rooms.json')

  try {
    fs.mkdirSync(dataDir, { recursive: true })
  } catch (error) {
    console.warn(`[group-chat] 无法创建数据目录 ${dataDir}: ${String(error?.message ?? error)}`)
  }

  const lifecycle = new AbortController()
  // 在 apply 期间捕获服务引用：路由回调可能在这个 fiber 失活后仍被调用，
  // 通过 ctx.sessionController 取值会抛 "inactive context"。
  const sessionController = ctx.sessionController
  // 已归档的会话会被 DSH 在进入步骤前直接拒绝（轮次以 blocked 收口），
  // 所以建群 / 加成员要把它们挡在外面，并让界面能标出来。
  const workspaceRegistry = ctx.get('workspaceRegistry') || ctx.workspaceRegistry

  function archivedSessionSet() {
    try {
      return new Set(workspaceRegistry?.archivedSessionIds ?? [])
    } catch {
      return new Set()
    }
  }

  const engine = new GroupChatEngine({
    prompt: (sessionId, text, requestId) =>
      sessionController.prompt(
        {
          sessionId,
          requestId,
          content: [{ type: 'text', text }],
        },
        lifecycle.signal,
      ),
    persist: (snapshot) => {
      try {
        const tmp = `${dataFile}.${process.pid}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8')
        fs.renameSync(tmp, dataFile)
      } catch (error) {
        console.warn(`[group-chat] 保存失败：${String(error?.message ?? error)}`)
      }
    },
    log: (message) => console.log(`[group-chat] ${message}`),
  })

  try {
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    engine.load(raw)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`[group-chat] 读取 ${dataFile} 失败，将从空状态开始：${String(error?.message ?? error)}`)
    }
  }

  // ── 会话事件 → 引擎 ─────────────────────────────────────────────────────
  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        try {
          engine.handleEvent(session, event)
        } catch (error) {
          console.warn(`[group-chat] 会话事件处理失败：${String(error?.message ?? error)}`)
        }
      }),
    'group-chat: session events',
  )
  ctx.effect(
    () =>
      ctx.on('session/disposed', (session) => {
        try {
          engine.onSessionDisposed(session)
        } catch (error) {
          console.warn(`[group-chat] 会话关闭处理失败：${String(error?.message ?? error)}`)
        }
      }),
    'group-chat: session disposed',
  )
  ctx.effect(() => () => engine.dispose(), 'group-chat: engine')
  ctx.effect(() => () => lifecycle.abort(), 'group-chat: lifecycle')

  // ── 信任栅栏 ────────────────────────────────────────────────────────────
  function isLoopback(req) {
    const host = String(req.headers?.host ?? '').toLowerCase()
    const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
    return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
  }

  function rejected(req, res) {
    // 同源栅栏：浏览器从别的站点发起的请求会带别人的 Origin。
    // 回环地址本身不构成授权（任意网页都能向 127.0.0.1 发请求）。
    const origin = req.headers?.origin
    if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
      try {
        if (new URL(origin).host !== req.headers?.host) {
          json(res, 403, { ok: false, error: '不受信任的访问来源' })
          return true
        }
      } catch {
        json(res, 403, { ok: false, error: '不受信任的访问来源' })
        return true
      }
    }
    if (isLoopback(req)) return false
    const connection = ctx.get('connection') || ctx.connection
    if (!connection) {
      json(res, 403, { ok: false, error: '不受信任的访问来源' })
      return true
    }
    try {
      const code = connection.requestRejection?.(req)
      if (code !== undefined && code !== null && code !== false) {
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      }
      if (typeof connection.isTrusted === 'function' && connection.isTrusted(req) !== true) {
        json(res, 403, { ok: false, error: '不受信任的访问来源' })
        return true
      }
      return false
    } catch (error) {
      json(res, 503, { ok: false, error: `信任校验失败：${String(error?.message ?? error)}` })
      return true
    }
  }

  // ── 路由 ────────────────────────────────────────────────────────────────
  // DSH 的 webServer 以 (kind, path) 为键，同一路径只能注册一次；
  // 因此每个 path 只注册一个 handler，方法在 handler 内分发。
  const disposers = []
  const methodNotAllowed = (res, allow) => {
    json(res, 405, { ok: false, error: `只支持 ${allow}` })
  }
  const route = (pathname, handler) => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: pathname,
      handler: async (req, res) => {
        if (rejected(req, res)) return
        try {
          await handler(req, res)
        } catch (error) {
          json(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    })
    disposers.push(dispose)
  }

  async function listSessions({ includeArchived = false } = {}) {
    const result = await sessionController.list({})
    const archived = archivedSessionSet()
    return (result?.items ?? [])
      // 只排除真正的子代理/侧边对话（origin=subagent）和空白会话；
      // 用户可见的派生会话（有 parentSessionId 但 origin 不是 subagent）要保留，比如「HRS试分析」。
      .filter((item) => item.origin !== 'subagent' && item.blank !== true)
      .map((item) => ({
        id: item.sessionId,
        title: sessionTitle(item),
        cwd: item.cwd ?? null,
        running: item.running === true,
        blank: item.blank === true,
        archived: archived.has(item.sessionId),
        updatedAt: item.updatedAt ?? 0,
      }))
      // 建群默认不显示已归档的会话；编辑成员时可以带上（好让用户移除已归档成员）。
      .filter((session) => includeArchived || !session.archived)
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  // 房间视图里给每个成员标上 archived，前端据此提醒/迁移。
  function annotateRoom(room) {
    if (!room || !Array.isArray(room.members)) return room
    const archived = archivedSessionSet()
    return {
      ...room,
      members: room.members.map((member) => ({ ...member, archived: archived.has(member.sessionId) })),
    }
  }

  route(`${API_PREFIX}/sessions`, async (req, res) => {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
    const url = new URL(req.url, 'http://localhost')
    const includeArchived = url.searchParams.get('includeArchived') === '1'
    const sessions = await listSessions({ includeArchived })
    json(res, 200, { ok: true, sessions })
  })

  route(`${API_PREFIX}/rooms`, async (req, res) => {
    if (req.method === 'GET') {
      json(res, 200, { ok: true, rooms: engine.list() })
      return
    }
    if (req.method !== 'POST') return methodNotAllowed(res, 'GET, POST')

    const body = await readJson(req)
    const memberIds = Array.isArray(body.memberIds) ? [...new Set(body.memberIds.map(String))] : []
    if (memberIds.length < 2) {
      json(res, 400, { ok: false, error: '至少选择两个对话' })
      return
    }
    // 已归档的会话不能选：DSH 会拒绝进入步骤，群聊永远卡在 blocked。
    const archived = archivedSessionSet()
    const archivedPicked = memberIds.filter((sessionId) => archived.has(sessionId))
    if (archivedPicked.length > 0) {
      json(res, 400, { ok: false, error: '不能选择已归档的会话，请先在会话列表里取消归档' })
      return
    }
    const sessions = await listSessions({ includeArchived: true })
    const byId = new Map(sessions.map((session) => [session.id, session]))
    const members = memberIds.map((sessionId, index) => {
      const session = byId.get(sessionId)
      const title = session?.title ?? null
      return { sessionId, title, cwd: session?.cwd ?? null, alias: title || `会话 ${index + 1}` }
    })
    const title = String(body.title ?? '').trim() || members.slice(0, 2).map((member) => member.alias).join(' × ')
    const room = engine.create({
      title,
      topic: body.topic,
      members,
      maxTurns: body.maxTurns,
      routing: body.routing,
    })
    json(res, 200, { ok: true, room: annotateRoom(room) })
  })

  route(`${API_PREFIX}/room`, async (req, res) => {
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
    const id = new URL(req.url, 'http://localhost').searchParams.get('id') ?? ''
    const room = engine.get(id)
    if (!room) {
      json(res, 404, { ok: false, error: '群聊不存在' })
      return
    }
    json(res, 200, { ok: true, room: annotateRoom(engine.roomView(room)) })
  })

  route(`${API_PREFIX}/action`, async (req, res) => {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
    const body = await readJson(req)
    const id = String(body.id ?? '')
    const action = String(body.action ?? '')
    if (!id) {
      json(res, 400, { ok: false, error: '缺少群聊 id' })
      return
    }
    let room
    switch (action) {
      case 'start':
        room = engine.start(id)
        break
      case 'pause':
        room = engine.pause(id)
        break
      case 'resume':
        room = engine.resume(id)
        break
      case 'stop':
        room = engine.stop(id)
        break
      case 'unlimited':
        room = engine.setUnlimited(id)
        break
      case 'routing':
        room = engine.setRouting(id, String(body.routing ?? 'auto'))
        break
      case 'clear':
        room = engine.clearHistory(id)
        break
      case 'say':
        room = engine.say(id, String(body.text ?? ''))
        break
      case 'members': {
        const memberIds = Array.isArray(body.memberIds) ? [...new Set(body.memberIds.map(String))] : []
        const current = engine.get(id)
        if (!current) {
          json(res, 404, { ok: false, error: '群聊不存在' })
          return
        }
        const existing = new Set(current.members.map((member) => member.sessionId))
        const archived = archivedSessionSet()
        const addingArchived = memberIds.filter((sessionId) => !existing.has(sessionId) && archived.has(sessionId))
        if (addingArchived.length > 0) {
          json(res, 400, { ok: false, error: '不能添加已归档的会话，请先在会话列表里取消归档' })
          return
        }
        const sessions = await listSessions({ includeArchived: true })
        const byId = new Map(sessions.map((session) => [session.id, session]))
        const members = memberIds.map((sessionId, index) => {
          const session = byId.get(sessionId)
          const old = current.members.find((member) => member.sessionId === sessionId)
          const title = session?.title ?? old?.title ?? null
          return { sessionId, title, cwd: session?.cwd ?? old?.cwd ?? null, alias: old?.alias || title || `会话 ${index + 1}` }
        })
        room = engine.updateMembers(id, members)
        break
      }
      case 'remove':
        engine.remove(id)
        json(res, 200, { ok: true })
        return
      default:
        json(res, 400, { ok: false, error: `未知操作：${action}` })
        return
    }
    json(res, 200, { ok: true, room: annotateRoom(room) })
  })

  ctx.effect(
    () => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 路由已随宿主卸载 */
        }
      }
    },
    'group-chat: routes',
  )

  console.log(`[group-chat] 已挂载：${API_PREFIX} · 数据 ${dataFile}`)
}
