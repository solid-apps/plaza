// plaza — group chat on the open web
//
// PoC: each pod hosts its own group chat at <pod>/public/plaza/.
// Each message is one JSON-LD resource. Reads are public; writes
// require auth. Real-time updates via JSS /.notifications WebSocket.
//
// Phases (see README):
//   1. PoC — single channel per pod, send + receive + real-time   ← here
//   2. Workspaces — multiple channels per pod
//   3. Reactions
//   4. Cross-pod channels — ACL with WebIDs from multiple pods
//   5. Presence + typing via Nostr ephemeral
//   6. Mentions + per-user notification
//   7. Threads
//   8. Search

const PLAZA_PATH = '/public/plaza/'
const LS_LAST_POD = 'plaza.lastPod'
const SCHEMA = 'https://schema.org/'
const FOAF = 'http://xmlns.com/foaf/0.1/'

const state = {
  podOrigin: null,        // origin of the pod hosting THIS plaza
  plazaUrl: null,         // <pod>/public/plaza/
  messages: [],           // [{ url, text, sender, dateCreated }]
  byUrl: new Map(),       // url → index in messages
  ws: null,
  wsReady: false,
  profiles: new Map(),    // webId → { name, picture } (lazy)
  scrollPinned: true      // auto-scroll to bottom unless user scrolled up
}

// --- helpers ---

function authFetch(url, opts) {
  if (window.xlogin && window.xlogin.id && window.xlogin.authFetch) {
    return window.xlogin.authFetch(url, opts)
  }
  return fetch(url, opts)
}

function meWebId() { return window.xlogin?.id || null }

function podFromWebId(webId) {
  if (!webId || !webId.startsWith('http')) return null
  try { const u = new URL(webId); return `${u.protocol}//${u.host}` } catch { return null }
}

function escapeHtml(s) {
  if (typeof s !== 'string') s = String(s ?? '')
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// Linkify URLs and `code` spans. Keeps newlines (CSS handles white-space).
function renderText(text) {
  let html = escapeHtml(text || '')
  // `inline code` first so its content doesn't get linkified
  const codeSlots = []
  html = html.replace(/`([^`]+)`/g, (_, c) => {
    codeSlots.push(c)
    return `\x00CODE${codeSlots.length - 1}\x00`
  })
  // URLs
  html = html.replace(/\b(https?:\/\/[^\s<]+)/g, (url) =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
  // Restore code
  html = html.replace(/\x00CODE(\d+)\x00/g, (_, i) => `<code>${codeSlots[i]}</code>`)
  return html
}

function formatTime(d) {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function formatDateDivider(d) {
  const now = new Date()
  const same = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  if (same(d, now)) return 'Today'
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (same(d, y)) return 'Yesterday'
  return d.toLocaleDateString(undefined,
    d.getFullYear() === now.getFullYear()
      ? { weekday: 'short', month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' })
}

function dayKey(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function initials(name) {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// --- profile fetch (name + avatar) ---

async function fetchProfile(webId) {
  if (!webId) return null
  if (state.profiles.has(webId)) return state.profiles.get(webId)
  // Stake a pending entry so concurrent requests collapse
  let resolve
  const pending = new Promise(r => resolve = r)
  state.profiles.set(webId, pending)
  try {
    const r = await fetch(webId, { headers: { Accept: 'application/ld+json' } })
    if (!r.ok) throw new Error(`profile ${r.status}`)
    const doc = await r.json()
    const profile = parseProfile(doc, webId)
    state.profiles.set(webId, profile)
    resolve(profile)
    return profile
  } catch {
    const fallback = { name: hostLabel(webId), picture: null }
    state.profiles.set(webId, fallback)
    resolve(fallback)
    return fallback
  }
}

function hostLabel(webId) {
  try {
    const u = new URL(webId)
    return u.host.split('.')[0]
  } catch { return webId }
}

function parseProfile(doc, webId) {
  // Walk the doc for any node matching webId (with or without fragment), pull name + image
  const nodes = doc['@graph'] ? (Array.isArray(doc['@graph']) ? doc['@graph'] : [doc['@graph']]) : [doc]
  const target = nodes.find(n => n['@id'] === webId || n['@id'] === '#' + (webId.split('#')[1] || '') || n['@id'] === webId.split('#').pop()) || nodes[0]
  if (!target) return { name: hostLabel(webId), picture: null }
  const name =
    target['foaf:name'] || target[FOAF + 'name'] ||
    target['schema:name'] || target[SCHEMA + 'name'] ||
    target['name'] || hostLabel(webId)
  const pic =
    target['foaf:img'] || target[FOAF + 'img'] ||
    target['foaf:depiction'] || target[FOAF + 'depiction'] ||
    target['schema:image'] || target[SCHEMA + 'image'] ||
    target['image'] || null
  const picture = typeof pic === 'string' ? pic : (pic && pic['@id']) || null
  return { name: String(name || hostLabel(webId)), picture }
}

// --- plaza container ---

async function ensurePlaza(plazaUrl) {
  // HEAD; if 404, create container via LDP POST.
  const r = await authFetch(plazaUrl, { method: 'HEAD' })
  if (r.ok) return
  if (r.status !== 404) throw new Error(`HEAD plaza: ${r.status}`)
  // Need login to create
  if (!meWebId()) throw new Error('login required to create the plaza container')
  const parent = plazaUrl.replace(/[^\/]+\/?$/, '')
  const slug = plazaUrl.split('/').filter(Boolean).pop()
  const c = await authFetch(parent, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/turtle',
      'Slug': slug,
      'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"'
    },
    body: ''
  })
  if (!c.ok) throw new Error(`create plaza: ${c.status}`)
}

async function loadMessages() {
  const r = await authFetch(state.plazaUrl, { headers: { Accept: 'application/ld+json' } })
  if (!r.ok) {
    // 404 means the plaza container doesn't exist yet — that's a resting
    // state, not an error. The empty-state UI explains the next move
    // (log in + post creates the container via ensurePlaza on first PUT).
    if (r.status === 404) return []
    throw new Error(`load plaza: ${r.status}`)
  }
  const doc = await r.json()
  const contains = doc['ldp:contains'] || doc['http://www.w3.org/ns/ldp#contains'] || doc['contains'] || []
  const arr = Array.isArray(contains) ? contains : [contains]
  const urls = arr
    .map(x => typeof x === 'string' ? x : x['@id'])
    .filter(Boolean)
    .filter(u => /\/[0-9]+-[a-z0-9]+\.jsonld$/.test(u))   // our message naming
  // Fetch in parallel, then sort by created
  const msgs = await Promise.all(urls.map(fetchMessage))
  return msgs
    .filter(Boolean)
    .sort((a, b) => a.dateCreated - b.dateCreated)
}

async function fetchMessage(url) {
  try {
    const r = await authFetch(url, { headers: { Accept: 'application/ld+json' } })
    if (!r.ok) return null
    const doc = await r.json()
    return parseMessage(doc, url)
  } catch { return null }
}

function parseMessage(doc, url) {
  const node = doc['@graph'] ? (Array.isArray(doc['@graph']) ? doc['@graph'][0] : doc['@graph']) : doc
  if (!node) return null
  const text =
    node['schema:text'] || node[SCHEMA + 'text'] ||
    node['text'] || ''
  const created =
    node['schema:dateCreated'] || node[SCHEMA + 'dateCreated'] ||
    node['dateCreated'] || null
  const sender =
    (node['schema:sender'] && (node['schema:sender']['@id'] || node['schema:sender'])) ||
    (node[SCHEMA + 'sender'] && (node[SCHEMA + 'sender']['@id'] || node[SCHEMA + 'sender'])) ||
    node['sender'] || null
  if (!text || !created) return null
  return {
    url,
    text: String(text),
    sender: typeof sender === 'string' ? sender : sender?.['@id'] || null,
    dateCreated: new Date(created)
  }
}

async function sendMessage(text) {
  text = text.trim()
  if (!text) return
  if (!meWebId()) throw new Error('login required to post')
  const ts = Date.now()
  const rand = Math.random().toString(36).slice(2, 8)
  const filename = `${ts}-${rand}.jsonld`
  const url = state.plazaUrl + filename
  const doc = {
    '@context': { schema: SCHEMA },
    '@id': '',
    '@type': 'schema:Message',
    'schema:text': text,
    'schema:dateCreated': new Date(ts).toISOString(),
    'schema:sender': { '@id': meWebId() }
  }
  const r = await authFetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/ld+json' },
    body: JSON.stringify(doc)
  })
  if (!r.ok) {
    let detail = ''
    try { detail = (await r.text()).slice(0, 200) } catch {}
    throw new Error(`HTTP ${r.status}${detail ? ' — ' + detail : ''}`)
  }
  // Optimistic insert (subscription will eventually deliver same message; dedupe by URL)
  const local = parseMessage(doc, url)
  if (local) insertMessage(local)
}

function insertMessage(msg) {
  if (!msg || state.byUrl.has(msg.url)) return
  // Binary insert by dateCreated to keep order
  const arr = state.messages
  let lo = 0, hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid].dateCreated <= msg.dateCreated) lo = mid + 1
    else hi = mid
  }
  arr.splice(lo, 0, msg)
  state.byUrl.set(msg.url, msg)
  renderThread()
}

function removeMessage(url) {
  if (!state.byUrl.has(url)) return
  state.messages = state.messages.filter(m => m.url !== url)
  state.byUrl.delete(url)
  renderThread()
}

// --- rendering ---

function renderThread() {
  const listEl = document.getElementById('messages')
  const emptyEl = document.getElementById('thread-empty')
  emptyEl.hidden = state.messages.length > 0
  if (!emptyEl.hidden) updateEmptyState()
  document.getElementById('room-count').textContent =
    `${state.messages.length} message${state.messages.length === 1 ? '' : 's'}`

  // Re-render from scratch — keep it simple; messages are small
  const prevScroll = listEl.scrollHeight - listEl.scrollTop
  const me = meWebId()
  let lastDayKey = null
  const frag = document.createDocumentFragment()
  for (const msg of state.messages) {
    const k = dayKey(msg.dateCreated)
    if (k !== lastDayKey) {
      const sep = document.createElement('li')
      sep.className = 'date-divider'
      sep.textContent = formatDateDivider(msg.dateCreated)
      frag.appendChild(sep)
      lastDayKey = k
    }
    const li = document.createElement('li')
    li.className = 'msg' + (msg.sender === me ? ' mine' : '')
    li.dataset.url = msg.url
    li.innerHTML = `
      <span class="msg-avatar"></span>
      <div class="msg-body">
        <div class="msg-head">
          <a class="msg-author" href="${escapeHtml(msg.sender || '#')}" target="_blank" rel="noopener noreferrer"></a>
          <span class="msg-time">${formatTime(msg.dateCreated)}</span>
        </div>
        <div class="msg-text"></div>
      </div>
    `
    li.querySelector('.msg-text').innerHTML = renderText(msg.text)
    // Async fill avatar + author name from profile
    fillSender(li, msg.sender)
    frag.appendChild(li)
  }
  listEl.innerHTML = ''
  listEl.appendChild(frag)
  if (state.scrollPinned) {
    listEl.scrollTop = listEl.scrollHeight
  } else {
    listEl.scrollTop = listEl.scrollHeight - prevScroll
  }
}

async function fillSender(li, webId) {
  const avEl = li.querySelector('.msg-avatar')
  const auEl = li.querySelector('.msg-author')
  if (!webId) {
    avEl.textContent = '?'
    auEl.textContent = 'unknown'
    return
  }
  // Show host-derived stub immediately so layout doesn't jump
  auEl.textContent = hostLabel(webId)
  avEl.textContent = initials(hostLabel(webId))
  const profile = await fetchProfile(webId)
  if (!profile) return
  auEl.textContent = profile.name
  if (profile.picture) {
    avEl.innerHTML = `<img alt="" src="${escapeHtml(profile.picture)}" referrerpolicy="no-referrer">`
  } else {
    avEl.textContent = initials(profile.name)
  }
}

// --- real-time: JSS /.notifications WebSocket ---

function setStatus(state_) {
  const el = document.getElementById('ws-status')
  el.className = 'status-dot ' + state_
  el.title = state_ === 'live' ? 'live'
           : state_ === 'connecting' ? 'connecting…'
           : 'disconnected'
}

function openSubscription() {
  if (state.ws) {
    try { state.ws.close() } catch {}
    state.ws = null
  }
  const url = new URL(state.plazaUrl)
  const wsUrl = (url.protocol === 'https:' ? 'wss://' : 'ws://') + url.host + '/.notifications'
  setStatus('connecting')
  let ws
  try { ws = new WebSocket(wsUrl) } catch (e) {
    setStatus('error')
    return
  }
  state.ws = ws
  ws.addEventListener('open', () => {
    // JSS subscribe: send 'sub <url>' (no Sec-WebSocket-Protocol needed)
    try { ws.send('sub ' + state.plazaUrl) } catch {}
    setStatus('live')
  })
  ws.addEventListener('message', async (ev) => {
    // JSS sends 'pub <url>' on changes to subscribed resource
    const data = String(ev.data || '')
    if (!data.startsWith('pub ')) return
    // The plaza container changed — diff against current set
    await reconcile()
  })
  ws.addEventListener('close', () => {
    setStatus('error')
    state.ws = null
    // Reconnect with backoff
    setTimeout(openSubscription, 2500)
  })
  ws.addEventListener('error', () => {
    setStatus('error')
  })
}

async function reconcile() {
  try {
    const fresh = await loadMessages()
    const freshUrls = new Set(fresh.map(m => m.url))
    // Remove ones that disappeared
    for (const url of [...state.byUrl.keys()]) {
      if (!freshUrls.has(url)) removeMessage(url)
    }
    // Insert ones that are new
    for (const m of fresh) if (!state.byUrl.has(m.url)) insertMessage(m)
  } catch {}
}

// --- UI wiring ---

function bindComposer() {
  const inp = document.getElementById('composer-input')
  const btn = document.getElementById('composer-send')
  const refresh = () => { btn.disabled = !inp.value.trim() || !meWebId() }
  inp.addEventListener('input', () => {
    refresh()
    // Auto-grow up to max-height
    inp.style.height = 'auto'
    inp.style.height = Math.min(inp.scrollHeight, 140) + 'px'
  })
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  })
  btn.addEventListener('click', submit)
  async function submit() {
    if (btn.disabled) return
    const text = inp.value
    inp.value = ''
    inp.style.height = 'auto'
    refresh()
    try {
      await sendMessage(text)
    } catch (e) {
      showToast(`Couldn't send: ${e.message}`, 5000)
      // Put the text back so they don't lose it
      inp.value = text
      refresh()
    }
  }
  refresh()
}

function bindScroll() {
  const listEl = document.getElementById('messages')
  listEl.addEventListener('scroll', () => {
    const nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 60
    state.scrollPinned = nearBottom
  })
}

// --- identity / pod discovery ---

function renderIdentity() {
  const pill = document.getElementById('topbar-id')
  const id = meWebId()
  if (id) {
    let label
    if (id.startsWith('http')) { try { label = new URL(id).host } catch { label = id } }
    else label = id.length > 16 ? id.slice(0, 8) + '…' + id.slice(-4) : id
    pill.textContent = label
    pill.hidden = false
  } else {
    pill.hidden = true
  }
  // Refresh send-button enabled state
  const inp = document.getElementById('composer-input')
  document.getElementById('composer-send').disabled = !inp.value.trim() || !id
  // Re-evaluate empty-state copy when login changes
  updateEmptyState()
}

function updateEmptyState() {
  const title = document.getElementById('empty-title')
  const body = document.getElementById('empty-body')
  if (!title || !body) return
  const loggedIn = !!meWebId()
  const host = (() => {
    try { return new URL(state.plazaUrl || '').host } catch { return 'this pod' }
  })()
  if (loggedIn) {
    title.textContent = 'Welcome to plaza.'
    body.textContent = `No messages yet on ${host}. Write something below to start the conversation.`
  } else {
    title.textContent = 'Welcome to plaza.'
    body.textContent = `Log in (top-right) to start the plaza on ${host}. Once posted, anyone with read access here can follow along.`
  }
}

function watchLogin() {
  let last = meWebId()
  setInterval(() => {
    const now = meWebId()
    if (now !== last) {
      const prevPod = podFromWebId(last)
      const nextPod = podFromWebId(now)
      last = now
      renderIdentity()
      // If logging in unlocks a pod that matches ?pod= (or our default), switch to it
      if (now && !state.podOrigin) bootForPod(nextPod)
    }
  }, 400)
}

// --- toast ---

let toastTimer = null
function showToast(message, duration = 4000) {
  if (!message) return
  const el = document.getElementById('toast')
  document.getElementById('toast-msg').textContent = message
  el.hidden = false
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(hideToast, duration)
}
function hideToast() {
  document.getElementById('toast').hidden = true
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null }
}

// --- boot ---

function defaultPod() {
  // If served from a localhost origin (e.g. JSS hosting plaza at /apps/plaza),
  // use that origin so the pod port matches. Otherwise canonical local dev port.
  try {
    const loc = window.location
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(loc.host)) {
      return `${loc.protocol}//${loc.host}`
    }
  } catch {}
  return 'http://localhost:4443'
}

function pickPodOrigin() {
  // Priority: ?pod= → localStorage → own WebID's pod → defaultPod()
  try {
    const p = new URLSearchParams(location.search).get('pod')
    if (p) return p
  } catch {}
  try {
    const cached = localStorage.getItem(LS_LAST_POD)
    if (cached) return cached
  } catch {}
  const me = meWebId()
  if (me) {
    const own = podFromWebId(me)
    if (own) return own
  }
  return defaultPod()
}

async function bootForPod(origin) {
  if (!origin) return
  state.podOrigin = origin
  state.plazaUrl = origin + PLAZA_PATH
  try { localStorage.setItem(LS_LAST_POD, origin) } catch {}
  document.getElementById('room-host').textContent = state.plazaUrl

  try {
    const msgs = await loadMessages()
    state.messages = msgs
    state.byUrl = new Map(msgs.map(m => [m.url, m]))
    renderThread()
  } catch (e) {
    showToast(`Couldn't load plaza: ${e.message}`, 6000)
  }
  // Make sure empty-state copy interpolates the now-known host even if
  // there were zero messages and renderThread didn't recompute it.
  updateEmptyState()
  openSubscription()
}

function init() {
  bindComposer()
  bindScroll()
  renderIdentity()
  watchLogin()
  document.getElementById('toast-close').addEventListener('click', hideToast)
  bootForPod(pickPodOrigin())
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
