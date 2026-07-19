// ======================================================================
// BOT MANAGER — barcha botlarni BITTA joydan boshqarish (Express server)
//  - har bir botni start/stop/restart qilish (child process sifatida)
//  - har bir botning loggerType ini o'zgartirish (env orqali beriladi)
//  - holat (qaysi bot yoqilgan, loggerType) DATA_DIR/manager.state.json
//    fayliga saqlanadi — qayta deploy bo'lsa ham yo'qolmaydi
//  - / da oddiy web dashboard, /api/* da JSON API
//
// COOLIFY UCHUN MUHIM:
//  - Start Command: npm start  (yoki: node main.js)
//  - Persistent Storage (volume) qo'shing: konteyner ichida /app/data
//    (yoki DATA_DIR env bilan boshqa yo'l bering) — aks holda har deploy
//    da manager.state.json, glassFiller.state.json va loglar o'chib ketadi
//  - Env o'zgaruvchilar (.env git ga kirmaydi!): BOT_PASSWORD,
//    CRAFTER_USERNAME, FILLER_USERNAME, ADMIN_TOKEN
// ======================================================================
'use strict'
require('dotenv').config({ path: require('path').join(__dirname, '.env') })
const express = require('express')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { LOG_LEVELS } = require('./shared')

// Barcha doimiy ma'lumotlar shu papkada — Coolify da volume SHU yerga ulanadi
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
const LOG_DIR = path.join(DATA_DIR, 'logs')
const STATE_FILE = path.join(DATA_DIR, 'manager.state.json')
const PORT = Number(process.env.PORT) || 3000
// API himoyasi: so'rovlarda x-admin-token header (yoki ?token=) shu bilan
// bir xil bo'lishi kerak. Bo'sh qoldirilsa himoya O'CHIQ bo'ladi!
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''

const CONFIG = {
    maxLogLines: 400,           // har bot uchun xotirada saqlanadigan oxirgi log qatorlari
    logFileMaxBytes: 5 * 1024 * 1024, // log fayl shu hajmdan oshsa .old ga aylantiriladi
    restartBaseMs: 5000,        // crash dan keyin birinchi qayta ishga tushirish kutishi
    restartMaxMs: 120000,       // backoff shu qiymatgacha oshadi
    stableUptimeMs: 5 * 60 * 1000, // shuncha ishlagan bo'lsa backoff qayta boshidan
    killTimeoutMs: 8000,        // SIGTERM dan keyin shu vaqtda o'lmasa SIGKILL
    autoStartStaggerMs: 3000,   // yoqilgan botlar ketma-ket shu oraliq bilan start bo'ladi
}

// ======================= BOTLAR RO'YXATI =======================
// Yangi bot qo'shish uchun shu yerga yozing: script — fayl nomi,
// loggerEnv — botga loggerType shu env orqali uzatiladi
const BOT_DEFS = {
    crafter: {
        script: 'crafter.js',
        loggerEnv: 'CRAFTER_LOGGER_TYPE',
        accountEnv: 'CRAFTER_USERNAME', // qaysi env dagi akkaunt bilan kiradi
        title: 'Crafter — glass_bottle craft qiladi',
    },
    filler: {
        script: 'glassFiller.js',
        loggerEnv: 'FILLER_LOGGER_TYPE',
        accountEnv: 'FILLER_USERNAME',
        title: 'Glass Filler — orollarga bottle tarqatadi',
    },
    asalfarm: {
        script: 'asalfarm.js',
        loggerEnv: 'ASALFARM_LOGGER_TYPE',
        title: 'Asal Farm — 11 ta bot (asalFarm_N1-6, KH_BOT_N1-5)',
    },
}

// Bir xil Minecraft akkauntini ishlatadigan ikki bot bir vaqtda ulansa,
// server birini kick qiladi va ular bir-birini cheksiz chiqarib yuboradi.
// (Hozir .env da crafter va filler bitta akkauntda.) Shu holat ish
// boshlanishidan OLDIN ushlanadi — aniq xabar bilan rad etiladi.
function accountConflict(name) {
    const envKey = BOT_DEFS[name].accountEnv
    const user = envKey && process.env[envKey]
    if (!user) return null
    for (const other of Object.keys(BOT_DEFS)) {
        if (other === name || !isRunning(other)) continue
        const otherKey = BOT_DEFS[other].accountEnv
        if (otherKey && process.env[otherKey] === user) return other
    }
    return null
}

fs.mkdirSync(LOG_DIR, { recursive: true })

// ======================= HOLAT (persist) =======================
// Birinchi ishga tushirishda (state fayl hali yo'q bo'lsa) qaysi botlar
// yoqiq bo'ladi. filler default O'CHIQ — u crafter bilan BITTA akkauntda
// (.env da bir xil username), ikkalasi birga ulansa biri kickka uchraydi.
const DEFAULT_ENABLED = { crafter: true, filler: false, asalfarm: true }
// { bots: { crafter: { enabled: true, loggerType: 'muhim' }, ... } }
function defaultState() {
    const bots = {}
    for (const [name, def] of Object.entries(BOT_DEFS)) {
        bots[name] = {
            enabled: !!DEFAULT_ENABLED[name],
            loggerType: process.env[def.loggerEnv] || 'muhim',
        }
    }
    return { bots }
}
function loadState() {
    const state = defaultState()
    try {
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
        // faqat ro'yxatda bor botlar olinadi — eski/ortiqcha yozuvlar tashlanadi
        for (const name of Object.keys(BOT_DEFS)) {
            const saved = raw && raw.bots && raw.bots[name]
            if (!saved) continue
            if (typeof saved.enabled === 'boolean') state.bots[name].enabled = saved.enabled
            if (LOG_LEVELS[saved.loggerType] !== undefined) state.bots[name].loggerType = saved.loggerType
        }
    } catch (e) {
        // fayl yo'q (birinchi ishga tushirish) — default bilan davom etamiz
    }
    return state
}
function saveState() {
    // atomik yozish: avval .tmp ga, keyin rename — yozish paytida o'chib
    // qolsa ham state fayl buzilmaydi
    const tmp = STATE_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
    fs.renameSync(tmp, STATE_FILE)
}
const state = loadState()
saveState() // yangi qo'shilgan botlar default qiymatlari bilan faylga tushsin

// ======================= RUNTIME =======================
const runtime = {}
for (const name of Object.keys(BOT_DEFS)) {
    runtime[name] = {
        proc: null,
        startedAt: 0,
        restarts: 0,          // manager tomonidan avtomatik qayta ishga tushirishlar
        backoffMs: CONFIG.restartBaseMs,
        restartTimer: null,   // rejalashtirilgan avto-restart
        killTimer: null,      // SIGKILL zaxira timeri
        stopping: false,      // SIGTERM yuborilgan, jarayon o'lishi kutilyapti
        logs: [],             // oxirgi log qatorlari (ring buffer)
        lastExit: null,       // { code, signal, at }
    }
}
let shuttingDown = false

function now() { return Date.now() }
function ts() {
    return new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Tashkent', hour12: false })
}

// Bot chiqargan (yoki manager yozgan) har bir qatorni xotira ring bufferiga
// va DATA_DIR/logs/<bot>.log fayliga qo'shadi
function pushLog(name, text) {
    const rt = runtime[name]
    const lines = String(text).split('\n')
    const out = []
    for (const line of lines) {
        const trimmed = line.trimEnd()
        if (!trimmed) continue
        const entry = `[${ts()}] ${trimmed}`
        rt.logs.push(entry)
        out.push(entry)
    }
    if (rt.logs.length > CONFIG.maxLogLines) rt.logs.splice(0, rt.logs.length - CONFIG.maxLogLines)
    if (!out.length) return
    const file = path.join(LOG_DIR, name + '.log')
    try {
        // hajm oshib ketsa eski faylni .old ga suramiz (bitta zaxira yetadi)
        try {
            if (fs.statSync(file).size > CONFIG.logFileMaxBytes) fs.renameSync(file, file + '.old')
        } catch (e) { /* fayl hali yo'q */ }
        fs.appendFileSync(file, out.join('\n') + '\n')
    } catch (e) {
        console.log(`[manager] ${name} log fayliga yozib bo'lmadi: ${e.message}`)
    }
}
function managerLog(name, msg) {
    console.log(`[manager] [${name}] ${msg}`)
    pushLog(name, `--- MANAGER: ${msg} ---`)
}

function isRunning(name) {
    return runtime[name].proc !== null
}

function startBot(name) {
    const rt = runtime[name]
    const def = BOT_DEFS[name]
    if (shuttingDown) return { ok: false, error: 'server o\'chirilmoqda' }
    if (rt.proc) return { ok: false, error: 'allaqachon ishlab turibdi' }
    const conflict = accountConflict(name)
    if (conflict) {
        managerLog(name, `ishga tushirilmadi: "${conflict}" bilan bitta akkaunt — avval uni to'xtating`)
        return { ok: false, error: `"${conflict}" bilan bitta Minecraft akkaunt ishlatadi — avval uni to'xtating` }
    }
    if (rt.restartTimer) { clearTimeout(rt.restartTimer); rt.restartTimer = null }

    const env = { ...process.env, [def.loggerEnv]: state.bots[name].loggerType }
    const proc = spawn(process.execPath, [path.join(__dirname, def.script)], {
        cwd: __dirname,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    rt.proc = proc
    rt.startedAt = now()
    managerLog(name, `ishga tushirildi (pid ${proc.pid}, loggerType=${state.bots[name].loggerType})`)

    proc.stdout.on('data', d => pushLog(name, d))
    proc.stderr.on('data', d => pushLog(name, d))

    // 'error' (masalan spawn muvaffaqiyatsiz) va 'exit' ikkalasi ham kelishi
    // mumkin — bitta o'lim uchun faqat bitta ishlov
    let exitHandled = false
    const onDeath = (code, signal) => {
        if (exitHandled) return
        exitHandled = true
        const uptime = now() - rt.startedAt
        rt.proc = null
        rt.stopping = false
        rt.lastExit = { code, signal, at: now() }
        if (rt.killTimer) { clearTimeout(rt.killTimer); rt.killTimer = null }
        managerLog(name, `to'xtadi (code=${code}, signal=${signal}, uptime=${Math.round(uptime / 1000)}s)`)
        if (shuttingDown) return
        // foydalanuvchi o'chirmagan bo'lsa — avtomatik qayta ko'taramiz
        if (state.bots[name].enabled) {
            // uzoq barqaror ishlagan bo'lsa backoff qaytadan boshlanadi
            if (uptime > CONFIG.stableUptimeMs) rt.backoffMs = CONFIG.restartBaseMs
            const delay = rt.backoffMs
            rt.backoffMs = Math.min(rt.backoffMs * 2, CONFIG.restartMaxMs)
            rt.restarts++
            managerLog(name, `${Math.round(delay / 1000)}s dan keyin avtomatik qayta ishga tushadi`)
            rt.restartTimer = setTimeout(() => {
                rt.restartTimer = null
                if (state.bots[name].enabled && !rt.proc) startBot(name)
            }, delay)
        }
    }
    proc.on('exit', onDeath)
    proc.on('error', err => {
        managerLog(name, `process xatosi: ${err.message}`)
        onDeath(null, 'SPAWN_ERROR')
    })
    return { ok: true }
}

// Jarayonni o'ldirish: avval SIGTERM, o'lmasa killTimeoutMs dan keyin SIGKILL.
// Qayta chaqirilsa hech narsa qilmaydi (allaqachon to'xtatilmoqda) — shuning
// uchun API tugmalarini istalgan tartibda/tezlikda bosish xato chiqarmaydi
function killProc(name) {
    const rt = runtime[name]
    if (!rt.proc || rt.stopping) return
    rt.stopping = true
    const proc = rt.proc
    proc.kill('SIGTERM')
    rt.killTimer = setTimeout(() => {
        rt.killTimer = null
        try { proc.kill('SIGKILL') } catch (e) { /* allaqachon o'lgan */ }
    }, CONFIG.killTimeoutMs)
}

// ======================= API AMALLAR =======================
// Barcha amallar IDEMPOTENT: bot qaysi holatda bo'lsa ham (ishlayapti,
// to'xtayapti, restart kutyapti, o'chiq) xato emas — kerakli natijaga
// olib boradi va note bilan tushuntiradi
function apiStart(name) {
    const rt = runtime[name]
    // to'qnashuvda botni "yoqilgan" deb saqlamaymiz — foydalanuvchi avval
    // ikkinchi botni to'xtatib, keyin qayta Start bosadi
    if (!rt.proc) {
        const conflict = accountConflict(name)
        if (conflict) return { ok: false, error: `"${conflict}" bilan bitta Minecraft akkaunt ishlatadi — avval uni to'xtating` }
    }
    state.bots[name].enabled = true
    saveState()
    if (rt.proc) {
        if (rt.stopping) {
            // to'xtash jarayonida — o'lgach exit handler enabled=true ni
            // ko'rib o'zi qayta ko'taradi, tez bo'lishi uchun backoff kichik
            rt.backoffMs = 1000
            return { ok: true, note: 'to\'xtatilayotgan edi — to\'xtagach avtomatik qayta ishga tushadi' }
        }
        return { ok: true, note: 'allaqachon ishlab turibdi' }
    }
    rt.backoffMs = CONFIG.restartBaseMs
    return startBot(name)
}
function apiStop(name) {
    const rt = runtime[name]
    state.bots[name].enabled = false
    saveState()
    if (rt.restartTimer) { clearTimeout(rt.restartTimer); rt.restartTimer = null }
    if (!rt.proc) return { ok: true, note: 'ishlab turgani yo\'q edi, endi avto-start ham qilinmaydi' }
    if (rt.stopping) return { ok: true, note: 'allaqachon to\'xtatilmoqda' }
    killProc(name)
    return { ok: true, note: 'to\'xtatilmoqda...' }
}
function apiRestart(name) {
    const rt = runtime[name]
    if (!rt.proc) {
        const conflict = accountConflict(name)
        if (conflict) return { ok: false, error: `"${conflict}" bilan bitta Minecraft akkaunt ishlatadi — avval uni to'xtating` }
    }
    state.bots[name].enabled = true
    saveState()
    rt.backoffMs = 1000 // restart tez bo'lsin, backoff kutmasin
    if (rt.proc) {
        killProc(name) // enabled=true bo'lgani uchun exit handler o'zi qayta ko'taradi
        return { ok: true, note: 'to\'xtatilyapti, o\'zi qayta ishga tushadi' }
    }
    return startBot(name)
}
function apiSetLogger(name, loggerType) {
    const rt = runtime[name]
    if (LOG_LEVELS[loggerType] === undefined) {
        return { ok: false, error: `noto'g'ri loggerType — bo'lishi mumkin: ${Object.keys(LOG_LEVELS).join(', ')}` }
    }
    state.bots[name].loggerType = loggerType
    saveState()
    // bot env ni faqat ishga tushishda o'qiydi — yangi qiymat ishlashi uchun
    // ishlab turgan botni qayta ishga tushiramiz
    if (rt.proc) {
        rt.backoffMs = 1000
        killProc(name)
        return { ok: true, note: 'loggerType saqlandi, bot yangi qiymat bilan qayta ishga tushmoqda' }
    }
    return { ok: true, note: 'loggerType saqlandi, keyingi start da ishlatiladi' }
}

function statusOf(name) {
    const rt = runtime[name]
    return {
        name,
        title: BOT_DEFS[name].title,
        script: BOT_DEFS[name].script,
        enabled: state.bots[name].enabled,
        loggerType: state.bots[name].loggerType,
        running: isRunning(name),
        stopping: rt.stopping,
        pid: rt.proc ? rt.proc.pid : null,
        uptimeMs: rt.proc ? now() - rt.startedAt : 0,
        restarts: rt.restarts,
        lastExit: rt.lastExit,
        restartPending: rt.restartTimer !== null,
    }
}

// ======================= EXPRESS =======================
const app = express()
app.use(express.json())

// Coolify healthcheck uchun — token talab qilmaydi
app.get('/health', (req, res) => res.json({ ok: true }))

// /api/* himoyasi
app.use('/api', (req, res, next) => {
    if (!ADMIN_TOKEN) return next()
    const given = req.get('x-admin-token') || req.query.token
    if (given === ADMIN_TOKEN) return next()
    res.status(401).json({ ok: false, error: 'token noto\'g\'ri (x-admin-token header yoki ?token=)' })
})
// Hammasini birdan to'xtatish — :name middleware'idan OLDIN turishi shart,
// aks holda "all" bot nomi sifatida qidirilib 404 bo'lardi
app.post('/api/bots/all/stop', (req, res) => {
    for (const name of Object.keys(BOT_DEFS)) apiStop(name)
    res.json({ ok: true, note: 'barcha botlar to\'xtatilmoqda', bots: Object.keys(BOT_DEFS).map(statusOf) })
})

// :name parametrini tekshirish
app.use('/api/bots/:name', (req, res, next) => {
    if (!BOT_DEFS[req.params.name]) {
        return res.status(404).json({ ok: false, error: `bunday bot yo'q: ${req.params.name}` })
    }
    next()
})

app.get('/api/bots', (req, res) => {
    res.json({ ok: true, bots: Object.keys(BOT_DEFS).map(statusOf) })
})
app.get('/api/bots/:name', (req, res) => {
    res.json({ ok: true, bot: statusOf(req.params.name) })
})
app.post('/api/bots/:name/start', (req, res) => {
    const r = apiStart(req.params.name)
    res.status(r.ok ? 200 : 409).json({ ...r, bot: statusOf(req.params.name) })
})
app.post('/api/bots/:name/stop', (req, res) => {
    const r = apiStop(req.params.name)
    res.json({ ...r, bot: statusOf(req.params.name) })
})
app.post('/api/bots/:name/restart', (req, res) => {
    const r = apiRestart(req.params.name)
    res.status(r.ok ? 200 : 409).json({ ...r, bot: statusOf(req.params.name) })
})
app.post('/api/bots/:name/logger', (req, res) => {
    const r = apiSetLogger(req.params.name, req.body && req.body.loggerType)
    res.status(r.ok ? 200 : 400).json({ ...r, bot: statusOf(req.params.name) })
})
app.get('/api/bots/:name/logs', (req, res) => {
    const n = Math.min(Number(req.query.lines) || 100, CONFIG.maxLogLines)
    const logs = runtime[req.params.name].logs
    res.json({ ok: true, lines: logs.slice(-n) })
})

// ======================= DASHBOARD =======================
app.get('/', (req, res) => {
    res.type('html').send(DASHBOARD_HTML)
})

const DASHBOARD_HTML = `<!doctype html>
<html lang="uz">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GlassBots Manager</title>
<style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 16px; background: #101418; color: #d8dee6; font: 14px/1.5 system-ui, sans-serif; }
    h1 { font-size: 18px; margin: 0 0 12px; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .card { background: #171d24; border: 1px solid #242c36; border-radius: 10px; padding: 14px; margin-bottom: 12px; }
    .title { font-weight: 600; }
    .muted { color: #8593a3; font-size: 12px; }
    .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
    .on { background: #3fd68f; } .off { background: #5a6572; } .wait { background: #e8b94e; }
    button, select, input { background: #202832; color: #d8dee6; border: 1px solid #303b48; border-radius: 6px; padding: 6px 12px; font: inherit; cursor: pointer; }
    button:hover { background: #2a3542; }
    button.start { border-color: #2c6e4f; } button.stop { border-color: #7a3b3b; }
    pre { background: #0b0e12; border: 1px solid #242c36; border-radius: 8px; padding: 10px; max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-all; font-size: 12px; display: none; }
    #msg { color: #e8b94e; min-height: 20px; font-size: 12px; }
    .tokenbox { margin-bottom: 14px; }
</style>
</head>
<body>
<h1>GlassBots Manager</h1>
<div class="row tokenbox">
    <input id="token" type="password" placeholder="Admin token" style="width:220px">
    <button onclick="saveToken()">Saqlash</button>
    <button class="stop" onclick="stopAll()">Hammasini to'xtatish</button>
    <span id="msg"></span>
</div>
<div id="bots"></div>
<script>
const $ = id => document.getElementById(id)
let token = localStorage.getItem('token') || ''
$('token').value = token
function saveToken() { token = $('token').value; localStorage.setItem('token', token); refresh() }
function msg(t) { $('msg').textContent = t; setTimeout(() => { if ($('msg').textContent === t) $('msg').textContent = '' }, 5000) }
async function api(path, opts) {
    const r = await fetch('/api' + path, { headers: { 'x-admin-token': token, 'Content-Type': 'application/json' }, ...opts })
    const j = await r.json().catch(() => ({}))
    if (!r.ok && j.error) msg(j.error)
    return j
}
function fmtUptime(ms) {
    const s = Math.floor(ms / 1000)
    if (s < 60) return s + 's'
    if (s < 3600) return Math.floor(s / 60) + 'm ' + s % 60 + 's'
    return Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm'
}
const openLogs = {} // qaysi botning log paneli ochiq
function render(bots) {
    for (const b of bots) {
        let card = $('card-' + b.name)
        if (!card) {
            card = document.createElement('div')
            card.className = 'card'
            card.id = 'card-' + b.name
            card.innerHTML =
                '<div class="row" style="justify-content:space-between">' +
                '  <div><span class="dot" id="dot-' + b.name + '"></span><span class="title">' + b.title + '</span>' +
                '  <div class="muted" id="info-' + b.name + '"></div></div>' +
                '  <div class="row">' +
                '    <select id="lt-' + b.name + '" onchange="setLogger(\\'' + b.name + '\\')">' +
                '      <option>logsiz</option><option>muhim</option><option>barchasi</option></select>' +
                '    <button class="start" onclick="act(\\'' + b.name + '\\',\\'start\\')">Start</button>' +
                '    <button class="stop" onclick="act(\\'' + b.name + '\\',\\'stop\\')">Stop</button>' +
                '    <button onclick="act(\\'' + b.name + '\\',\\'restart\\')">Restart</button>' +
                '    <button onclick="toggleLogs(\\'' + b.name + '\\')">Loglar</button>' +
                '  </div></div>' +
                '<pre id="logs-' + b.name + '"></pre>'
            $('bots').appendChild(card)
        }
        $('dot-' + b.name).className = 'dot ' + (b.stopping ? 'wait' : (b.running ? 'on' : (b.restartPending ? 'wait' : 'off')))
        const parts = []
        parts.push(b.stopping ? "to'xtatilmoqda..."
            : b.running ? 'ishlayapti, uptime ' + fmtUptime(b.uptimeMs) + ', pid ' + b.pid
            : (b.restartPending ? 'qayta ishga tushishni kutyapti' : (b.enabled ? 'yoqilgan, lekin ishlamayapti' : "o'chirilgan")))
        parts.push('loggerType: ' + b.loggerType)
        if (b.restarts) parts.push('avto-restartlar: ' + b.restarts)
        if (b.lastExit) parts.push('oxirgi chiqish: code=' + b.lastExit.code + ' signal=' + b.lastExit.signal)
        $('info-' + b.name).textContent = parts.join(' | ')
        const sel = $('lt-' + b.name)
        if (document.activeElement !== sel) sel.value = b.loggerType
    }
}
async function refresh() {
    const j = await api('/bots')
    if (j.ok) render(j.bots)
    for (const name of Object.keys(openLogs)) if (openLogs[name]) loadLogs(name)
}
async function act(name, action) {
    const j = await api('/bots/' + name + '/' + action, { method: 'POST' })
    if (j.note) msg(j.note)
    refresh()
}
async function stopAll() {
    if (!confirm("Barcha botlar to'xtatilsinmi?")) return
    const j = await api('/bots/all/stop', { method: 'POST' })
    if (j.note) msg(j.note)
    refresh()
}
async function setLogger(name) {
    const j = await api('/bots/' + name + '/logger', { method: 'POST', body: JSON.stringify({ loggerType: $('lt-' + name).value }) })
    if (j.note) msg(j.note)
    refresh()
}
function toggleLogs(name) {
    openLogs[name] = !openLogs[name]
    $('logs-' + name).style.display = openLogs[name] ? 'block' : 'none'
    if (openLogs[name]) loadLogs(name)
}
async function loadLogs(name) {
    const j = await api('/bots/' + name + '/logs?lines=200')
    if (!j.ok) return
    const pre = $('logs-' + name)
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30
    pre.textContent = j.lines.join('\\n') || '(hozircha log yo\\'q)'
    if (atBottom) pre.scrollTop = pre.scrollHeight
}
refresh()
setInterval(refresh, 3000)
</script>
</body>
</html>`

// ======================= ISHGA TUSHIRISH =======================
app.listen(PORT, () => {
    console.log(`[manager] Bot manager ishga tushdi: http://0.0.0.0:${PORT}`)
    console.log(`[manager] Holat fayli: ${STATE_FILE}`)
    if (!ADMIN_TOKEN) console.log('[manager] OGOHLANTIRISH: ADMIN_TOKEN berilmagan — API himoyasiz!')
    // oldin yoqilgan botlarni ketma-ket (stagger bilan) qayta ko'taramiz —
    // hammasi bir vaqtda serverga login qilib flood bo'lmasin
    const enabled = Object.keys(BOT_DEFS).filter(n => state.bots[n].enabled)
    enabled.forEach((name, i) => {
        setTimeout(() => { if (state.bots[name].enabled && !isRunning(name)) startBot(name) }, i * CONFIG.autoStartStaggerMs)
    })
    if (enabled.length) console.log(`[manager] Avto-start: ${enabled.join(', ')}`)
})

// Coolify redeploy da konteynerga SIGTERM keladi — bolalarni toza o'ldirib
// chiqamiz. enabled flaglar saqlanib qoladi, yangi deploy o'zi ko'taradi.
function shutdown(sig) {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[manager] ${sig} keldi — botlar to'xtatilmoqda...`)
    for (const name of Object.keys(BOT_DEFS)) {
        if (runtime[name].restartTimer) clearTimeout(runtime[name].restartTimer)
        if (runtime[name].proc) killProc(name)
    }
    // hamma bola o'lishini kutamiz, lekin ko'pi bilan killTimeoutMs + 2s
    const deadline = now() + CONFIG.killTimeoutMs + 2000
    const waiter = setInterval(() => {
        const alive = Object.keys(BOT_DEFS).some(n => runtime[n].proc)
        if (!alive || now() > deadline) {
            clearInterval(waiter)
            process.exit(0)
        }
    }, 200)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
