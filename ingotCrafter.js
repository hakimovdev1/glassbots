// ======================================================================
// INGOT CRAFTER — nether orolida netherite ishlab chiqaradi (2 ta bot):
//  - scrap sandig'idan netherite_scrap oladi
//  - gold yetishmasa /is shop Ores dan gold_ingot sotib oladi
//  - crafting table da netherite_ingot va netherite_block craft qiladi
//  - tayyor bloklarni deposit sandig'iga, keraksiz narsalarni trash ga joylaydi
// main.js (manager) orqali boshqariladi. Env o'zgaruvchilar (.env):
//  INGOT_PASSWORD    - MAJBURIY, akkauntlar paroli
//  INGOT_USERNAMES   - ixtiyoriy, vergul bilan (default: Zenomus_A1,Zenomus_A2)
//  INGOT_LOGGER_TYPE - 'logsiz' | 'muhim' | 'barchasi' (manager o'zi uzatadi)
//  INGOT_ACTIVE      - true bo'lsa manager avto-start qiladi (main.js o'qiydi)
// ======================================================================
'use strict'
// .env har doim SHU FAYL yonidan o'qiladi — main.js orqali ham, to'g'ridan
// to'g'ri `node ingotCrafter.js` bilan ham parol topilsin (cwd farq qilsa ham)
require('dotenv').config({ path: require('path').join(__dirname, '.env') })
const Minecraft = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const { plugin: craftingUtil } = require('mineflayer-crafting-util')
const { Vec3 } = require('vec3')
const fs = require('fs')
const path = require('path')
// log darajalari — boshqa botlar bilan YAGONA manbadan (shared.js)
const { shouldLog } = require('./shared')

// VPS da bitta kutilmagan xato yoki ushlanmagan promise butun jarayonni
// yiqitmasin — bot uzilishi 'end' orqali baribir reconnect qiladi.
// (Node 15+ da unhandledRejection default holda jarayonni o'ldiradi.)
process.on('uncaughtException', err => {
    console.log(`[ingot] Uncaught exception: ${err?.stack || err}`)
})
process.on('unhandledRejection', reason => {
    console.log(`[ingot] Unhandled rejection: ${reason?.stack || reason}`)
})

// Hostingda env unutilsa botlar "undefined" parol bilan bekorga login
// qilishga urinmasin — darhol aniq xabar bilan chiqamiz
if (!process.env.INGOT_PASSWORD) {
    console.log("XATO: INGOT_PASSWORD env o'zgaruvchisi berilishi shart! (.env fayliga INGOT_PASSWORD=... yozing)")
    process.exit(1)
}

const CONFIG = {
    owners: ['Zenomus', 'HAKIMOV'],
    // Log darajasi: 'logsiz' | 'muhim' | 'barchasi' — manager dashboarddagi
    // dropdown shu env orqali uzatadi
    loggerType: process.env.INGOT_LOGGER_TYPE || 'muhim',
    host: process.env.INGOT_HOST || 'hypixel.uz',
    port: Number(process.env.INGOT_PORT) || 25565,
    version: '1.20.1',
    password: process.env.INGOT_PASSWORD,
    // Akkauntlar .env da vergul bilan beriladi — berilmasa default ro'yxat
    usernames: (process.env.INGOT_USERNAMES || 'Zenomus_A1,Zenomus_A2')
        .split(',').map(s => s.trim()).filter(Boolean),
    scrapChest: new Vec3(-740, 77, -6337),
    depositChest: new Vec3(-739, 80, -6336),
    trashChest: new Vec3(-738, 80, -6332),
    spawnStaggerMs: 5000,            // botlar ketma-ket shu oraliq bilan ulanadi
    reconnectBaseMs: 10000,          // uzilgandan keyingi birinchi qayta ulanish kutishi
    reconnectMaxMs: 120000,          // backoff shu qiymatgacha oshadi
    botFilterWaitMs: 30 * 60 * 1000, // "siz botsiz" kickidan keyin kutish (30 daqiqa)
}

// Heartbeat fayli — DATA_DIR berilgan bo'lsa (Coolify volume) o'sha yerga,
// aks holda shu papkaga. Yozishda xato bo'lsa (read-only FS) jimgina o'tamiz,
// aks holda har 10s da jarayon crash bo'lardi.
const HEARTBEAT_FILE = path.join(process.env.DATA_DIR || __dirname, 'ingot_heartbeat')
setInterval(() => {
    try {
        fs.writeFileSync(HEARTBEAT_FILE, Date.now().toString())
    } catch (e) {
        /* yozib bo'lmadi — e'tiborsiz qoldiramiz */
    }
}, 10000)

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

const activeBots = new Map() // username -> bot (graceful shutdown uchun)
const reconnectMs = {}       // username -> keyingi qayta ulanish kutishi (backoff)
let shuttingDown = false

function createBot(username) {
    if (shuttingDown) return
    const tag = `[${username}]`
    // DIQQAT: parol createBot ga BERILMAYDI (Mojang auth ga urinib qolmasin) —
    // server chatda so'raganda /login bilan kiritiladi (zenomus.js dagi kabi)
    const bot = Minecraft.createBot({
        host: CONFIG.host,
        port: CONFIG.port,
        version: CONFIG.version,
        username,
        hideErrors: false,
        checkTimeoutInterval: 30000,
        keepAlive: true,
    })
    activeBots.set(username, bot)

    // alive=false bo'lgach safeNext zanjiri to'xtaydi — uzilgan bot ustida
    // ishlashga urinib xato yog'dirmaydi
    let alive = true
    let loggedIn = false
    let registered = false
    let botFilterKick = false

    bot.loadPlugin(pathfinder)
    bot.loadPlugin(craftingUtil)

    // log(msg) — oddiy log, faqat 'barchasi' rejimida ko'rinadi
    // log(msg, 'muhim') — muhim log, 'muhim' va 'barchasi' rejimlarida ko'rinadi
    function log(msg, level) { if (msg && shouldLog(CONFIG.loggerType, level)) console.log(`${tag} ${msg}`) }

    async function startLogin() {
        // server "login" so'zini bir necha marta yozishi mumkin — bir marta yetadi
        if (loggedIn) return
        loggedIn = true
        log('Login qilinmoqda...', 'muhim')
        await sleep(500)
        bot.chat(`/login ${CONFIG.password}`)
        await sleep(500)
        bot.chat('/is warp nether')
        await sleep(1000)
        safeNext()
    }

    // Bir vaqtda faqat BITTA rejalashtirilgan runNext bo'lsin — whisper
    // buyruqlari yoki timeout lar parallel zanjir ochib yubormasin (parallel
    // zanjirlar bir-birining sandiq oynalarini urishtirib xato chiqarardi)
    let nextTimer = null
    function safeNext() {
        if (nextTimer) clearTimeout(nextTimer)
        nextTimer = setTimeout(() => {
            nextTimer = null
            if (!alive) return
            runNext()
        }, 200)
    }

    async function runNext() {
        if (!alive) return
        try {
            const action = decideNextAction()

            switch (action) {
                case 'deposit':
                    return deposit()

                case 'craft_block':
                case 'craft_ingot':
                    return crafting()

                case 'buy_gold':
                    return buyGold()

                case 'get_scrap':
                    return getScraps()

                case 'idle':
                default:
                    log('Idle... qayta urinilmoqda')
                    await sleep(2000)
                    return safeNext()
            }
        } catch (err) {
            log(`runNext xatosi: ${err}`, 'muhim')

            // 🔁 auto-recovery
            await sleep(3000)
            return safeNext()
        }
    }

    async function safeClose(chest) {
        try {
            await sleep(300)
            await bot.closeWindow(chest)
        } catch (e) {
            // ignore
        }
    }

    function decideNextAction() {
        const inv = bot.inventory

        const scrap = inv.count(bot.registry.itemsByName['netherite_scrap'].id)
        const gold = inv.count(bot.registry.itemsByName['gold_ingot'].id)
        const ingot = inv.count(bot.registry.itemsByName['netherite_ingot'].id)
        const block = inv.count(bot.registry.itemsByName['netherite_block'].id)
        const emptySlots = inv.emptySlotCount()

        // 🔴 PRIORITY 1: agar block bo'lsa — deposit
        if (block > 0) return 'deposit'

        // 🟡 PRIORITY 2: agar ingot 9+ bo'lsa — block craft
        if (ingot >= 9) return 'craft_block'

        // 🟢 PRIORITY 3: agar scrap+gold yetarli — ingot craft
        if (scrap >= 4 && gold >= 4) return 'craft_ingot'

        // 🔵 PRIORITY 4: scrap bor, gold yetishmaydi — gold sotib olish
        if (scrap >= 4 && gold < 4) return 'buy_gold'

        // 🟣 PRIORITY 5: inventory bo'sh — scrap olish
        if (emptySlots > 4) return 'get_scrap'

        // ⚫ fallback
        return 'idle'
    }

    async function getScraps() {
        log('Scrap olinmoqda...')
        let chest

        try {
            const block = bot.blockAt(CONFIG.scrapChest)
            if (!block) return safeNext()

            chest = await bot.openChest(block)
            log("Scrap sandig'i ochildi")
            if (!chest) return safeNext()

            const empty = bot.inventory.emptySlotCount()
            if (empty === 0) {
                await safeClose(chest)
                return safeNext()
            }

            const scrapItems = chest.containerItems()
                .filter(i => i.name === 'netherite_scrap')

            if (scrapItems.length === 0) {
                log("Sandiqda scrap yo'q")
                await sleep(500)
                return safeNext()
            }

            // 🔥 eng katta stackni tanlaydi
            const scrapItem = scrapItems.reduce((max, item) => {
                return item.count > max.count ? item : max
            })

            const amount = Math.min(scrapItem.count, empty * 16)

            await chest.withdraw(scrapItem.type, null, amount)
            log(`${amount} ta scrap olindi`, 'muhim')

            await safeClose(chest)

            return safeNext()

        } catch (err) {
            log(`getScraps xatosi: ${err}`, 'muhim')
            if (chest) await safeClose(chest)
            return safeNext()
        }
    }

    async function buyGold() {
        try {
            log('Gold sotib olinmoqda...')
            bot.chat('/is shop Ores')

            // 5s da oyna ochilmasa listener ALBATTA olib tashlanadi — aks
            // holda u keyinroq ochilgan sandiq oynasida ishga tushib, kutilmagan
            // kliklar qilishi mumkin edi
            const onWindow = async (w) => {
                try {
                    if (!w.title.includes('Ores')) return // timeout o'zi safeNext qiladi
                    log('Shop oynasi ochildi')
                    for (let i = 0; i < 10; i++) {
                        await sleep(100)
                        await bot.simpleClick.leftMouse(15)
                        log(`Shop bosildi ${i + 1}/10`)
                    }

                    await sleep(300)
                    await bot.closeWindow(w)
                    clearTimeout(timeout)

                    return safeNext()
                } catch (e) {
                    log(`Shop xatosi: ${e}`, 'muhim')
                    clearTimeout(timeout)
                    return safeNext()
                }
            }
            const timeout = setTimeout(() => {
                bot.removeListener('windowOpen', onWindow)
                log('Shop oynasi ochilmadi (timeout)', 'muhim')
                safeNext()
            }, 5000)
            bot.once('windowOpen', onWindow)

        } catch (err) {
            log(`buyGold xatosi: ${err}`, 'muhim')
            return safeNext()
        }
    }

    async function crafting() {
        try {
            const craftingTable = bot.findBlock({
                matching: block => block.name === 'crafting_table',
                maxDistance: 4
            })

            if (!craftingTable) {
                log("Yaqinda crafting table yo'q", 'muhim')
                return safeNext()
            }

            const inv = bot.inventory

            const scrap = inv.count(bot.registry.itemsByName['netherite_scrap'].id)
            const gold = inv.count(bot.registry.itemsByName['gold_ingot'].id)
            const ingot = inv.count(bot.registry.itemsByName['netherite_ingot'].id)

            // ⚡ 1. INGOT → BLOCK (FAST BULK)
            if (ingot >= 9) {
                const count = Math.floor(ingot / 9)

                const recipe = bot.recipesFor(
                    bot.registry.itemsByName['netherite_block'].id,
                    null,
                    1,
                    craftingTable
                )[0]

                if (!recipe) return safeNext()

                await bot.craft(recipe, count, craftingTable)
                log(`${count} ta netherite_block craft qilindi`, 'muhim')

                return safeNext()
            }

            // ⚡ 2. SCRAP + GOLD → INGOT (FAST BULK)
            if (scrap >= 4 && gold >= 4) {
                const craftCount = Math.floor(Math.min(scrap / 4, gold / 4))

                const recipes = bot.recipesFor(
                    bot.registry.itemsByName['netherite_ingot'].id,
                    null,
                    1,
                    craftingTable
                )

                const recipe = recipes.find(r => r.ingredients.length === 8)

                if (!recipe) {
                    log("To'g'ri ingot retsepti topilmadi", 'muhim')
                    return safeNext()
                }

                // 🔥 BIR MARTA KATTA CRAFT (eng katta speed boost)
                await bot.craft(recipe, craftCount, craftingTable)
                log(`${craftCount} ta netherite_ingot craft qilindi`, 'muhim')
                return safeNext()
            }

            return safeNext()

        } catch (err) {
            log(`Crafting xatosi: ${err}`, 'muhim')
            return safeNext()
        }
    }

    // items dagi narsalarni chest ga soladi (har biri 1 marta retry bilan)
    async function depositItems(chest, items, chestName) {
        for (const item of items) {
            try {
                // ⚠️ har bir action sequential
                await bot.waitForTicks(2)

                await chest.deposit(bot.registry.itemsByName[item.name].id, item.metadata, item.count)
                log(`${item.count} ta ${item.name} ${chestName}ga solindi`, 'muhim')
                await sleep(100)
            } catch (err) {
                log(`Deposit o'tmadi: ${item.name}, ${err.message}`, 'muhim')

                // retry 1 marta
                try {
                    await bot.waitForTicks(2)
                    await chest.deposit(bot.registry.itemsByName[item.name].id, item.metadata, item.count)
                    log(`Retry muvaffaqiyatli: ${item.name}`)
                } catch (err2) {
                    log(`Retry ham o'tmadi: ${item.name}, ${err2.message}`, 'muhim')
                }
            }
        }
    }

    async function deposit() {
        let chest

        try {
            const block = bot.blockAt(CONFIG.depositChest)
            if (!block) {
                log('Deposit sandiq bloki topilmadi', 'muhim')
                return safeNext()
            }

            // netherite ga aloqasi yo'q narsalar avval trash sandig'iga
            const keep = ['netherite_block', 'netherite_ingot', 'netherite_scrap', 'gold_ingot']
            const junkItems = bot.inventory.items().filter(i => !keep.includes(i.name))
            if (junkItems.length > 0) {
                log('Inventarda keraksiz narsalar bor — avval trash sandiqqa solinadi')
                const trashBlock = bot.blockAt(CONFIG.trashChest)
                if (trashBlock) {
                    const trashChest = await bot.openChest(trashBlock)
                    await depositItems(trashChest, junkItems, 'trash sandiq')
                    await safeClose(trashChest)
                } else {
                    log('Trash sandiq bloki topilmadi', 'muhim')
                }
            }

            chest = await bot.openChest(block)
            log("Deposit sandig'i ochildi")
            if (!chest) {
                log('Sandiq ochilmadi', 'muhim')
                return safeNext()
            }

            // 🔑 MUHIM: snapshot (inventory o'zgarib ketmasin)
            const items = bot.inventory.items().filter(i => i.name === 'netherite_block')

            if (items.length === 0) {
                log("Deposit qilinadigan block yo'q")
                await safeClose(chest)
                return safeNext()
            }

            await depositItems(chest, items, 'deposit sandiq')

            await safeClose(chest)
            return safeNext()

        } catch (error) {
            log(`Deposit fatal xatosi: ${error}`, 'muhim')

            if (chest) await safeClose(chest)

            return safeNext()
        }
    }

    async function drop() {
        try {
            const items = bot.inventory.items()
            for (const item of items) {
                await bot.tossStack(item)
                log(`${item.count} ta ${item.name} tashlandi`)

                await sleep(100)
            }
        } catch (error) {
            log(`Drop xatosi: ${error}`, 'muhim')
        }
    }

    bot.on('messagestr', msg => {
        if (!msg) return
        log(msg)
        const lower = msg.toLowerCase()
        if (lower.includes('register')) {
            // yangi akkaunt bo'lsa avval ro'yxatdan o'tkazamiz (faqat 1 marta)
            if (!loggedIn && !registered) {
                registered = true
                bot.chat(`/register ${CONFIG.password} ${CONFIG.password}`)
            }
        } else if (lower.includes('login')) {
            startLogin()
        }
    })

    bot.on('login', () => {
        log('Serverga ulandi', 'muhim')
        // muvaffaqiyatli ulandi — reconnect backoff qayta boshidan
        reconnectMs[username] = CONFIG.reconnectBaseMs
    })

    bot.on('whisper', (user, msg) => {
        if (!CONFIG.owners.includes(user)) return
        if (msg === 'buy') return buyGold()
        if (msg === 'craft') return crafting()
        if (msg === 'get') return getScraps()
        if (msg === 'deposit') return deposit()
        if (msg === 'drop') return drop()
        bot.chat(msg)
    })

    bot.on('kicked', reason => {
        // reason string YOKI obyekt bo'lishi mumkin — to'g'ridan .includes()
        // chaqirsak obyektda TypeError bo'lib crash bo'lardi
        const reasonStr = parseKickReason(reason)
        log(`Kick qilindi: ${reasonStr}`, 'muhim')
        // bot-filter kicki bo'lsa 'end' handler uzoq kutish qo'yadi
        botFilterKick = reasonStr.includes('Вы не прошли проверку')
    })

    bot.on('error', err => {
        // Chunk load xatoliklarini yashirish
        if (err.message && err.message.includes('chunk failed to load')) return
        log(`Ulanish xatosi: ${err.message}`, 'muhim')
    })

    // Har qanday uzilish ('kicked', 'error', server restart...) oxirida 'end'
    // keladi — qayta ulanish FAQAT shu yerda rejalashtiriladi (bitta joy,
    // ikkita parallel reconnect ochilib qolmaydi)
    bot.on('end', () => {
        if (!alive) return
        alive = false
        activeBots.delete(username)
        if (shuttingDown) return

        let delay
        if (botFilterKick) {
            delay = CONFIG.botFilterWaitMs
            log('BotFilter orqali bloklandi — 30 daqiqa kutiladi', 'muhim')
        } else {
            delay = reconnectMs[username] || CONFIG.reconnectBaseMs
            reconnectMs[username] = Math.min(delay * 2, CONFIG.reconnectMaxMs)
        }
        log(`Ulanish uzildi — ${Math.round(delay / 1000)}s dan keyin qayta ulanadi`, 'muhim')
        setTimeout(() => createBot(username), delay)
    })

    return bot
}

function parseKickReason(reason) {
    try {
        if (typeof reason === 'string') return reason
        if (reason && reason.extra) {
            return reason.extra.map(part => part.text || '').join('')
        }
        return JSON.stringify(reason)
    } catch {
        return "Noma'lum sabab"
    }
}

// Manager (main.js) stop/redeploy da SIGTERM yuboradi — botlarni serverdan
// toza chiqarib, keyin o'zimiz ham chiqamiz
function shutdown(sig) {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[ingot] ${sig} keldi — botlar serverdan chiqmoqda...`)
    for (const bot of activeBots.values()) {
        try { bot.quit("Dastur to'xtatildi") } catch (e) { /* allaqachon uzilgan */ }
    }
    setTimeout(() => process.exit(0), 2000)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// Botlarni ketma-ket (stagger bilan) ishga tushirish — hammasi bir vaqtda
// serverga login qilib flood bo'lmasin
CONFIG.usernames.forEach((username, index) => {
    setTimeout(() => {
        console.log(`[ingot] Bot ulanmoqda: ${username} (${index + 1}/${CONFIG.usernames.length})`)
        createBot(username)
    }, index * CONFIG.spawnStaggerMs)
})
