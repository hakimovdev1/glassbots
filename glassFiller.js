const mineflayer = require('mineflayer')
const pathfinder = require('mineflayer-pathfinder')
// homeChestArea, sandiq tartibi, log tizimi — crafter.js bilan YAGONA manbadan (shared.js)
const { HOME_CHEST_AREA, chestOrder, inHomeChestArea, LOG_LEVELS, shouldLog } = require('./shared')
const { Movements } = pathfinder
const { GoalNear } = pathfinder.goals
const { Vec3 } = require('vec3')
const fs = require('fs')
const path = require('path')
const CONFIG = {
    owners: ['HAKIMOV', 'IveNeS_UZ'],
    // Log darajasi: 'logsiz' | 'muhim' | 'barchasi'
    // ("loglevel <daraja>" whisper buyrug'i bilan ishlash paytida o'zgartirsa bo'ladi)
    loggerType: process.env.FILLER_LOGGER_TYPE || 'muhim',
    // === Island filler sozlamalari ===
    // O'z orolda FAQAT shu quti (box) ichidagi sandiqlar ochiladi.
    // Qiymat shared.js dan — crafter.js bilan avtomatik bir xil:
    homeChestArea: HOME_CHEST_AREA,
    homeChestSearchRadius: 48,   // o'z orolida sandiq qidirish radiusi
    minBottlesBeforeTrip: 64,    // safar oldidan kamida shuncha bottle bo'lsin (bo'lmasa restock)
    maxTripsPerIsland: 10,       // bitta orol uchun maksimal qatnov (cheksiz loopdan himoya)
    chestReachRange: 3,          // sandiqqa shu masofagacha yaqinlashadi (ustiga chiqmaydi)
    pathfindTimeoutMs: 30000,    // pathfinding uchun maksimal vaqt
    chestOpenDelayMs: 20,        // sandiq ochilgandan keyingi kutish
    chestCloseDelayMs: 20,       // sandiq yopishdan oldingi kutish
    depositRetries: 3,           // deposit xatosida qayta urinishlar soni
    depositCallTimeoutMs: 30000, // bitta sandiqqa deposit uchun mutlaq limit (qotib qolmaslik)
    chestFullFreeSpace: 64,      // bo'sh joy shundan KAM bo'lsa sandiq "to'la" (1 stack ochiq qolishi mumkin)
    withdrawClickDelayMs: 200,   // olishda kliklar orasidagi pauza — tezlik emas, ISHONCHLILIK muhim
    withdrawSessionLimit: 12,    // bitta sandiq uchun maksimal ochish-sessiyalari (natija bo'lmasa 2 tadan keyin baribir to'xtaydi)
    withdrawSettleMs: 3000,      // sessiya yopilgach server tuzatishlarini kutish limiti
    chestNotFoundLimit: 3,       // sandiq shuncha urinishda topilmasa — koordinata xato deb o'tkaziladi
    chestUnreachableLimit: 3,    // sandiqqa shuncha urinishda yetib bo'lmasa — o'tkazib yuboriladi (cheksiz trip loopdan himoya)
    reconnectDelayMs: 5000,      // uzilganda qayta ulanish kutishi
    resumeDelayMs: 8000,         // qayta ulangach ishni davom ettirishdan oldingi kutish
}
const botConfig = {
    host: 'hypixel.uz',
    port: 25565,
    username: process.env.FILLER_USERNAME, // change username
    version: '1.18.2', // change version if needed (1.21.1 , 1.19.4 , 1.20.1)
    password: process.env.FILLER_PASSWORD, // change password
}

// ======================================================================
// BARCHA BOT OROLLARI — shu yerga har bir orol ma'lumotini kiritasiz.
// endPortal      -> orolning overworld qismidagi end portal koordinatasi
// deposit_chests -> end ichidagi glass_bottle solinadigan sandiqlar (2-5 ta)
// last_full_deposit_date -> avtomatik yoziladi (glassFiller.state.json ga saqlanadi)
// ======================================================================
const ISLANDS = [
    {
        orol_bot_username: 'asalFarm_N1',
        endPortal: new Vec3(-302, 82, 5745),
        deposit_chests: [
            new Vec3(-288, 95, 5743),
        ],
        last_full_deposit_date: null,
    },
    {
        orol_bot_username: 'asalFarm_N2',
        endPortal: new Vec3(-453, 83, 5745),
        deposit_chests: [
            new Vec3(-455, 96, 5740),
            new Vec3(-443, 96, 5740),
        ],
        last_full_deposit_date: null,
    },
    {
        orol_bot_username: 'asalFarm_N3',
        endPortal: new Vec3(-607, 82, 5748),
        deposit_chests: [
            new Vec3(-601, 96, 5738),
            new Vec3(-591, 96, 5738)
        ],
        last_full_deposit_date: null,
    },
    {
        orol_bot_username: 'asalFarm_N4',
        endPortal: new Vec3(-906, 82, 5746),
        deposit_chests: [
            new Vec3(-905, 96, 5742),
            new Vec3(-893, 96, 5742)
        ],
        last_full_deposit_date: null,
    },
    {
        orol_bot_username: 'asalFarm_N5',
        endPortal: new Vec3(-2718, 81, 5882),
        deposit_chests: [
            // DIQQAT: oldin z manfiy (-5873/-5887) yozilgan edi — portal z=5882 dan
            // 11 ming blok uzoqda bo'lardi. Belgisi xato deb hisoblab to'g'irlandi,
            // o'yinda tekshirib tasdiqlang!
            new Vec3(-2709, 95, 5873),
            new Vec3(-2709, 95, 5887)
        ],
        last_full_deposit_date: null,
    },
]

// last_full_deposit_date restart bo'lsa ham yo'qolmasligi uchun faylga saqlaymiz
const STATE_FILE = path.join(__dirname, 'glassFiller.state.json')
function loadState() {
    try {
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
        for (const island of ISLANDS) {
            if (raw[island.orol_bot_username]) {
                island.last_full_deposit_date = raw[island.orol_bot_username]
            }
        }
    } catch (e) { /* fayl hali yo'q — muammo emas */ }
}
function saveState() {
    try {
        const out = {}
        for (const island of ISLANDS) {
            out[island.orol_bot_username] = island.last_full_deposit_date
        }
        fs.writeFileSync(STATE_FILE, JSON.stringify(out, null, 2))
    } catch (e) {
        logger(`State saqlashda xato: ${e.message}`, 'muhim')
    }
}
loadState()

async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
// logger(msg) — oddiy log, faqat 'barchasi' rejimida ko'rinadi
// logger(msg, 'muhim') — muhim log, 'muhim' va 'barchasi' rejimlarida ko'rinadi
function logger(msg, level) { if (msg && shouldLog(CONFIG.loggerType, level)) console.log(msg) }
// Ulanish uzilganda ish holati shu yerda saqlanadi (createBot dan tashqarida) —
// yangi bot ulanib login qilgach ishni AVTOMATIK davom ettiradi
let resumeFillAfterReconnect = false
function createBot() {
    const bot = mineflayer.createBot(botConfig)
    bot.loadPlugin(pathfinder.pathfinder)
    let busy = false // bir vaqtda faqat bitta katta vazifa ishlashi uchun
    let loginTriggered = false
    let disconnected = false // ulanish o'lganda darhol true bo'ladi
    let needHomeAfterDeath = false // o'limdan keyin orolga qaytish kerakligini bildiradi

    // "Yo'l yaratish" rejimida minora/ko'prik uchun ishlatiladigan bloklar
    const SCAFFOLD_BLOCK_NAMES = ['dirt', 'cobblestone', 'netherrack', 'stone', 'end_stone', 'cobbled_deepslate']

    // Harakat rejimini quradi:
    //  buildMode=false -> to'liq xavfsiz: sindirmaydi, blok qo'ymaydi, parkour yo'q
    //  buildMode=true  -> yo'l yaratish: parkour + inventardagi qurilish bloklari
    //                     bilan minora/ko'prik quradi. Sindirish BARIBIR taqiqlangan.
    function buildMovements(buildMode) {
        const m = new Movements(bot)
        m.canDig = false
        m.allow1by1towers = buildMode
        m.allowParkour = buildMode
        m.scafoldingBlocks = []
        m.maxDropDown = buildMode ? 4 : 3
        if (buildMode) {
            for (const name of SCAFFOLD_BLOCK_NAMES) {
                const def = bot.registry.itemsByName[name]
                if (def) m.scafoldingBlocks.push(def.id)
            }
        }
        // Rails ustidan yurish taqiqlanadi — minecartlarga xalaqit bermaslik uchun.
        // Bot faqat o'zi rail'lardan aylanib o'tadi, minecart harakati cheklanmaydi.
        const railNames = ['rail', 'powered_rail', 'detector_rail', 'activator_rail']
        for (const name of railNames) {
            const railBlock = bot.registry.blocksByName[name]
            if (railBlock) m.blocksToAvoid.add(railBlock.id)
        }
        return m
    }

    bot.once('spawn', () => {
        bot.pathfinder.setMovements(buildMovements(false))
        // murakkab yo'llarda hisoblash erta uzilib "Path was stopped" bermasligi
        // uchun pathfinderga ko'proq o'ylash vaqti beramiz (default 5s)
        bot.pathfinder.thinkTimeout = 10000

        // fallback: server "login" so'ramasa ham resume urinib ko'ramiz
        setTimeout(() => { tryAutoResume() }, 15000)
    })

    async function safeClose(chest) {
        try {
            await sleep(CONFIG.chestCloseDelayMs)
            await bot.closeWindow(chest)
        } catch (e) {
            // ignore
        }
    }
    async function startLogin() {
        bot.chat(`/login ${botConfig.password}`)
        await sleep(500)
        bot.chat('/is go')
        // uzilishdan oldin ish bo'lgan bo'lsa — davom ettiramiz
        tryAutoResume()
    }

    // O'limdan keyin tiklanish: respawn bo'lgach /is go bilan o'z oroliga
    // qaytadi. keepInventory true — bottle lar yo'qolmaydi, joriy trip
    // qayta boshlanadi (to'lgan sandiqlar eslab qolingan, ularga qaytmaydi).
    async function recoverAfterDeath() {
        if (!needHomeAfterDeath) return
        needHomeAfterDeath = false
        logger('>> Respawn — /is go bilan orolga qaytib ishni davom ettiramiz', 'muhim')
        try {
            bot.pathfinder.stop()
            bot.clearControlStates()
            await sleep(1500)
            bot.chat('/is go')
            await waitForTeleport(8000)
            await afterTeleportSettle()
        } catch (e) {
            logger(`Death recovery xato: ${e.message}`, 'muhim')
        }
    }

    // Qayta ulanishdan keyin uzilib qolgan island filler ni avtomatik davom ettiradi.
    // fillIsland faqat TO'LMAGAN sandiqlarni to'ldiradi, shuning uchun qayta
    // boshlash xavfsiz — to'lganlariga qayta bormaydi.
    async function tryAutoResume() {
        if (!resumeFillAfterReconnect) return
        await sleep(CONFIG.resumeDelayMs)
        if (!resumeFillAfterReconnect || busy || disconnected) return
        resumeFillAfterReconnect = false
        logger('>> Uzilishdan oldingi ISLAND FILLER avtomatik davom ettirilmoqda...', 'muhim')
        await fillAllIslands()
    }
    async function drop() {
        try {
            const items = bot.inventory.items()
            for (const item of items) {
                await bot.tossStack(item)
                logger(`Dropped ${item.count} of ${item.name}`);

                await sleep(100)
            }
        } catch (error) {
            logger(`Error dropping items: ${error}`)
        }
    }
    function getInventorySpaceFor(itemName) {
        const itemDef = bot.registry.itemsByName[itemName];
        const maxStack = itemDef ? itemDef.stackSize : 64;
        let space = bot.inventory.emptySlotCount() * maxStack;
        for (const item of bot.inventory.items()) {
            if (item.name === itemName) {
                space += maxStack - item.count;
            }
        }
        return space;
    }

    // ==================================================================
    // ==================== ISLAND GLASS BOTTLE FILLER ==================
    // ==================================================================

    function countBottles() {
        const def = bot.registry.itemsByName['glass_bottle']
        if (!def) return 0
        return bot.inventory.count(def.id)
    }

    // Qiymat o'zgarishini kutadi (server tasdig'i kelguncha, maks timeoutMs).
    // Server tez javob bersa 25-50ms da qaytadi — qat'iy kutishdan tezroq.
    async function waitForChange(getFn, previous, timeoutMs = 800) {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            if (getFn() !== previous) return true
            await sleep(25)
        }
        return false
    }

    // Qiymat barqarorlashishini kutadi — oxirgi o'zgarishdan keyin stableMs tinchlik
    async function waitForStable(getFn, stableMs = 150, timeoutMs = 1500) {
        const start = Date.now()
        let prev = getFn()
        let lastChange = Date.now()
        while (Date.now() - start < timeoutMs) {
            await sleep(25)
            const cur = getFn()
            if (cur !== prev) {
                prev = cur
                lastChange = Date.now()
            } else if (Date.now() - lastChange >= stableMs) {
                break
            }
        }
        return prev
    }

    // Teleport kutish: dimension o'zgarishi YOKI katta pozitsiya sakrashi
    function hasTeleported(startPos, startDim, minDistance = 16) {
        if (!bot.entity) return false
        if (bot.game.dimension !== startDim) return true
        return bot.entity.position.distanceTo(startPos) >= minDistance
    }
    function waitForTeleport(timeoutMs = 10000, minDistance = 16, refPos = null, refDim = null) {
        const startPos = refPos || bot.entity.position.clone()
        const startDim = refDim || bot.game.dimension
        return new Promise(resolve => {
            const timer = setInterval(() => {
                if (hasTeleported(startPos, startDim, minDistance)) {
                    cleanup()
                    resolve(true)
                }
            }, 250)
            const timeout = setTimeout(() => { cleanup(); resolve(false) }, timeoutMs)
            function cleanup() { clearInterval(timer); clearTimeout(timeout) }
        })
    }

    async function afterTeleportSettle() {
        await sleep(1500)
        try { await bot.waitForChunksToLoad() } catch (e) { /* ignore */ }
        await sleep(500)
    }

    // Har qanday holatda o'z oroliga qaytish — ish tugaganda, xatoda, taslim bo'lganda
    async function goHome() {
        if (disconnected) return // o'lik ulanishda buyruq yuborishdan foyda yo'q
        try {
            logger('>> /is go — o\'z oroliga qaytamiz', 'muhim')
            bot.pathfinder.stop()
            bot.clearControlStates()
            bot.chat('/is go')
            await waitForTeleport(10000)
            await afterTeleportSettle()
        } catch (e) {
            logger(`Uyga qaytishda xato: ${e.message}`)
        }
    }

    // Sandiq YONIGA borish — ustiga chiqmaydi, hech narsa sindirmaydi (safeMoves).
    // Ulanish o'lsa timeout kutmasdan darhol chiqadi.
    async function safeGoNear(pos, range = CONFIG.chestReachRange) {
        try {
            await Promise.race([
                bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, range)),
                (async () => {
                    const start = Date.now()
                    while (Date.now() - start < CONFIG.pathfindTimeoutMs) {
                        if (disconnected) throw new Error('ulanish uzildi')
                        await sleep(250)
                    }
                    bot.pathfinder.stop()
                    throw new Error('pathfind timeout')
                })()
            ])
            return true
        } catch (err) {
            logger(`Pathfinding xato (${pos}): ${err.message}`)
            if (disconnected || !bot.entity) return false
            return bot.entity.position.distanceTo(pos) <= range + 2
        }
    }

    // Inventardagi qurilish bloklari soni (yo'l yaratish rejimi uchun)
    function countScaffoldBlocks() {
        let n = 0
        for (const item of bot.inventory.items()) {
            if (SCAFFOLD_BLOCK_NAMES.includes(item.name)) n += item.count
        }
        return n
    }

    // pos atrofidagi TURISH MUMKIN bo'lgan nuqtalarni topadi:
    // oyoq va bosh joyi bo'sh, ostida qattiq blok. Yaqinlari birinchi.
    function findStandableNear(pos, radius = 3) {
        const spots = []
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dz = -radius; dz <= radius; dz++) {
                for (let dy = -1; dy <= 2; dy++) {
                    if (dx === 0 && dz === 0) continue // sandiq turgan ustunning o'zi emas
                    const p = pos.offset(dx, dy, dz)
                    const feet = bot.blockAt(p)
                    const head = bot.blockAt(p.offset(0, 1, 0))
                    const floor = bot.blockAt(p.offset(0, -1, 0))
                    if (!feet || !head || !floor) continue
                    if (feet.boundingBox !== 'empty' || head.boundingBox !== 'empty') continue
                    if (floor.boundingBox !== 'block') continue
                    spots.push(p)
                }
            }
        }
        spots.sort((a, b) => a.distanceTo(pos) - b.distanceTo(pos))
        return spots
    }

    // Nuqtaga MUSTAHKAM yetib borish — bir necha strategiya ketma-ket:
    //  1) oddiy xavfsiz yo'l
    //  2) kengroq radius (yo'l oxirgi 1-2 blokda uzilgan hollar uchun)
    //  3) atrof-dagi aniq turish nuqtalariga alohida-alohida urinish —
    //     GoalNear topa olmagan yo'lni aniq blokka borish topishi mumkin
    //  4) YO'L YARATISH: parkour + (inventarda bo'lsa) qurilish bloklari bilan
    //     minora/ko'prik qurib boradi. Hech qachon hech narsa sindirilmaydi,
    //     ish tugagach xavfsiz rejim qaytariladi.
    async function goNearRobust(pos, range = CONFIG.chestReachRange) {
        const closeEnough = () =>
            bot.entity && bot.entity.position.distanceTo(pos) <= range + 2

        // 1) oddiy urinish
        if (await safeGoNear(pos, range)) return true
        if (disconnected || needHomeAfterDeath) return false

        // 2) kengroq radius
        await sleep(300)
        if (await safeGoNear(pos, range + 2)) return true
        if (disconnected || needHomeAfterDeath) return false

        // 3) atrofdagi aniq nuqtalarga urinish
        const spots = findStandableNear(pos, 3).slice(0, 6)
        for (const p of spots) {
            if (disconnected || needHomeAfterDeath) return false
            await safeGoNear(p, 1)
            if (closeEnough()) return true
        }

        // 4) yo'l yaratish rejimi
        const blocks = countScaffoldBlocks()
        logger(`Oddiy yo'l topilmadi (${pos}) — yo'l yaratish rejimi: parkour${blocks > 0 ? ` + ${blocks} ta qurilish bloki` : ` (qurilish bloki yo'q)`}`, 'muhim')
        bot.pathfinder.setMovements(buildMovements(true))
        try {
            if (await safeGoNear(pos, range)) return true
            if (closeEnough()) return true
        } finally {
            bot.pathfinder.setMovements(buildMovements(false))
        }
        return false
    }

    // Sandiqda glass_bottle uchun qancha joy borligini hisoblaydi
    function chestFreeSpaceFor(chestWindow, itemName) {
        const def = bot.registry.itemsByName[itemName]
        const stackSize = def ? def.stackSize : 64
        const slots = chestWindow.slots.slice(0, chestWindow.inventoryStart)
        let space = 0
        for (const s of slots) {
            if (s === null) space += stackSize
            else if (s.name === itemName) space += stackSize - s.count
        }
        return space
    }

    // Sandiqqa inventorydagi barcha glass_bottle larni SHIFT-CLICK bilan soladi.
    //
    // Nega shift-click: deposit sandiqlar ostida HOPPER bor — u itemlarni doimiy
    // so'rib turadi va sandiq oynasi har tick o'zgaradi. Mineflayer'ning oddiy
    // chest.deposit() usuli kursor bilan ko'p bosqichli ko'chirish qiladi, hopper
    // o'rtada aralashsa server rad etadi va bot "qo'yib-olib o'ynash"ga tushib
    // qolardi. Shift-click esa BITTA paket — server stackni o'zi joylaydi,
    // hopper unga xalaqit qila olmaydi. Bot faqat QO'YADI, hech qachon olmaydi.
    async function depositBottles(block) {
        const work = async () => {
            let chest
            try {
                chest = await bot.openChest(block)
            } catch (err) {
                logger(`Sandiqni ochib bo'lmadi: ${err.message}`)
                return { deposited: 0, chestFull: false, error: true }
            }
            await sleep(CONFIG.chestOpenDelayMs)

            let deposited = 0
            let lastMoved = -1

            // Har bir pass: oynadagi inventar qismidan bottle stacklarini
            // bir martadan shift-click qilamiz. Pass soni cheklangan —
            // hopper sandiqni bo'shatib tursa ham cheksiz loop bo'lmaydi.
            for (let pass = 0; pass < 5; pass++) {
                if (disconnected || needHomeAfterDeath) break
                const before = countBottles()
                if (before === 0) break
                // 1 stack dan kam joy qolsa "to'la" hisoblanadi
                if (chestFreeSpaceFor(chest, 'glass_bottle') < CONFIG.chestFullFreeSpace) break

                for (let slot = chest.inventoryStart; slot < chest.inventoryEnd; slot++) {
                    if (disconnected || needHomeAfterDeath) break
                    const s = chest.slots[slot]
                    if (!s || s.name !== 'glass_bottle') continue
                    if (chestFreeSpaceFor(chest, 'glass_bottle') <= 0) break
                    try {
                        await bot.clickWindow(slot, 0, 1) // mode 1 = shift-click
                    } catch (err) {
                        logger(`Shift-click xato: ${err.message || err}`)
                        break
                    }
                    await bot.waitForTicks(1)
                }

                // server tasdiqlari kelib bo'lguncha kutamiz — soni barqarorlashsin.
                // Qat'iy 2 tick yetmasligi mumkin edi (sekin serverda pass natijasi
                // 0 bo'lib ko'rinib, deposit erta tugab qolardi).
                await waitForStable(() => countBottles())
                lastMoved = before - countBottles()
                if (lastMoved > 0) deposited += lastMoved
                else break // hech narsa o'tmadi — keyingi urinish attempt loopda
            }

            // To'la FAQAT oynaning haqiqiy holatiga qarab aniqlanadi:
            // bo'sh joy 1 stackdan kam qolgan bo'lsa — to'la. Shift-click
            // o'tmay qolishi (desync) endi "to'la" deb YOLG'ON belgilanmaydi.
            const chestFull = chestFreeSpaceFor(chest, 'glass_bottle') < CONFIG.chestFullFreeSpace
            await safeClose(chest)
            return { deposited, chestFull, error: false }
        }

        // Mutlaq limit: hopper/desync nima qilmasin, bu funksiya qotib qolmaydi
        try {
            return await Promise.race([
                work(),
                sleep(CONFIG.depositCallTimeoutMs).then(() => {
                    throw new Error(`deposit ${CONFIG.depositCallTimeoutMs / 1000}s da tugamadi`)
                })
            ])
        } catch (err) {
            logger(`Deposit timeout/xato: ${err.message}`, 'muhim')
            try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch (e) { /* ignore */ }
            return { deposited: 0, chestFull: false, error: true }
        }
    }

    // /is visit username -> teleportni kutadi
    async function visitIsland(username) {
        logger(`>> /is visit ${username}`, 'muhim')
        bot.chat(`/is visit ${username}`)
        const tp = await waitForTeleport(10000)
        if (!tp) logger(`Ogohlantirish: ${username} ga teleport aniqlanmadi`, 'muhim')
        await afterTeleportSettle()
        return tp
    }

    // End portalga kirish: yoniga boradi, kerak bo'lsa oldinga yurib tushadi.
    // Teleport (dimension/position) orqali kirganini tekshiradi.
    async function enterEndPortal(portalPos) {
        const beforePos = bot.entity.position.clone()
        const beforeDim = bot.game.dimension

        logger(`End portalga ketyapmiz: ${portalPos}`)
        // pathfinding paytida portalga tushib ketishi mumkin — teleport bo'lsa
        // qolgan strategiyalarni sinab o'tirmaymiz
        if (!(await safeGoNear(portalPos, 2)) && !hasTeleported(beforePos, beforeDim, 16)) {
            await goNearRobust(portalPos, 2)
        }

        // pathfinding paytida portalga tushib teleport bo'lgan bo'lishi mumkin
        if (!hasTeleported(beforePos, beforeDim, 16)) {
            // portal tomon qarab, oldinga yuramiz (maks ~6 block, cheksiz yurmaydi)
            try {
                await bot.lookAt(new Vec3(portalPos.x + 0.5, portalPos.y, portalPos.z + 0.5), true)
            } catch (e) { /* ignore */ }

            const walkStart = bot.entity.position.clone()
            bot.setControlState('forward', true)
            let entered = false
            for (let i = 0; i < 40; i++) { // maksimal ~6 soniya
                await sleep(150)
                if (hasTeleported(beforePos, beforeDim, 16)) { entered = true; break }
                if (bot.entity.position.distanceTo(walkStart) > 6) break // portal topilmadi, to'xtaymiz
            }
            bot.setControlState('forward', false)

            if (!entered) {
                logger('End portalga kirib bo\'lmadi!', 'muhim')
                return false
            }
        }

        // MUHIM: o'lim respawni ham "teleport" bo'lib ko'rinadi — bu portal EMAS.
        // Aks holda bot uyda turib end sandiqlarini qidirib, ularni "topilmadi"
        // deb noto'g'ri belgilashi mumkin edi.
        if (needHomeAfterDeath) {
            logger('Portalga kirish paytida o\'lim yuz berdi — trip qaytadan boshlanadi', 'muhim')
            return false
        }

        logger('End portalga kirdik ✔')
        await afterTeleportSettle()
        return true
    }

    // Bitta sandiqdan glass_bottle larni SHIFT-CLICK bilan oladi — inventarga
    // sig'ganicha HAMMASINI.
    //
    // Nega shift-click: kursor ishlatilmaydi, shuning uchun hech narsa YERGA
    // TUSHMAYDI — inventar to'la bo'lsa stack shunchaki sandiqda qoladi.
    //
    // MUHIM DIZAYN QARORI — faqat SERVER HAQIQATIGA ishonamiz:
    // mineflayer shift-click ni OPTIMISTIK bajaradi — klik yuborilishi bilan
    // lokal oynada stack sandiqdan "chiqib ketgan" bo'lib ko'rinadi, server uni
    // rad etgan bo'lsa ham. Server tez kliklarni ~3 stackdan keyin rad qila
    // boshlasa, lokal oynada sandiq "bo'sh" ko'rinib qolardi va bot uni tashlab
    // ketardi — har sandiqdan faqat 3 stack olinishining sababi shu edi.
    //
    // Shuning uchun endi ish SESSIYALARGA bo'lingan:
    //  - ochish -> serverdan kelgan YANGI oynani kutish (bu haqiqiy holat)
    //  - lokal oynada bottle ko'ringuncha sekin-sekin shift-click qilish
    //  - yopish -> server tuzatish paketlari kelib bo'lishini kutish
    //  - natija YOPIQ holatdagi haqiqiy inventar sonidan o'lchanadi
    //  - sandiqda hali bottle bo'lsa (yangi ochilgan oyna ko'rsatsa) — davom
    // Ketma-ket 2 sessiya haqiqiy natija bermasagina to'xtaydi.
    async function withdrawAllBottles(p) {
        const startCount = countBottles()
        let zeroSessions = 0

        for (let session = 1; session <= CONFIG.withdrawSessionLimit; session++) {
            if (disconnected) break
            if (getInventorySpaceFor('glass_bottle') <= 0) break

            const block = bot.blockAt(p)
            if (!block || !block.name.includes('chest')) break

            let chest
            try {
                chest = await bot.openChest(block)
            } catch (err) {
                logger(`Sandiq ochilmadi (${p}): ${err.message}`)
                break
            }
            // Serverdan yangi oynaning TO'LIQ kelishini kutamiz (window_items).
            // Yangi ochilgan oyna — serverdagi HAQIQIY holat, lokal taxmin emas.
            await sleep(300)

            const findBottleSlot = () => {
                for (let slot = 0; slot < chest.inventoryStart; slot++) {
                    const s = chest.slots[slot]
                    if (s && s.name === 'glass_bottle') return slot
                }
                return -1
            }

            // Yangi ochilgan oynada bottle yo'q — sandiq CHINDAN bo'sh, tugadik
            if (findBottleSlot() === -1) {
                await safeClose(chest)
                break
            }

            const beforeSession = countBottles()

            // Sekin va tekis kliklaymiz — tezlik emas, ishonchlilik muhim.
            // Juda tez kliklarni server indamay rad etadi, lokal esa "o'tdi"
            // deb ko'rsataveradi. 27 slotli sandiq ~6 soniyada olinadi.
            for (let click = 0; click < 30; click++) {
                if (disconnected) break
                if (getInventorySpaceFor('glass_bottle') <= 0) break
                const slotIdx = findBottleSlot()
                if (slotIdx === -1) break // lokal ko'rinishda tugadi — sessiya yakuni
                try {
                    await bot.clickWindow(slotIdx, 0, 1) // mode 1 = shift-click
                } catch (err) {
                    logger(`Shift-click xato: ${err.message || err}`)
                    break
                }
                await sleep(CONFIG.withdrawClickDelayMs)
            }

            await safeClose(chest)
            // Oyna yopilgach server tuzatish (resync) paketlari kelib bo'lsin —
            // shundan KEYINGI countBottles() haqiqiy qiymat
            await waitForStable(() => countBottles(), 300, CONFIG.withdrawSettleMs)

            const sessionGot = countBottles() - beforeSession
            logger(`Sandiq (${p}): sessiya ${session} — +${sessionGot} bottle (jami: ${countBottles()})`)

            if (sessionGot <= 0) {
                // Haqiqatda hech narsa kelmadi (lokal nima ko'rsatgan bo'lsa ham).
                // Bir marta serverga "dam" berib yana urinamiz, ikkinchisida to'xtaymiz.
                zeroSessions++
                if (zeroSessions >= 2) {
                    logger(`Sandiq (${p}): 2 sessiya ketma-ket natija bermadi — keyingisiga o'tamiz`, 'muhim')
                    break
                }
                await sleep(1000)
            } else {
                zeroSessions = 0
            }
            // sandiqda hali bottle qolgan bo'lishi mumkin — keyingi sessiya
            // qayta ochib serverdan kelgan yangi oyna bo'yicha tekshiradi
        }

        return Math.max(0, countBottles() - startCount)
    }

    // O'z oroliga borib (/is go) homeChestArea ichidagi sandiqlardan glass_bottle yig'adi.
    // Sandiqlar tartibsiz/ustma-ust bo'lgani uchun koordinata emas, skanerlash ishlatiladi.
    async function restockBottles() {
        // restock baribir uyga qaytadi — o'limdan keyingi qaytish shu bilan qoplanadi
        needHomeAfterDeath = false
        logger('>> /is go — glass_bottle olish uchun uyga qaytyapmiz')
        bot.chat('/is go')
        await waitForTeleport(10000)
        await afterTeleportSettle()

        const chestBlockIds = []
        if (bot.registry.blocksByName.chest) chestBlockIds.push(bot.registry.blocksByName.chest.id)
        if (bot.registry.blocksByName.trapped_chest) chestBlockIds.push(bot.registry.blocksByName.trapped_chest.id)

        let gathered = 0
        const visited = new Set()

        // 3 marta skanerlash: bot harakatlanganda yangi sandiqlar chunk ichiga kiradi
        for (let scan = 0; scan < 3; scan++) {
            if (disconnected) break
            if (getInventorySpaceFor('glass_bottle') <= 0) break

            const positions = bot.findBlocks({
                matching: chestBlockIds,
                maxDistance: CONFIG.homeChestSearchRadius,
                count: 256,
            })
                .filter(p => inHomeChestArea(p))
                .filter(p => !visited.has(`${p.x},${p.y},${p.z}`))
                // HAR DOIM bir xil tartibda — shared.js dagi chestOrder.
                // Crafter bot ham xuddi shu tartibda to'ldiradi, shuning uchun
                // bottle lar doim ro'yxat boshidagi sandiqlarda turadi.
                .sort(chestOrder)

            if (positions.length === 0) break

            for (const p of positions) {
                if (disconnected) break
                if (getInventorySpaceFor('glass_bottle') <= 0) break
                visited.add(`${p.x},${p.y},${p.z}`)

                const block = bot.blockAt(p)
                if (!block || !block.name.includes('chest')) continue

                const reached = await safeGoNear(p, CONFIG.chestReachRange)
                if (!reached) {
                    logger(`Sandiqqa yetib bo'lmadi: ${p} — keyingisiga o'tamiz`)
                    continue
                }

                // sig'ganicha HAMMASINI oladi; kliklar o'tmay qolsa sandiqni
                // yopib qayta ochib davom etadi (withdrawAllBottles ga qarang)
                gathered += await withdrawAllBottles(p)
            }
        }

        logger(`Restock tugadi: +${gathered} glass_bottle (jami: ${countBottles()})`, 'muhim')
        return countBottles() > 0
    }

    // Bitta orolni to'liq to'ldiradi. Kerak bo'lsa bir necha marta qatnaydi.
    // Natija: 'done' | 'no_bottles' | 'failed'
    async function fillIsland(island) {
        const fullChests = new Set() // to'lgan sandiq indekslari
        const notFoundCounts = new Map() // sandiq topilmagan urinishlar soni
        const unreachableCounts = new Map() // sandiqqa yetib bo'lmagan urinishlar soni
        const skippedChests = new Set() // to'lgani uchun emas, xato tufayli o'tkazib yuborilganlar

        for (let trip = 1; trip <= CONFIG.maxTripsPerIsland; trip++) {
            if (disconnected) return 'failed' // ulanish o'ldi — resume qayta boshlaydi

            // o'limdan keyin avval o'z orolimizga qaytamiz, trip qaytadan boshlanadi
            await recoverAfterDeath()

            // 1. Bottle yetarlimi? Kam bo'lsa avval uyda to'ldirib olamiz
            if (countBottles() < CONFIG.minBottlesBeforeTrip) {
                await restockBottles()
                if (needHomeAfterDeath) continue // restock paytida o'ldik — keyingi tripda qaytadan
                if (countBottles() === 0) {
                    logger('Uyda glass_bottle qolmadi — to\'xtaymiz!', 'muhim')
                    return 'no_bottles'
                }
            }

            // 2. Orolga borish
            await visitIsland(island.orol_bot_username)

            // 3. End portalga kirish
            const entered = await enterEndPortal(island.endPortal)
            if (!entered) {
                logger(`${island.orol_bot_username}: portalga kira olmadik`, 'muhim')
                return 'failed'
            }

            // 4. Sandiqlarni to'ldirish — bottle bor ekan uyga qaytmaymiz,
            //    xato/desync bo'lsa shu yerning o'zida bir necha marta qayta uriniladi
            for (let attempt = 1; attempt <= 3; attempt++) {
                let progress = false

                for (let i = 0; i < island.deposit_chests.length; i++) {
                    // o'limdan keyin bot boshqa joyda — sandiqlarni noto'g'ri
                    // "topilmadi" deb belgilamaslik uchun darhol chiqamiz
                    if (disconnected || needHomeAfterDeath) break
                    if (fullChests.has(i)) continue
                    if (countBottles() === 0) break

                    const pos = island.deposit_chests[i]
                    // ko'p bosqichli urinish: oddiy yo'l -> kengroq radius ->
                    // atrofdagi nuqtalar -> yo'l yaratish (parkour/blok qo'yish)
                    const reached = await goNearRobust(pos, CONFIG.chestReachRange)

                    const block = bot.blockAt(pos)
                    if (!block || !block.name.includes('chest')) {
                        // Sandiq topilmadi — bu "to'ldi" degani EMAS! Chunk hali
                        // yuklanmagan bo'lishi mumkin. Faqat bir necha urinishdan
                        // keyin ham topilmasa (koordinata xato) o'tkazib yuboramiz.
                        const n = (notFoundCounts.get(i) || 0) + 1
                        notFoundCounts.set(i, n)
                        if (n >= CONFIG.chestNotFoundLimit) {
                            logger(`Sandiq ${n} urinishda ham topilmadi: ${pos} — koordinata xato bo'lishi mumkin, o'tkazib yuboramiz!`, 'muhim')
                            fullChests.add(i)
                            skippedChests.add(i)
                        } else {
                            logger(`Sandiq topilmadi: ${pos} — qayta uriniladi (${n}/${CONFIG.chestNotFoundLimit})`)
                        }
                        continue
                    }
                    if (!reached) {
                        // Yetib bo'lmadi — buni ham sanaymiz, aks holda bot har trip
                        // to'liq qatnovni (uy -> visit -> portal) bekorga takrorlab,
                        // maxTripsPerIsland gacha aylanaverardi.
                        const n = (unreachableCounts.get(i) || 0) + 1
                        unreachableCounts.set(i, n)
                        if (n >= CONFIG.chestUnreachableLimit) {
                            logger(`Sandiqqa ${n} urinishda ham yetib bo'lmadi: ${pos} — yo'l to'silgan bo'lishi mumkin, o'tkazib yuboramiz!`, 'muhim')
                            fullChests.add(i)
                            skippedChests.add(i)
                        } else {
                            logger(`Sandiqqa yetib bo'lmadi: ${pos} — qayta uriniladi (${n}/${CONFIG.chestUnreachableLimit})`)
                        }
                        continue
                    }
                    unreachableCounts.delete(i) // yetib bordik — hisobni tozalaymiz

                    const { deposited, chestFull } = await depositBottles(block)
                    logger(`Chest ${i + 1}/${island.deposit_chests.length}: +${deposited} bottle${chestFull ? ' (TO\'LDI ✔)' : ''}`)
                    if (chestFull) fullChests.add(i)
                    if (deposited > 0 || chestFull) progress = true
                    await sleep(50)
                }

                if (disconnected || needHomeAfterDeath) break
                if (fullChests.size >= island.deposit_chests.length) break
                if (countBottles() === 0) break
                if (!progress) {
                    logger(`Attempt ${attempt}: hech narsa o'zgarmadi`)
                    break
                }
                await bot.waitForTicks(5)
            }

            // 5. Hammasi to'ldimi?
            if (fullChests.size >= island.deposit_chests.length) {
                // O'tkazib yuborilgan (topilmagan/yetib bo'lmagan) sandiq bo'lsa —
                // bu HAQIQIY to'liq emas, sana yozilmaydi va 'failed' qaytadi.
                if (skippedChests.size > 0) {
                    logger(`${island.orol_bot_username}: ${skippedChests.size} ta sandiq o'tkazib yuborildi (topilmadi/yetib bo'lmadi) — to'liq hisoblanmaydi`, 'muhim')
                    return 'failed'
                }
                island.last_full_deposit_date = new Date().toISOString()
                saveState()
                return 'done'
            }

            if (countBottles() > 0) {
                logger(`Trip ${trip}: ${fullChests.size}/${island.deposit_chests.length} sandiq to'ldi, bottle hali bor (${countBottles()}) — qayta urinamiz...`, 'muhim')
            } else {
                logger(`Trip ${trip}: ${fullChests.size}/${island.deposit_chests.length} sandiq to'ldi — bottle olib kelamiz...`, 'muhim')
            }
        }

        logger(`${island.orol_bot_username}: maksimal qatnov soniga yetdik`, 'muhim')
        return 'failed'
    }

    // Barcha orollarni ketma-ket to'ldiradi.
    // Qanday tugashidan qat'i nazar (muvaffaqiyat, xato, taslim) — oxirida
    // ALBATTA o'z oroliga qaytadi, boshqa orolda qolib ketmaydi.
    async function fillAllIslands() {
        if (busy) {
            logger('Bot hozir band — yangi vazifa boshlanmadi', 'muhim')
            return
        }
        busy = true
        try {
            logger(`\n===== ISLAND FILLER BOSHLANDI (${ISLANDS.length} ta orol) =====`, 'muhim')
            for (const island of ISLANDS) {
                if (disconnected) {
                    logger('Ulanish uzildi — island filler to\'xtadi (qayta ulangach avtomatik davom etadi)', 'muhim')
                    break
                }
                // orollar orasida o'lim bo'lgan bo'lsa — avval uyga qaytamiz
                await recoverAfterDeath()
                logger(`\n=== OROL: ${island.orol_bot_username} ===`, 'muhim')
                const result = await fillIsland(island)

                if (result === 'done') {
                    logger(`=== ${island.orol_bot_username} TO'LIQ TO'LDIRILDI ✔ (${island.last_full_deposit_date}) ===`, 'muhim')
                } else if (result === 'no_bottles') {
                    logger('!!! Glass_bottle tugadi — qolgan orollar to\'xtatildi !!!', 'muhim')
                    break
                } else {
                    logger(`!!! ${island.orol_bot_username} to'ldirilmadi — keyingi orolga o'tamiz !!!`, 'muhim')
                }
                await sleep(1000)
            }
            logger('\n===== ISLAND FILLER TUGADI =====', 'muhim')
        } catch (err) {
            logger(`Island filler xato: ${err.message}`, 'muhim')
        } finally {
            // qayerda va qanday tugagan bo'lsa ham — uyga qaytamiz
            await goHome()
            busy = false
        }
    }

    // ==================================================================
    // ======================= EVENT HANDLERLAR =========================
    // ==================================================================

    bot.on('messagestr', msg => {
        if (msg) logger(msg)
        // login so'rovi faqat bir marta bajariladi
        if (!loginTriggered && msg.toLowerCase().includes('login')) {
            loginTriggered = true
            startLogin()
        }
    })
    bot.on('login', () => {
        logger('Logged in', 'muhim')
    })
    // O'lim: mineflayer avtomatik respawn qiladi, keepInventory true —
    // bottle lar joyida. Faqat orolga qaytib ishni davom ettirish kerak.
    bot.on('death', () => {
        logger('☠ Bot o\'ldi! Respawndan keyin ish AVTOMATIK davom etadi', 'muhim')
        needHomeAfterDeath = true
    })
    bot.on('kicked', err => {
        logger(`Kicked: ${err}`, 'muhim')
    })
    bot.on('error', err => {
        logger(`Socket xato: ${err.message}`, 'muhim')
    })
    // Uzilib qolsa avtomatik qayta ulanadi; ish holati saqlanadi
    bot.on('end', reason => {
        disconnected = true
        if (busy) {
            resumeFillAfterReconnect = true
            logger('Ish uzilib qoldi — qayta ulangach AVTOMATIK davom ettiriladi', 'muhim')
        }
        logger(`Ulanish uzildi (${reason}) — ${CONFIG.reconnectDelayMs / 1000}s dan keyin qayta ulanamiz...`, 'muhim')
        setTimeout(createBot, CONFIG.reconnectDelayMs)
    })
    bot.on('whisper', async (user, msg) => {
        if (CONFIG.owners.includes(user)) {
            if (msg === 'drop') return drop()
            // === Island filler buyruqlari ===
            if (msg === 'fillislands') {
                await fillAllIslands();
                return;
            }
            if (msg.startsWith('fillisland ')) {
                const name = msg.split(' ')[1];
                const island = ISLANDS.find(i => i.orol_bot_username === name);
                if (!island) {
                    logger(`Orol topilmadi: ${name}`, 'muhim');
                    return;
                }
                if (busy) return logger('Bot band!', 'muhim');
                busy = true;
                try {
                    const result = await fillIsland(island);
                    logger(`${name}: ${result}`, 'muhim');
                } finally {
                    // bitta orol to'ldirilgandan keyin ham darhol uyga qaytamiz
                    await goHome();
                    busy = false;
                }
                return;
            }
            if (msg === 'restock') {
                if (busy) return logger('Bot band!', 'muhim');
                busy = true;
                try { await restockBottles(); } finally { busy = false; }
                return;
            }
            if (msg === 'home') {
                return goHome();
            }
            if (msg === 'status') {
                logger(`Bottles: ${countBottles()} | Busy: ${busy}`, 'muhim');
                for (const island of ISLANDS) {
                    logger(`  ${island.orol_bot_username}: last full = ${island.last_full_deposit_date || 'hech qachon'}`, 'muhim');
                }
                return;
            }
            // log darajasini ishlash paytida o'zgartirish: "loglevel muhim"
            if (msg.startsWith('loglevel ')) {
                const lvl = msg.split(' ')[1];
                if (LOG_LEVELS[lvl] === undefined) {
                    console.log(`Noto'g'ri daraja: ${lvl} (logsiz | muhim | barchasi)`);
                } else {
                    CONFIG.loggerType = lvl;
                    console.log(`Log darajasi o'zgartirildi: ${lvl}`);
                }
                return;
            }
            if (msg.startsWith('check ')) {
                const args = msg.split(' ')[1];
                const items = await bot.inventory.items().filter(item => item.name.includes(args));
                console.log(items);
                return
            }
            bot.chat(msg)
            return
        };
    })

    return bot
}


createBot()
