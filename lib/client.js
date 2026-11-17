/**
 * dsh-group-chat —— 浏览器半边：侧栏入口 + 全屏「群聊」面板
 *
 * 数据全部走同源 HTTP：
 *   GET  /dsh-group-chat/api/sessions     可用对话
 *   GET  /dsh-group-chat/api/rooms        群聊列表
 *   GET  /dsh-group-chat/api/room?id=     单个群聊（含消息）
 *   POST /dsh-group-chat/api/rooms        建群
 *   POST /dsh-group-chat/api/action       开始/暂停/继续/结束/发言/删除
 *
 * 没有用 Remote / 投影：轮询 900ms 足够像群聊，也避免依赖内部 Client API。
 */
window.__ModuleLoader__.load({
  id: 'dsh-group-chat',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    const NS = 'groupChat'
    const PANEL_ID = 'group-chat'
    const API = '/dsh-group-chat/api'
    const COLORS = ['#5b8cff', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4']

    const zh = {
      panel: '对话群聊',
      newRoom: '新建群聊',
      title: '群名称',
      titlePlaceholder: '例如：产品方案评审',
      topic: '讨论话题',
      topicPlaceholder: '想让他们聊什么？',
      members: '成员',
      membersHint: '选 2~6 个现有对话，它们会以各自的人设和上下文发言。',
      maxTurns: '最大轮数',
      unlimited: '不限制轮数',
      unlimitedHint: '一直聊到你手动暂停/结束，或成员说出结束标记；无人看管时会一直消耗 token。',
      removeLimit: '解除上限',
      unlimitedRounds: '不限轮数',
      routing: '发言方式',
      routingAuto: '成员自己决定下一位（推荐）',
      routingRound: '按顺序轮流',
      routingAutoShort: '自动选人',
      routingRoundShort: '轮流',
      routingHint: '发言者在结尾判断谁最合适接话；需要全员表态时它会选全员。只多几十个 token。',
      toRound: '改为轮流',
      toAuto: '改为自动选人',
      untitled: '未命名对话',
      allMembers: '所有人',
      create: '创建群聊',
      cancel: '取消',
      empty: '还没有群聊',
      emptyHint: '新建一个群，选两个以上对话作为成员。',
      pickMembers: '至少选择两个对话',
      start: '开始',
      pause: '暂停',
      resume: '继续',
      stop: '结束',
      send: '发送',
      placeholder: '说点什么，输入 @ 可以点名…',
      typing: '正在输入…',
      you: '我',
      system: '系统',
      delete: '删除',
      back: '返回',
      loading: '加载中…',
      failed: '请求失败',
      statusIdle: '未开始',
      statusRunning: '讨论中',
      statusPaused: '已暂停',
      statusDone: '已结束',
      statusError: '出错',
      round: '轮',
      noSessions: '没有可选对话',
      filter: '搜索对话…',
      confirmDelete: '删除这个群聊？消息记录会一起删掉。',
      startedAt: '开始于',
      editMembers: '调整成员',
      saveMembers: '保存成员',
      archivedTag: '已归档',
      archivedMemberWarn: '房间里有已归档的会话，继续会被阻止，请移除或先取消归档。',
      keepTwoMembers: '至少保留两个成员',
      clearHistory: '清空历史',
      confirmClear: '清空群聊历史？面板里成员和你的消息会被删掉；之后每轮只带最新发言，旧记录不再转述给各对话。',
    }
    const en = {
      panel: 'Group Chat',
      newRoom: 'New group',
      title: 'Group name',
      titlePlaceholder: 'e.g. Product review',
      topic: 'Topic',
      topicPlaceholder: 'What should they discuss?',
      members: 'Members',
      membersHint: 'Pick 2–6 existing conversations; each speaks with its own persona and context.',
      maxTurns: 'Max rounds',
      unlimited: 'Unlimited rounds',
      unlimitedHint: 'Keeps going until you pause/stop or a member ends it; token usage can grow without bound.',
      removeLimit: 'Remove cap',
      unlimitedRounds: 'unlimited',
      routing: 'Speaking order',
      routingAuto: 'Speaker picks the next one (recommended)',
      routingRound: 'Strict round-robin',
      routingAutoShort: 'auto',
      routingRoundShort: 'round-robin',
      routingHint: 'Each speaker picks who should answer next; it can also call everyone. Costs a few dozen extra tokens.',
      toRound: 'Use round-robin',
      toAuto: 'Use auto routing',
      untitled: 'Untitled conversation',
      allMembers: 'Everyone',
      create: 'Create group',
      cancel: 'Cancel',
      empty: 'No group chats yet',
      emptyHint: 'Create a group and pick two or more conversations.',
      pickMembers: 'Pick at least two conversations',
      start: 'Start',
      pause: 'Pause',
      resume: 'Resume',
      stop: 'Stop',
      send: 'Send',
      placeholder: 'Type a message, @ to pick a speaker…',
      typing: 'is typing…',
      you: 'You',
      system: 'System',
      delete: 'Delete',
      back: 'Back',
      loading: 'Loading…',
      failed: 'Request failed',
      statusIdle: 'Not started',
      statusRunning: 'Discussing',
      statusPaused: 'Paused',
      statusDone: 'Finished',
      statusError: 'Error',
      round: 'round',
      noSessions: 'No conversations',
      filter: 'Search conversations…',
      confirmDelete: 'Delete this group and its messages?',
      startedAt: 'Started',
      editMembers: 'Edit members',
      saveMembers: 'Save members',
      archivedTag: 'archived',
      archivedMemberWarn: 'This group has an archived conversation; resuming will be blocked. Remove it or unarchive it first.',
      keepTwoMembers: 'Keep at least two members',
      clearHistory: 'Clear history',
      confirmClear: 'Clear this group chat history? Member and your messages will be removed; later rounds relay only new turns.',
    }

    const CSS = `
.gc-root{box-sizing:border-box;height:100%;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-l1,transparent);font-size:13px;line-height:20px;overflow:hidden}
.gc-body{flex:1;display:flex;min-height:0}
.gc-side{width:250px;flex:none;border-right:.5px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-l1,transparent)}
.gc-side-head{display:flex;align-items:center;gap:8px;padding:14px 14px 8px}
.gc-side-title{flex:1;margin:0;font-size:14px;font-weight:600}
.gc-side-list{flex:1;overflow:auto;padding:0 8px 12px}
.gc-side-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:8px 6px}
.gc-room{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:8px;cursor:pointer;border:1px solid transparent}
.gc-room:hover{background:rgba(127,127,127,.08)}
.gc-room.gc-active{background:rgba(127,127,127,.12);border-color:var(--dsw-alias-border-l2)}
.gc-room-top{display:flex;align-items:center;gap:6px}
.gc-room-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.gc-room-last{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.gc-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}
.gc-dot-running{background:#10b981}
.gc-dot-paused{background:#f59e0b}
.gc-dot-error{background:var(--dsw-alias-state-error-primary)}
.gc-dot-done{background:var(--dsw-alias-label-tertiary)}
.gc-main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.gc-head{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
.gc-head-main{flex:1;min-width:180px}
.gc-head-title{margin:0;font-size:15px;font-weight:600;line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gc-head-sub{color:var(--dsw-alias-label-tertiary);font-size:11.5px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.gc-pill{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;background:rgba(127,127,127,.12);font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.gc-members{display:flex;gap:4px;flex-wrap:wrap}
.gc-member{display:inline-flex;align-items:center;gap:4px;padding:1px 7px 1px 2px;border-radius:999px;background:rgba(127,127,127,.1);font-size:11px;color:var(--dsw-alias-label-secondary);max-width:160px}
.gc-member span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gc-mini-avatar{width:16px;height:16px;border-radius:50%;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:9px;flex:none}
.gc-actions{display:flex;gap:6px;align-items:center}
.gc-btn{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);height:28px;padding:0 10px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:5px}
.gc-btn:hover{background:rgba(127,127,127,.08)}
.gc-btn:disabled{opacity:.45;cursor:default}
.gc-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.gc-btn-danger{color:var(--dsw-alias-state-error-primary)}
.gc-messages{flex:1;overflow:auto;padding:18px 20px 8px;display:flex;flex-direction:column;gap:14px;min-height:0}
.gc-system{align-self:center;color:var(--dsw-alias-label-tertiary);font-size:11.5px;background:rgba(127,127,127,.08);padding:3px 10px;border-radius:999px;max-width:80%;text-align:center}
.gc-msg{display:flex;gap:9px;align-items:flex-start;max-width:92%}
.gc-msg-mine{align-self:flex-end;flex-direction:row-reverse}
.gc-avatar{width:28px;height:28px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:600;margin-top:2px}
.gc-bubble-wrap{display:flex;flex-direction:column;gap:3px;min-width:0}
.gc-msg-mine .gc-bubble-wrap{align-items:flex-end}
.gc-name{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:15px}
.gc-bubble{background:rgba(127,127,127,.1);border-radius:10px;padding:8px 11px;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:20px;max-width:100%}
.gc-msg-mine .gc-bubble{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff)}
.gc-typing{color:var(--dsw-alias-label-tertiary);font-style:italic}
.gc-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--dsw-alias-label-tertiary);padding:40px}
.gc-empty-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.gc-composer{border-top:.5px solid var(--dsw-alias-border-l2);padding:10px 14px 12px;position:relative}
.gc-input-row{display:flex;gap:8px;align-items:flex-end}
.gc-input{flex:1;box-sizing:border-box;min-height:40px;max-height:140px;resize:none;background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);font:inherit;padding:9px 11px;outline:none}
.gc-input:focus{border-color:var(--dsw-alias-brand-primary)}
.gc-icon-btn{width:34px;height:34px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:flex;align-items:center;justify-content:center}
.gc-icon-btn:hover{background:rgba(127,127,127,.08)}
.gc-send{width:40px;height:40px;border-radius:9px;border:none;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff);cursor:pointer;display:flex;align-items:center;justify-content:center}
.gc-send:disabled{opacity:.45;cursor:default}
.gc-mentions{position:absolute;left:14px;right:14px;bottom:64px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,#fff));border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.28);padding:6px;display:flex;flex-direction:column;gap:2px;max-height:220px;overflow:auto;z-index:5}
.gc-mention{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;background:transparent;border:none;color:inherit;font:inherit;text-align:left}
.gc-mention:hover{background:rgba(127,127,127,.12)}
.gc-form{flex:1;overflow:auto;padding:24px clamp(20px,4vw,44px) 32px}
.gc-form-inner{max-width:720px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
.gc-form-title{margin:0;font-size:18px;font-weight:600}
.gc-field{display:flex;flex-direction:column;gap:6px}
.gc-label{font-size:12px;color:var(--dsw-alias-label-secondary);font-weight:500}
.gc-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.gc-text{box-sizing:border-box;background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);font:inherit;padding:8px 10px;outline:none;width:100%}
.gc-text:focus{border-color:var(--dsw-alias-brand-primary)}
.gc-select{height:32px;padding:0 8px;cursor:pointer}
.gc-row{display:flex;gap:12px;flex-wrap:wrap}
.gc-row>*{flex:1;min-width:180px}
.gc-pick{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px}
.gc-pick-row{display:flex;align-items:center;gap:9px;padding:7px 8px;border-radius:6px;cursor:pointer}
.gc-pick-row:hover{background:rgba(127,127,127,.08)}
.gc-pick-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gc-pick-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
.gc-check{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary)}
.gc-check-row{display:flex;align-items:center;gap:7px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;margin-top:5px}
.gc-check-row input{margin:0}
.gc-err{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:0 2px}
.gc-foot{display:flex;gap:8px;justify-content:flex-end;padding-top:4px}
.gc-loading{color:var(--dsw-alias-label-tertiary);padding:20px}
@media (max-width:760px){.gc-side{width:190px}.gc-member{max-width:110px}}
`

    function bindT(props) {
      if (typeof props?.t === 'function') {
        try {
          const probe = props.t('panel')
          if (typeof probe === 'string' && probe !== 'panel') return props.t
        } catch {
          /* 落到内置字典 */
        }
      }
      return fallbackT
    }

    function fallbackT(key) {
      return zh[key] ?? en[key] ?? key
    }

    async function api(pathname, options) {
      const init = { ...options, headers: { accept: 'application/json', ...(options?.headers ?? {}) } }
      if (init.body !== undefined && init.headers['content-type'] === undefined) {
        init.headers['content-type'] = 'application/json'
      }
      const response = await fetch(API + pathname, init)
      let data
      try {
        data = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok || data?.ok === false) throw new Error(data?.error ?? `HTTP ${response.status}`)
      return data
    }

    function statusKey(status) {
      switch (status) {
        case 'running':
          return 'statusRunning'
        case 'paused':
          return 'statusPaused'
        case 'done':
          return 'statusDone'
        case 'error':
          return 'statusError'
        default:
          return 'statusIdle'
      }
    }

    function initial(text) {
      const value = String(text ?? '?').trim()
      return value ? value.slice(0, 1).toUpperCase() : '?'
    }

    function IconChat(props) {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: props?.size ?? 18, height: props?.size ?? 18, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z' }),
      )
    }

    function SidebarIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 4v-4H6.5A2.5 2.5 0 0 1 4 13.5v-8z' }),
        h('circle', { cx: 9, cy: 9.5, r: 1, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 13, cy: 9.5, r: 1, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 17, cy: 9.5, r: 1, fill: 'currentColor', stroke: 'none' }),
      )
    }

    function IconSend() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 17, height: 17, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M22 2 11 13' }),
        h('path', { d: 'M22 2 15 22l-4-9-9-4 20-7z' }),
      )
    }

    function IconAt() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('circle', { cx: 12, cy: 12, r: 4 }),
        h('path', { d: 'M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8' }),
      )
    }

    function Bubble({ message, color, t }) {
      if (message.role === 'system') {
        return h('div', { className: 'gc-system' }, message.text)
      }
      const mine = message.role === 'user'
      return h(
        'div',
        { className: 'gc-msg' + (mine ? ' gc-msg-mine' : '') },
        h('div', { className: 'gc-avatar', style: { background: mine ? '#64748b' : color || COLORS[0] } }, initial(mine ? t('you') : message.alias)),
        h(
          'div',
          { className: 'gc-bubble-wrap' },
          h('div', { className: 'gc-name' }, mine ? t('you') : message.alias),
          h('div', { className: 'gc-bubble' }, message.text),
        ),
      )
    }

    function RoomRow({ room, active, colorOf, t, onOpen }) {
      const last = room.last
      return h(
        'div',
        { className: 'gc-room' + (active ? ' gc-active' : ''), onClick: () => onOpen(room.id), role: 'button', tabIndex: 0, onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') onOpen(room.id) } },
        h(
          'div',
          { className: 'gc-room-top' },
          h('span', { className: `gc-dot gc-dot-${room.status}` }),
          h('span', { className: 'gc-room-name' }, room.title),
          h('span', { className: 'gc-pill' }, room.members.length),
        ),
        h(
          'div',
          { className: 'gc-room-last' },
          room.pending ? `${room.pending.alias} ${t('typing')}` : last ? `${last.role === 'user' ? t('you') : last.alias || ''}：${last.text}` : room.topic,
        ),
      )
    }

    function GroupChatPanel(props) {
      const t = bindT(props)
      const [rooms, setRooms] = useState([])
      const [sessions, setSessions] = useState([])
      const [activeId, setActiveId] = useState(null)
      const [active, setActive] = useState(null)
      const [mode, setMode] = useState('chat')
      const [draft, setDraft] = useState('')
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [loading, setLoading] = useState(true)
      const [showMentions, setShowMentions] = useState(false)
      const [filter, setFilter] = useState('')
      const [form, setForm] = useState({ title: '', topic: '', maxTurns: 12, unlimited: false, routing: 'auto', selected: {} })
      const [editSessions, setEditSessions] = useState([])
      const [editSelected, setEditSelected] = useState({})
      const listRef = useRef(null)

      const refreshRooms = useCallback(async () => {
        try {
          const data = await api('/rooms')
          setRooms(data.rooms ?? [])
        } catch {
          /* 面板可能刚打开，静默 */
        }
      }, [])

      useEffect(() => {
        let stop = false
        api('/sessions')
          .then((data) => {
            if (!stop) setSessions(data.sessions ?? [])
          })
          .catch((cause) => {
            if (!stop) setError(cause.message)
          })
          .finally(() => {
            if (!stop) setLoading(false)
          })
        return () => {
          stop = true
        }
      }, [])

      useEffect(() => {
        refreshRooms()
        const timer = setInterval(refreshRooms, 2000)
        return () => clearInterval(timer)
      }, [refreshRooms])

      useEffect(() => {
        if (!activeId) {
          setActive(null)
          return undefined
        }
        let stop = false
        const load = async () => {
          try {
            const data = await api(`/room?id=${encodeURIComponent(activeId)}`)
            if (!stop) setActive(data.room)
          } catch (cause) {
            if (!stop) {
              setError(cause.message)
              setActiveId(null)
            }
          }
        }
        load()
        const timer = setInterval(load, 900)
        return () => {
          stop = true
          clearInterval(timer)
        }
      }, [activeId])

      useEffect(() => {
        const element = listRef.current
        if (element) element.scrollTop = element.scrollHeight
      }, [active?.messages?.length, active?.pending?.sessionId])

      useEffect(() => {
        if (/@[^\s@]*$/.test(draft)) setShowMentions(true)
      }, [draft])

      const colorOf = useCallback((sessionId) => {
        const member = active?.members?.find((item) => item.sessionId === sessionId)
        return member ? COLORS[member.color % COLORS.length] : COLORS[0]
      }, [active])

      const act = async (action, extra = {}) => {
        if (!activeId) return
        setBusy(true)
        setError(null)
        try {
          const data = await api('/action', { method: 'POST', body: JSON.stringify({ id: activeId, action, ...extra }) })
          if (data.room) setActive(data.room)
          await refreshRooms()
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }

      const create = async () => {
        const memberIds = Object.keys(form.selected).filter((id) => form.selected[id])
        if (memberIds.length < 2) {
          setError(t('pickMembers'))
          return
        }
        setBusy(true)
        setError(null)
        try {
          const data = await api('/rooms', {
            method: 'POST',
            body: JSON.stringify({ title: form.title, topic: form.topic, maxTurns: form.unlimited ? 0 : form.maxTurns, routing: form.routing, memberIds }),
          })
          await refreshRooms()
          setActiveId(data.room.id)
          setActive(data.room)
          setMode('chat')
          setForm({ title: '', topic: '', maxTurns: 12, unlimited: false, routing: 'auto', selected: {} })
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }

      const openEdit = async () => {
        if (!active) return
        setError(null)
        setEditSelected(Object.fromEntries((active.members ?? []).map((member) => [member.sessionId, true])))
        setEditSessions(sessions)
        setMode('edit')
        try {
          const data = await api('/sessions?includeArchived=1')
          setEditSessions(data.sessions ?? sessions)
        } catch (cause) {
          setError(cause.message)
        }
      }

      const saveMembers = async () => {
        if (!activeId) return
        const memberIds = Object.keys(editSelected).filter((id) => editSelected[id])
        if (memberIds.length < 2) {
          setError(t('keepTwoMembers'))
          return
        }
        setBusy(true)
        setError(null)
        try {
          const data = await api('/action', { method: 'POST', body: JSON.stringify({ id: activeId, action: 'members', memberIds }) })
          if (data.room) setActive(data.room)
          await refreshRooms()
          setMode('chat')
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }

      const send = async () => {
        const text = draft.trim()
        if (!text) return
        setDraft('')
        setShowMentions(false)
        await act('say', { text })
      }

      const insertMention = (alias) => {
        setDraft((previous) => {
          const match = previous.match(/@[^\s@]*$/)
          if (match) return `${previous.slice(0, match.index)}@${alias} `
          const gap = previous && !/\s$/.test(previous) ? ' ' : ''
          return `${previous}${gap}@${alias} `
        })
        setShowMentions(false)
      }

      const openRoom = (id) => {
        setActiveId(id)
        setMode('chat')
        setError(null)
      }

      const filteredSessions = useMemo(() => {
        const query = filter.trim().toLowerCase()
        if (!query) return sessions
        return sessions.filter((session) => `${session.title ?? ''} ${session.cwd ?? ''} ${session.id}`.toLowerCase().includes(query))
      }, [sessions, filter])

      const editFilteredSessions = useMemo(() => {
        const query = filter.trim().toLowerCase()
        if (!query) return editSessions
        return editSessions.filter((session) => `${session.title ?? ''} ${session.cwd ?? ''} ${session.id}`.toLowerCase().includes(query))
      }, [editSessions, filter])

      const selectedCount = Object.keys(form.selected).filter((id) => form.selected[id]).length

      const side = h(
        'aside',
        { className: 'gc-side' },
        h(
          'div',
          { className: 'gc-side-head' },
          h('h2', { className: 'gc-side-title' }, t('panel')),
          h('button', { className: 'gc-icon-btn', title: t('newRoom'), onClick: () => { setMode('new'); setError(null) } }, h(IconChat, { size: 16 })),
        ),
        h(
          'div',
          { className: 'gc-side-list' },
          rooms.length === 0
            ? h('div', { className: 'gc-side-empty' }, t('emptyHint'))
            : rooms.map((room) => h(RoomRow, { key: room.id, room, active: room.id === activeId, colorOf, t, onOpen: openRoom })),
        ),
      )

      let main
      if (mode === 'new') {
        main = h(
          'section',
          { className: 'gc-form', key: 'new' },
          h(
            'div',
            { className: 'gc-form-inner' },
            h('h1', { className: 'gc-form-title' }, t('newRoom')),
            h(
              'div',
              { className: 'gc-field' },
              h('label', { className: 'gc-label' }, t('title')),
              h('input', {
                className: 'gc-text',
                value: form.title,
                placeholder: t('titlePlaceholder'),
                onChange: (event) => setForm({ ...form, title: event.target.value }),
              }),
            ),
            h(
              'div',
              { className: 'gc-field' },
              h('label', { className: 'gc-label' }, t('topic')),
              h('textarea', {
                className: 'gc-text',
                rows: 3,
                value: form.topic,
                placeholder: t('topicPlaceholder'),
                onChange: (event) => setForm({ ...form, topic: event.target.value }),
              }),
            ),
            h(
              'div',
              { className: 'gc-row' },
              h(
                'div',
                { className: 'gc-field' },
                h('label', { className: 'gc-label' }, t('maxTurns')),
                h('input', {
                  className: 'gc-text',
                  type: 'number',
                  min: 2,
                  max: 40,
                  disabled: form.unlimited,
                  value: form.unlimited ? '' : form.maxTurns,
                  placeholder: form.unlimited ? '∞' : '',
                  onChange: (event) => setForm({ ...form, maxTurns: Number(event.target.value) || 12 }),
                }),
                h(
                  'label',
                  { className: 'gc-check-row' },
                  h('input', {
                    className: 'gc-check',
                    type: 'checkbox',
                    checked: form.unlimited,
                    onChange: (event) => setForm({ ...form, unlimited: event.target.checked }),
                  }),
                  h('span', null, t('unlimited')),
                ),
                h('div', { className: 'gc-hint' }, t('unlimitedHint')),
              ),
            ),
            h(
              'div',
              { className: 'gc-row' },
              h(
                'div',
                { className: 'gc-field' },
                h('label', { className: 'gc-label' }, t('routing')),
                h(
                  'select',
                  {
                    className: 'gc-text gc-select',
                    value: form.routing,
                    onChange: (event) => setForm({ ...form, routing: event.target.value }),
                  },
                  h('option', { value: 'auto' }, t('routingAuto')),
                  h('option', { value: 'round' }, t('routingRound')),
                ),
                h('div', { className: 'gc-hint' }, t('routingHint')),
              ),
            ),
            h(
              'div',
              { className: 'gc-field' },
              h('label', { className: 'gc-label' }, `${t('members')} · ${selectedCount}`),
              h('div', { className: 'gc-hint' }, t('membersHint')),
              h('input', {
                className: 'gc-text',
                value: filter,
                placeholder: t('filter'),
                onChange: (event) => setFilter(event.target.value),
              }),
              h(
                'div',
                { className: 'gc-pick' },
                filteredSessions.length === 0
                  ? h('div', { className: 'gc-pick-sub', style: { padding: '8px' } }, t('noSessions'))
                  : filteredSessions.map((session) => {
                      const checked = form.selected[session.id] === true
                      return h(
                        'label',
                        { className: 'gc-pick-row', key: session.id },
                        h('input', {
                          className: 'gc-check',
                          type: 'checkbox',
                          checked,
                          onChange: (event) => setForm({ ...form, selected: { ...form.selected, [session.id]: event.target.checked } }),
                        }),
                        h('span', { className: 'gc-pick-name' }, session.title || t('untitled')),
                        h('span', { className: 'gc-pick-sub' }, session.cwd ? session.cwd.replace(/^.*[\\/]/, '') || session.cwd : session.id.slice(0, 10)),
                      )
                    }),
              ),
            ),
            error ? h('div', { className: 'gc-err' }, error) : null,
            h(
              'div',
              { className: 'gc-foot' },
              h('button', { className: 'gc-btn', onClick: () => { setMode('chat'); setError(null) } }, t('cancel')),
              h('button', { className: 'gc-btn gc-btn-primary', disabled: busy, onClick: create }, t('create')),
            ),
          ),
        )
      } else if (mode === 'edit' && active) {
        const editCount = Object.keys(editSelected).filter((id) => editSelected[id]).length
        main = h(
          'section',
          { className: 'gc-form', key: 'edit' },
          h(
            'div',
            { className: 'gc-form-inner' },
            h('h1', { className: 'gc-form-title' }, t('editMembers')),
            h('div', { className: 'gc-hint' }, t('membersHint')),
            h('input', {
              className: 'gc-text',
              value: filter,
              placeholder: t('filter'),
              onChange: (event) => setFilter(event.target.value),
            }),
            h(
              'div',
              { className: 'gc-pick' },
              editFilteredSessions.length === 0
                ? h('div', { className: 'gc-pick-sub', style: { padding: '8px' } }, t('noSessions'))
                : editFilteredSessions.map((session) => {
                    const checked = editSelected[session.id] === true
                    // 已归档的会话不能新加进来；已选中的可以取消（用来移除归档成员）。
                    const disabled = session.archived === true && !checked
                    return h(
                      'label',
                      { className: 'gc-pick-row', key: session.id, style: disabled ? { opacity: 0.55 } : undefined },
                      h('input', {
                        className: 'gc-check',
                        type: 'checkbox',
                        checked,
                        disabled,
                        onChange: (event) => setEditSelected({ ...editSelected, [session.id]: event.target.checked }),
                      }),
                      h('span', { className: 'gc-pick-name' }, session.title || t('untitled')),
                      h('span', { className: 'gc-pick-sub' }, session.archived ? t('archivedTag') : session.cwd ? session.cwd.replace(/^.*[\\/]/, '') || session.cwd : session.id.slice(0, 10)),
                    )
                  }),
            ),
            error ? h('div', { className: 'gc-err' }, error) : null,
            h(
              'div',
              { className: 'gc-foot' },
              h('button', { className: 'gc-btn', onClick: () => { setMode('chat'); setError(null) } }, t('cancel')),
              h('button', { className: 'gc-btn gc-btn-primary', disabled: busy || editCount < 2, onClick: saveMembers }, `${t('saveMembers')} · ${editCount}`),
            ),
          ),
        )
      } else if (!active) {
        main = h(
          'section',
          { className: 'gc-main', key: 'empty' },
          h(
            'div',
            { className: 'gc-empty' },
            h('div', { className: 'gc-empty-title' }, t('empty')),
            h('div', null, t('emptyHint')),
            h('button', { className: 'gc-btn gc-btn-primary', onClick: () => setMode('new') }, t('newRoom')),
          ),
        )
      } else {
        const room = active
        const running = room.status === 'running'
        const canResume = room.status === 'paused' || room.status === 'idle' || room.status === 'done' || room.status === 'error'
        main = h(
          'section',
          { className: 'gc-main', key: room.id },
          h(
            'header',
            { className: 'gc-head' },
            h(
              'div',
              { className: 'gc-head-main' },
              h('h1', { className: 'gc-head-title' }, room.title),
              h(
                'div',
                { className: 'gc-head-sub' },
                h('span', { className: 'gc-pill' }, t(statusKey(room.status))),
                h('span', { className: 'gc-pill' }, t(room.routing === 'auto' ? 'routingAutoShort' : 'routingRoundShort')),
                h('span', null, room.maxTurns === 0 ? `${room.turn} · ${t('unlimitedRounds')}` : `${room.turn} / ${room.maxTurns} ${t('round')}`),
                h('span', null, room.topic),
                room.members.some((member) => member.archived)
                  ? h(
                      'span',
                      { className: 'gc-pill', title: t('archivedMemberWarn'), style: { color: 'var(--dsw-alias-state-error-primary)' } },
                      `⚠ ${t('archivedTag')}`,
                    )
                  : null,
              ),
              h(
                'div',
                { className: 'gc-members', style: { marginTop: '4px' } },
                room.members.map((member) =>
                  h(
                    'span',
                    {
                      className: 'gc-member',
                      key: member.sessionId,
                      title: member.archived ? `${member.sessionId} · ${t('archivedTag')}` : member.sessionId,
                      style: member.archived ? { outline: '1px dashed var(--dsw-alias-state-error-primary)' } : undefined,
                    },
                    h('span', { className: 'gc-mini-avatar', style: { background: COLORS[member.color % COLORS.length] } }, initial(member.alias)),
                    h('span', null, member.archived ? `${member.alias} · ${t('archivedTag')}` : member.alias),
                  ),
                ),
              ),
            ),
            h(
              'div',
              { className: 'gc-actions' },
              canResume && !running
                ? h(
                    'button',
                    {
                      className: 'gc-btn gc-btn-primary',
                      disabled: busy,
                      onClick: () => act(room.status === 'idle' || room.status === 'done' || room.turn === 0 ? 'start' : 'resume'),
                    },
                    room.status === 'idle' || room.status === 'done' || room.turn === 0 ? t('start') : t('resume'),
                  )
                : null,
              running ? h('button', { className: 'gc-btn', disabled: busy, onClick: () => act('pause') }, t('pause')) : null,
              h(
                'button',
                {
                  className: 'gc-btn',
                  disabled: busy,
                  onClick: () => act('routing', { routing: room.routing === 'auto' ? 'round' : 'auto' }),
                },
                room.routing === 'auto' ? t('toRound') : t('toAuto'),
              ),
              room.maxTurns > 0 && room.status !== 'done'
                ? h('button', { className: 'gc-btn', disabled: busy, onClick: () => act('unlimited') }, t('removeLimit'))
                : null,
              room.status !== 'done' ? h('button', { className: 'gc-btn', disabled: busy, onClick: () => act('stop') }, t('stop')) : null,
              h('button', { className: 'gc-btn', disabled: busy, onClick: openEdit }, t('editMembers')),
              h('button', {
                className: 'gc-btn',
                disabled: busy,
                onClick: async () => {
                  if (!window.confirm(t('confirmClear'))) return
                  await act('clear')
                },
              }, t('clearHistory')),
              h('button', {
                className: 'gc-btn gc-btn-danger',
                disabled: busy,
                onClick: async () => {
                  if (!window.confirm(t('confirmDelete'))) return
                  setBusy(true)
                  try {
                    await api('/action', { method: 'POST', body: JSON.stringify({ id: room.id, action: 'remove' }) })
                    setActiveId(null)
                    setActive(null)
                    await refreshRooms()
                  } catch (cause) {
                    setError(cause.message)
                  } finally {
                    setBusy(false)
                  }
                },
              }, t('delete')),
            ),
          ),
          h(
            'div',
            { className: 'gc-messages', ref: listRef },
            room.messages.length === 0
              ? h('div', { className: 'gc-empty' }, h('div', { className: 'gc-empty-title' }, t('empty')), h('div', null, t('emptyHint')))
              : room.messages.map((message) => h(Bubble, { key: message.id, message, color: colorOf(message.sessionId), t })),
            room.pending
              ? h(
                  'div',
                  { className: 'gc-msg' },
                  h('div', { className: 'gc-avatar', style: { background: colorOf(room.pending.sessionId) } }, initial(room.pending.alias)),
                  h(
                    'div',
                    { className: 'gc-bubble-wrap' },
                    h('div', { className: 'gc-name' }, room.pending.alias),
                    h('div', { className: 'gc-bubble gc-typing' }, t('typing')),
                  ),
                )
              : null,
          ),
          error ? h('div', { className: 'gc-err', style: { padding: '0 18px' } }, error) : null,
          h(
            'div',
            { className: 'gc-composer' },
            showMentions
              ? h(
                  'div',
                  { className: 'gc-mentions' },
                  [
                    h(
                      'button',
                      { className: 'gc-mention', key: '__all__', onClick: () => insertMention(t('allMembers')) },
                      h('span', { className: 'gc-mini-avatar', style: { background: '#64748b' } }, '@'),
                      t('allMembers'),
                    ),
                    ...room.members.map((member) =>
                      h(
                        'button',
                        { className: 'gc-mention', key: member.sessionId, onClick: () => insertMention(member.alias) },
                        h('span', { className: 'gc-mini-avatar', style: { background: COLORS[member.color % COLORS.length] } }, initial(member.alias)),
                        member.alias,
                      ),
                    ),
                  ],
                )
              : null,
            h(
              'div',
              { className: 'gc-input-row' },
              h('button', { className: 'gc-icon-btn', title: '@', onClick: () => setShowMentions((value) => !value) }, h(IconAt)),
              h('textarea', {
                className: 'gc-input',
                rows: 2,
                value: draft,
                placeholder: t('placeholder'),
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                    event.preventDefault()
                    send()
                  }
                },
              }),
              h('button', { className: 'gc-send', disabled: busy || !draft.trim(), title: t('send'), onClick: send }, h(IconSend)),
            ),
          ),
        )
      }

      return h(
        'div',
        { className: 'gc-root' },
        h('div', { className: 'gc-body' }, side, main),
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'group-chat: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.effect(() => {
        const style = document.createElement('style')
        style.id = 'dsh-group-chat/style'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'group-chat: styles')

      ctx.slots.inject('main', function* () {
        yield ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
          },
          GroupChatPanel,
        )
      })
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            label: () => t('panel'),
            locale: NS,
          },
          SidebarIcon,
        ),
      )
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
