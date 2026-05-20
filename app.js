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
  profiles: new Map(),    // webId → { name, picture, bio } (lazy)
  plazaOwner: null,       // owner's WebID (resolved from the pod profile)
  plazaOwnerProfile: null,// { name, picture, bio } for the pod owner
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
  if (!target) return { name: hostLabel(webId), picture: null, bio: null }
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
  const bio =
    target['schema:description'] || target[SCHEMA + 'description'] ||
    target['description'] || target['foaf:bio'] || target[FOAF + 'bio'] || null
  return {
    name: String(name || hostLabel(webId)),
    picture,
    bio: typeof bio === 'string' ? bio : null
  }
}

async function discoverPlazaOwner(origin) {
  if (!origin) return null
  const guess = origin.replace(/\/$/, '') + '/profile/card.jsonld#me'
  try {
    const r = await fetch(guess.split('#')[0], { headers: { Accept: 'application/ld+json' } })
    if (r.ok) return guess
  } catch {}
  return null
}

function renderMasthead() {
  const nameEl = document.getElementById('brand-name')
  const subEl = document.getElementById('sub')
  const markEl = document.getElementById('brand-mark')
  if (!nameEl || !subEl || !markEl) return
  const p = state.plazaOwnerProfile
  if (p?.name) {
    const ending = p.name.endsWith('s') ? "'" : "'s"
    nameEl.textContent = p.name + ending + ' plaza'
    subEl.textContent = p.bio || 'group chat on the open web'
    if (p.picture) {
      markEl.innerHTML = `<img alt="" src="${escapeHtml(p.picture)}" referrerpolicy="no-referrer">`
      markEl.classList.add('has-picture')
    } else {
      markEl.textContent = (p.name[0] || '▣').toUpperCase()
      markEl.classList.remove('has-picture')
    }
    document.title = `${p.name}'s plaza`
  } else {
    nameEl.textContent = 'plaza'
    subEl.textContent = 'group chat on the open web'
    markEl.textContent = '▣'
    markEl.classList.remove('has-picture')
    document.title = 'plaza'
  }
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

// --- "Open chat" toggle ---
//
// When the pod owner opens the plaza to guests, we write a WAC ACL on
// /public/plaza/ granting:
//   - owner: full Read/Write/Control
//   - foaf:Agent (anyone): Read — visitors see the conversation
//   - acl:AuthenticatedAgent: Append — logged-in users from any pod can
//     ADD messages but can't modify or delete other people's
//
// Closing removes the ACL and the container falls back to its parent's
// defaults (typically owner-only).

const ACL_NS = 'http://www.w3.org/ns/auth/acl#'
const FOAF_AGENT = 'http://xmlns.com/foaf/0.1/Agent'

function plazaAclUrl() {
  return state.plazaUrl + '.acl'
}

function isPlazaOwner() {
  const me = meWebId()
  if (!me) return false
  const myPod = podFromWebId(me)
  return !!myPod && myPod === state.podOrigin
}

async function chatIsOpen() {
  try {
    const r = await authFetch(plazaAclUrl(), { headers: { Accept: 'application/ld+json' } })
    if (!r.ok) return false
    const doc = await r.json()
    const nodes = doc['@graph']
      ? (Array.isArray(doc['@graph']) ? doc['@graph'] : [doc['@graph']])
      : [doc]
    return nodes.some(n => {
      const types = [].concat(n['@type'] || [])
      if (!types.some(t => t === 'acl:Authorization' || t === ACL_NS + 'Authorization')) return false
      const cls = []
        .concat(n['acl:agentClass'] || [])
        .concat(n[ACL_NS + 'agentClass'] || [])
        .map(x => typeof x === 'string' ? x : x?.['@id'])
        .filter(Boolean)
      const hasAuthClass = cls.some(c =>
        c === 'acl:AuthenticatedAgent' || c === ACL_NS + 'AuthenticatedAgent')
      if (!hasAuthClass) return false
      const modes = []
        .concat(n['acl:mode'] || [])
        .concat(n[ACL_NS + 'mode'] || [])
        .map(x => typeof x === 'string' ? x : x?.['@id'])
        .filter(Boolean)
      return modes.some(m =>
        m === 'acl:Append' || m === ACL_NS + 'Append' ||
        m === 'acl:Write'  || m === ACL_NS + 'Write')
    })
  } catch { return false }
}

async function openChat() {
  if (!meWebId()) throw new Error('login required')
  await ensurePlaza(state.plazaUrl)
  const acl = {
    '@context': { acl: ACL_NS },
    '@graph': [
      {
        '@id': '#owner',
        '@type': 'acl:Authorization',
        'acl:accessTo': { '@id': state.plazaUrl },
        'acl:default': { '@id': state.plazaUrl },
        'acl:agent': { '@id': meWebId() },
        'acl:mode': [
          { '@id': 'acl:Read' },
          { '@id': 'acl:Write' },
          { '@id': 'acl:Control' }
        ]
      },
      {
        '@id': '#anon-read',
        '@type': 'acl:Authorization',
        'acl:accessTo': { '@id': state.plazaUrl },
        'acl:default': { '@id': state.plazaUrl },
        'acl:agentClass': { '@id': FOAF_AGENT },
        'acl:mode': [{ '@id': 'acl:Read' }]
      },
      {
        '@id': '#auth-append',
        '@type': 'acl:Authorization',
        'acl:accessTo': { '@id': state.plazaUrl },
        'acl:default': { '@id': state.plazaUrl },
        'acl:agentClass': { '@id': ACL_NS + 'AuthenticatedAgent' },
        'acl:mode': [{ '@id': 'acl:Append' }]
      }
    ]
  }
  const r = await authFetch(plazaAclUrl(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/ld+json' },
    body: JSON.stringify(acl, null, 2)
  })
  if (!r.ok) {
    let detail = ''
    try { detail = (await r.text()).slice(0, 200) } catch {}
    throw new Error(`open chat: ${r.status}${detail ? ' — ' + detail : ''}`)
  }
}

async function closeChat() {
  if (!meWebId()) throw new Error('login required')
  const r = await authFetch(plazaAclUrl(), { method: 'DELETE' })
  if (!r.ok && r.status !== 404) {
    let detail = ''
    try { detail = (await r.text()).slice(0, 200) } catch {}
    throw new Error(`close chat: ${r.status}${detail ? ' — ' + detail : ''}`)
  }
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
  const slug = `${ts}-${rand}.jsonld`
  const doc = {
    '@context': { schema: SCHEMA },
    '@id': '',
    '@type': 'schema:Message',
    'schema:text': text,
    'schema:dateCreated': new Date(ts).toISOString(),
    'schema:sender': { '@id': meWebId() }
  }
  // POST to the container (not PUT to a specific URL) so that
  // acl:Append permission is enough — required for guests in any
  // pod that has opened its plaza to authenticated visitors.
  const r = await authFetch(state.plazaUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/ld+json',
      'Slug': slug
    },
    body: JSON.stringify(doc)
  })
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) {
      throw new Error("Couldn't post — the host of this plaza hasn't opened it to guests.")
    }
    let detail = ''
    try { detail = (await r.text()).slice(0, 200) } catch {}
    throw new Error(`HTTP ${r.status}${detail ? ' — ' + detail : ''}`)
  }
  const loc = r.headers.get('Location') || r.headers.get('location')
  const url = loc
    ? new URL(loc, state.plazaUrl).toString()
    : state.plazaUrl + slug
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
          <a class="msg-time" href="${escapeHtml(msg.url)}" target="_blank" rel="noopener noreferrer" title="Open the JSON-LD resource for this message">${formatTime(msg.dateCreated)}</a>
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

let _topbarIdBound = false
function renderIdentity() {
  const pill = document.getElementById('topbar-id')
  const id = meWebId()
  if (id) {
    let label
    if (id.startsWith('http')) {
      try { label = new URL(id).hostname.split('.')[0] + '.' } catch { label = id }
    } else {
      label = id.length > 12 ? id.slice(0, 6) + '…' + id.slice(-4) : id
    }
    pill.textContent = label
    pill.title = 'Click to log out'
  } else {
    pill.textContent = 'Log in'
    pill.title = 'Click to log in'
  }
  pill.hidden = false
  if (!_topbarIdBound) {
    _topbarIdBound = true
    pill.addEventListener('click', () => {
      if (meWebId()) window.xlogin?.logout?.()
      else window.xlogin?.login?.()
    })
  }
  // Refresh send-button enabled state
  const inp = document.getElementById('composer-input')
  document.getElementById('composer-send').disabled = !inp.value.trim() || !id
  // Re-evaluate empty-state copy when login changes
  updateEmptyState()
  // Re-evaluate the owner-only chat toggle (visibility + current state)
  renderChatToggle()
}

let _chatToggleBound = false
async function renderChatToggle() {
  const btn = document.getElementById('room-toggle')
  if (!btn) return
  if (!isPlazaOwner() || !state.plazaUrl) {
    btn.hidden = true
    return
  }
  btn.hidden = false
  if (!_chatToggleBound) {
    _chatToggleBound = true
    btn.addEventListener('click', async () => {
      if (btn.disabled) return
      const currentlyOpen = btn.dataset.open === '1'
      const next = !currentlyOpen
      btn.disabled = true
      btn.textContent = next ? 'Opening…' : 'Closing…'
      try {
        if (next) await openChat()
        else await closeChat()
        btn.dataset.open = next ? '1' : '0'
        btn.textContent = next ? 'Chat: open' : 'Chat: closed'
        showToast(next
          ? 'Chat opened — logged-in visitors can now post.'
          : 'Chat closed — only you can post here now.',
          3500)
      } catch (e) {
        btn.textContent = currentlyOpen ? 'Chat: open' : 'Chat: closed'
        showToast(e.message, 6000)
      } finally {
        btn.disabled = false
      }
    })
  }
  // Probe current state
  btn.textContent = 'Chat: …'
  try {
    const open = await chatIsOpen()
    btn.dataset.open = open ? '1' : '0'
    btn.textContent = open ? 'Chat: open' : 'Chat: closed'
  } catch {
    btn.dataset.open = '0'
    btn.textContent = 'Chat: closed'
  }
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
      last = now
      renderIdentity()
      // When login state changes, the right pod target may have changed
      // too. If the user is now logged in and their WebID-derived pod
      // differs from where we're pointed (e.g. localhost from the cache),
      // re-target onto the real pod. ?pod= still wins.
      const hasExplicitPodParam = (() => {
        try { return !!new URLSearchParams(location.search).get('pod') }
        catch { return false }
      })()
      if (now && !hasExplicitPodParam) {
        const ownPod = podFromWebId(now)
        if (ownPod && ownPod !== state.podOrigin) {
          try {
            const cached = localStorage.getItem(LS_LAST_POD)
            if (cached && cached !== ownPod) localStorage.removeItem(LS_LAST_POD)
          } catch {}
          bootForPod(ownPod)
        }
      } else if (now && !state.podOrigin) {
        bootForPod(podFromWebId(now))
      }
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
  // Priority: ?pod= → own WebID's pod (if logged in) → localStorage → defaultPod()
  //
  // WebID beats the cached value because the cache often holds a stale
  // localhost from dev that breaks mixed-content in production (the page
  // is HTTPS, the cached pod is HTTP localhost → ERR_BLOCKED_BY_CLIENT).
  try {
    const p = new URLSearchParams(location.search).get('pod')
    if (p) return p
  } catch {}
  const me = meWebId()
  if (me) {
    const own = podFromWebId(me)
    if (own) return own
  }
  try {
    const cached = localStorage.getItem(LS_LAST_POD)
    if (cached) return cached
  } catch {}
  return defaultPod()
}

async function bootForPod(origin) {
  if (!origin) return
  state.podOrigin = origin
  state.plazaUrl = origin + PLAZA_PATH
  state.plazaOwner = null
  state.plazaOwnerProfile = null
  renderMasthead()  // reset to defaults before discovery completes
  try { localStorage.setItem(LS_LAST_POD, origin) } catch {}
  document.getElementById('room-host').textContent = state.plazaUrl

  // Kick off pod-owner discovery in the background — the masthead
  // morphs into "alice's plaza" with her avatar once it resolves.
  discoverPlazaOwner(origin).then(async (webId) => {
    if (!webId || state.podOrigin !== origin) return
    state.plazaOwner = webId
    const profile = await fetchProfile(webId)
    if (state.podOrigin !== origin) return  // pod changed mid-flight
    state.plazaOwnerProfile = profile
    renderMasthead()
  })

  try {
    const msgs = await loadMessages()
    state.messages = msgs
    state.byUrl = new Map(msgs.map(m => [m.url, m]))
    renderThread()
    // If owner discovery failed but messages exist, infer the owner
    // from the first message's sender (they likely created the plaza).
    if (!state.plazaOwner && msgs.length > 0 && msgs[0].sender) {
      const guess = msgs[0].sender
      if (podFromWebId(guess) === origin) {
        state.plazaOwner = guess
        fetchProfile(guess).then(p => {
          if (state.podOrigin !== origin) return
          state.plazaOwnerProfile = p
          renderMasthead()
        })
      }
    }
  } catch (e) {
    showToast(`Couldn't load plaza: ${e.message}`, 6000)
  }
  // Make sure empty-state copy interpolates the now-known host even if
  // there were zero messages and renderThread didn't recompute it.
  updateEmptyState()
  // Show the owner-only chat-toggle button once we know which pod is
  // being viewed (pre-bootForPod, isPlazaOwner() can't return true).
  renderChatToggle()
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
