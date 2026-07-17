// ======================================================================
// CRAFTER BOT — o'z orolida ishlaydi:
//  - glass sandiqlaridan (y78) glass oladi
//  - crafting table da MAKSIMAL tezlikda glass_bottle craft qiladi
//  - tayyor bottle larni homeChestArea sandiqlariga (y79-81) joylaydi
//    (glassFiller.js boti aynan shu sandiqlardan bottle oladi)
//  - warp sandiqlariga sand va coal deposit qiladi (kerak bo'lsa shopdan olib)
// Orollarni glass_bottle bilan to'ldirish glassFiller.js botining ishi.
// ======================================================================
const mineflayer = require('mineflayer')
const pathfinder = require('mineflayer-pathfinder')
const craftEngine = require('mineflayer-craft-engine')
// homeChestArea, sandiq tartibi, log tizimi — glassFiller.js bilan YAGONA manbadan (shared.js)
const { HOME_CHEST_AREA, chestOrder, inHomeChestArea, LOG_LEVELS, shouldLog } = require('./shared')
const { Movements } = pathfinder
const { GoalBlock, GoalNear } = pathfinder.goals
const { Vec3 } = require('vec3')
const CONFIG = {
    owners: ['HAKIMOV', 'IveNeS_UZ'],
    // Log darajasi: 'logsiz' | 'muhim' | 'barchasi'
    // ("loglevel <daraja>" whisper buyrug'i bilan ishlash paytida o'zgartirsa bo'ladi)
    loggerType: 'muhim',
    // Tayyor glass_bottle lar FAQAT shu quti ichidagi sandiqlarga solinadi.
    // Qiymat shared.js dan — glassFiller.js bilan avtomatik bir xil:
    homeChestArea: HOME_CHEST_AREA,
    homeChestSearchRadius: 48,       // sandiq skanerlash radiusi
    craftingTableSearchRadius: 32,   // crafting table qidirish radiusi
    chestReachRange: 3,              // sandiqqa shu masofagacha yaqinlashadi
    pathfindTimeoutMs: 30000,        // pathfinding uchun maksimal vaqt
    chestOpenDelayMs: 20,            // sandiq ochilgandan keyingi kutish
    chestCloseDelayMs: 20,           // sandiq yopishdan oldingi kutish
    depositRetries: 3,               // deposit xatosida qayta urinishlar soni
    reconnectDelayMs: 5000,          // uzilganda qayta ulanish kutishi
    groundGlassRadius: 32,           // yerda yotgan glass droplarni shu radiusda qidiradi
    maxGroundPickups: 40,            // bitta siklda maksimal terish urinishlari
    cycleDelayMs: 250,               // sikllar orasidagi nafas — paket bosimini kamaytiradi
    resumeDelayMs: 6000,             // qayta ulangach ishni davom ettirishdan oldingi kutish
    craftCallTimeoutMs: 90000,       // bitta craft chaqirig'i uchun mutlaq limit
    // Craft rejimi (mineflayer-craft-engine):
    //  'adaptive' - avval Recipe Book fast usuli, ishlamasa avtomatik safe fallback
    //  'fast'     - faqat fast (fallback: false bo'lsa)
    //  'safe'     - faqat oddiy bot.craft (sekin, lekin har doim ishlaydi)
    craftMode: 'adaptive',
    craftWindowTimeoutMs: 5000,      // crafting oynasi ochilishini kutish
    craftFastTimeoutMs: 2500,        // fast craft natijasini kutish
    // ---- AUTO rejim (hosting uchun): craft har N daqiqada avtomatik ----
    autoStart: true,                 // bot yoqilganda AUTO rejim o'zi ishga tushadi
    autoIntervalMs: 30 * 60 * 1000,  // AUTO sikllar oralig'i (30 daqiqa)
    autoFirstDelayMs: 15000,         // logindan keyin birinchi siklgacha kutish
    lowGlassThreshold: 128,          // bir yig'ishda shundan kam glass chiqsa -> fill
}
const botConfig = {
    host: 'hypixel.uz',
    port: 25565,
    username: process.env.CRAFTER_USERNAME, // change username
    version: '1.18.2', // change version if needed (1.21.1 , 1.19.4 , 1.20.1)
    password: process.env.CRAFTER_PASSWORD, // change password
}

// xFrom dan xTo gacha bir qator sandiq pozitsiyalari (ikkala yo'nalishda ham)
function chestRow(y, z, xFrom, xTo) {
    const step = xFrom <= xTo ? 1 : -1
    const row = []
    for (let x = xFrom; x !== xTo + step; x += step) row.push(new Vec3(x, y, z))
    return row
}
// Warp sand sandiqlari (y82); har birining coal sandig'i bir blok pastida
const chests = {
    "1": chestRow(82, 5894, 3775, 3766),
    "2": chestRow(82, 5880, 3766, 3775),
}
const standPoss = [
    new Vec3(3773, 79, 5889),
    new Vec3(3768, 79, 5889),
    new Vec3(3768, 79, 5885),
    new Vec3(3773, 79, 5885),
]
// Glass sandiqlari (y78) — 5 tadan guruh, har guruh o'z stand pozitsiyasidan ochiladi
const glassChests = [
    // warp 1
    ...chestRow(78, 5892, 3775, 3771).map(pos => ({ pos, standPos: standPoss[0] })),
    ...chestRow(78, 5892, 3770, 3766).map(pos => ({ pos, standPos: standPoss[1] })),
    // warp 2
    ...chestRow(78, 5882, 3766, 3770).map(pos => ({ pos, standPos: standPoss[2] })),
    ...chestRow(78, 5882, 3771, 3775).map(pos => ({ pos, standPos: standPoss[3] })),
]

async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
// logger(msg) — oddiy log, faqat 'barchasi' rejimida ko'rinadi
// logger(msg, 'muhim') — muhim log, 'muhim' va 'barchasi' rejimlarida ko'rinadi
function logger(msg, level) { if (msg && shouldLog(CONFIG.loggerType, level)) console.log(msg) }
// Ulanish uzilganda ish holati shu yerda saqlanadi (createBot dan tashqarida) —
// yangi bot ulanib login qilgach ishni AVTOMATIK davom ettiradi
let resumeTaskAfterReconnect = null // 'craft' | 'fill' | 'auto'
// AUTO rejim holati ham qayta ulanishlarda saqlanib qoladi
let autoEnabled = CONFIG.autoStart
let nextAutoRunAt = 0 // keyingi AUTO sikl vaqti (timestamp), 0 = hali belgilanmagan
function createBot() {
    const bot = mineflayer.createBot(botConfig)
    bot.loadPlugin(pathfinder.pathfinder)
    bot.loadPlugin(craftEngine)
    let busy = false          // bir vaqtda faqat bitta katta vazifa
    let currentTask = null    // hozir bajarilayotgan vazifa: 'craft' | 'fill' | 'auto'
    let stopRequested = false // craft loop ni to'xtatish uchun
    let loginTriggered = false
    let disconnected = false  // ulanish o'lganda darhol true bo'ladi
    let needHomeAfterDeath = false // o'limdan keyin orolga qaytish kerakligini bildiradi

    // Ish davom ettirilishi mumkinmi? — har bir loop qadamida tekshiriladi.
    // Ulanish o'lgan zahoti bot uzun timeoutlarni kutmasdan ishni to'xtatadi.
    const aborted = () => stopRequested || disconnected || !bot.entity

    // Pluginlar 'inject_allowed' da yuklanadi — bot.craftEngine undan oldin undefined
    bot.once('inject_allowed', () => {
        // Craft engine hodisalarini kuzatamiz — fast usul ishlamay qolsa bilamiz
        bot.craftEngine.on('fastFallback', e => {
            logger(`Fast craft o'tmadi (${e.item}): ${e.error?.message || e.error} — safe rejimga o'tildi`, 'muhim')
        })
    })

    // Xavfsiz harakat: hech narsani sindirmaydi, blok qo'ymaydi, minoraga chiqmaydi
    bot.once('spawn', () => {
        const safeMoves = new Movements(bot)
        safeMoves.canDig = false
        safeMoves.allow1by1towers = false
        safeMoves.allowParkour = false
        safeMoves.scafoldingBlocks = []
        safeMoves.maxDropDown = 3
        // Rails ustidan yurish taqiqlanadi — minecartlarga xalaqit bermaslik uchun
        const railNames = ['rail', 'powered_rail', 'detector_rail', 'activator_rail']
        for (const name of railNames) {
            const railBlock = bot.registry.blocksByName[name]
            if (railBlock) safeMoves.blocksToAvoid.add(railBlock.id)
        }
        bot.pathfinder.setMovements(safeMoves)

        // fallback: server "login" so'ramasa ham resume urinib ko'ramiz
        setTimeout(() => { tryAutoResume() }, 15000)
    })

    // ==================================================================
    // ========================= UMUMIY HELPERLAR =======================
    // ==================================================================

    function countItem(name) {
        const def = bot.registry.itemsByName[name]
        if (!def) return 0
        return bot.inventory.count(def.id)
    }

    function getInventorySpaceFor(itemName) {
        const itemDef = bot.registry.itemsByName[itemName]
        const maxStack = itemDef ? itemDef.stackSize : 64
        let space = bot.inventory.emptySlotCount() * maxStack
        for (const item of bot.inventory.items()) {
            if (item.name === itemName) {
                space += maxStack - item.count
            }
        }
        return space
    }

    // Sandiqda itemName uchun qancha joy borligini hisoblaydi (bo'sh + chala stack lar)
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

    async function safeClose(chest) {
        try {
            await sleep(CONFIG.chestCloseDelayMs)
            await bot.closeWindow(chest)
        } catch (e) {
            // ignore
        }
    }

    // Pathfinding timeout bilan — osilib qolmaydi; ulanish o'lsa darhol chiqadi.
    // Watchdog goto tugashi bilan o'chadi — keyingi pathfindingga xalaqit bermaydi.
    async function gotoGoal(goal) {
        let finished = false
        const watchdog = (async () => {
            const start = Date.now()
            while (!finished && Date.now() - start < CONFIG.pathfindTimeoutMs) {
                if (disconnected) throw new Error('ulanish uzildi')
                await sleep(250)
            }
            if (finished) return
            bot.pathfinder.stop()
            throw new Error('pathfind timeout')
        })()
        try {
            await Promise.race([bot.pathfinder.goto(goal), watchdog])
        } finally {
            finished = true
        }
    }

    // Sandiq YONIGA borish — ustiga chiqmaydi, hech narsa sindirmaydi
    async function safeGoNear(pos, range = CONFIG.chestReachRange) {
        try {
            await gotoGoal(new GoalNear(pos.x, pos.y, pos.z, range))
            return true
        } catch (err) {
            logger(`Pathfinding xato (${pos}): ${err.message}`)
            if (!bot.entity) return false
            return bot.entity.position.distanceTo(pos) <= range + 2
        }
    }

    // Xavfsiz withdraw: "full" xatolarida miqdorni ikkiga bo'lib qayta uradi
    async function withdrawSafely(chest, item, amount) {
        let toWithdraw = Math.min(amount, item.count)
        while (toWithdraw > 0) {
            try {
                await chest.withdraw(item.type, item.metadata, toWithdraw)
                return toWithdraw
            } catch (err) {
                const message = err.message || String(err)
                if (message.includes('full') || message.includes('Unable to withdraw')) {
                    toWithdraw = Math.floor(toWithdraw / 2)
                    continue
                }
                logger(`Withdraw xato: ${message}`)
                return 0
            }
        }
        return 0
    }

    // Ochiq sandiqqa itemName ni imkon boricha soladi (desync da qayta uradi)
    async function depositToChest(chest, itemName) {
        let deposited = 0
        let failStreak = 0
        while (true) {
            const need = chestFreeSpaceFor(chest, itemName)
            if (need <= 0) break
            const stacks = bot.inventory.items().filter(i => i.name === itemName)
            if (stacks.length === 0) break
            const item = stacks[0]
            const amount = Math.min(item.count, need)
            try {
                await chest.deposit(item.type, item.metadata, amount)
                deposited += amount
                failStreak = 0
            } catch (err) {
                const message = err.message || String(err)
                if (message.includes('full')) break
                failStreak++
                if (failStreak >= CONFIG.depositRetries) {
                    logger(`Deposit xato (qayta urinishlar tugadi): ${message}`)
                    break
                }
                // inventar sinxronlanishini kutib qayta uramiz
                await bot.waitForTicks(5)
            }
            await bot.waitForTicks(1)
        }
        return deposited
    }

    // Sandiq blokini ochib itemName ni soladi; qattiq desync da qayta ochadi
    async function openAndDepositAll(block, itemName) {
        let totalDeposited = 0
        for (let attempt = 0; attempt < 2; attempt++) {
            let chest
            try {
                chest = await bot.openChest(block)
            } catch (err) {
                logger(`Sandiqni ochib bo'lmadi: ${err.message}`)
                return { deposited: totalDeposited, chestFull: false }
            }
            await sleep(CONFIG.chestOpenDelayMs)

            totalDeposited += await depositToChest(chest, itemName)
            const chestFull = chestFreeSpaceFor(chest, itemName) <= 0
            await safeClose(chest)

            if (chestFull || countItem(itemName) === 0) {
                return { deposited: totalDeposited, chestFull }
            }
            // joy bor, item bor, lekin solinmadi — bir marta qayta ochib ko'ramiz
            await bot.waitForTicks(5)
        }
        return { deposited: totalDeposited, chestFull: false }
    }

    async function startLogin() {
        bot.chat(`/login ${botConfig.password}`)
        await sleep(500)
        bot.chat('/is go')
        // uzilishdan oldin ish bo'lgan bo'lsa — davom ettiramiz
        tryAutoResume()
    }

    // O'limdan keyin tiklanish: respawn bo'lgach /is go bilan orolga qaytadi.
    // keepInventory true — buyumlar yo'qolmaydi, ish shunchaki davom etadi.
    // Loop ichidan chaqiriladi, shuning uchun ish oqimi bilan to'qnashmaydi.
    async function recoverAfterDeath() {
        if (!needHomeAfterDeath) return
        needHomeAfterDeath = false
        logger('>> Respawn — /is go bilan orolga qaytib ishni davom ettiramiz', 'muhim')
        try {
            bot.pathfinder.stop()
            bot.clearControlStates()
            await sleep(1500)
            bot.chat('/is go')
            await sleep(3000)
            try { await bot.waitForChunksToLoad() } catch (e) { /* ignore */ }
        } catch (e) {
            logger(`Death recovery xato: ${e.message}`, 'muhim')
        }
    }

    // Katta vazifalarni bitta joydan boshqarish: bir vaqtda faqat bittasi,
    // currentTask esa resume va whisper javoblari uchun ishlatiladi
    async function runTask(name, fn) {
        if (busy) return logger('Bot band!', 'muhim')
        busy = true
        currentTask = name
        try { await fn() } finally { busy = false; currentTask = null }
    }

    // Qayta ulanishdan keyin uzilib qolgan vazifani avtomatik davom ettiradi
    async function tryAutoResume() {
        if (!resumeTaskAfterReconnect) return
        await sleep(CONFIG.resumeDelayMs)
        if (!resumeTaskAfterReconnect || busy || disconnected) return
        const task = resumeTaskAfterReconnect
        resumeTaskAfterReconnect = null
        logger(`>> Uzilishdan oldingi "${task}" vazifasi avtomatik davom ettirilmoqda...`, 'muhim')
        if (task === 'craft') await runTask('craft', craftLoop)
        else if (task === 'fill') await runTask('fill', fillAllWarps)
        else await runTask('auto', autoCycle)
    }

    async function drop() {
        try {
            const items = bot.inventory.items()
            for (const item of items) {
                await bot.tossStack(item)
                logger(`Dropped ${item.count} of ${item.name}`)
                await sleep(100)
            }
        } catch (error) {
            logger(`Error dropping items: ${error}`)
        }
    }

    // ==================================================================
    // ================ WARP SAND/COAL FILLER QISMI =====================
    // ==================================================================

    async function goWarp(warp) {
        bot.chat(`/is warp ${warp}`)
        await sleep(1500)
        logger(`Warped to ${warp}`)
    }

    // ============== INVENTAR TOZALASH (vazifadan oldin) ===============
    // Ortiqcha itemlarni O'Z sandiqlariga joylaydi: sand/coal -> warp
    // sandiqlari, glass -> glass sandiqlari. exclude — joriy vazifaga
    // kerakli itemlar (inventarda qoladi). Bo'sh inventar = shop xaridi
    // va glass yig'ish uchun maksimal joy.
    async function stashInventory(exclude = []) {
        const stash = ['sand', 'coal', 'glass']
            .filter(n => !exclude.includes(n))
            // 3 tadan kam glass uchun yurib o'tirmaymiz (craft ham bo'lmaydi)
            .filter(n => countItem(n) >= (n === 'glass' ? 3 : 1))
        if (stash.length === 0) return

        logger(`Inventar tozalanmoqda: ${stash.map(n => `${countItem(n)} ${n}`).join(', ')}`, 'muhim')

        // 1. glass -> glass sandiqlariga (orolda, yurib boriladi)
        if (stash.includes('glass')) await stashGlass()

        // 2. sand/coal -> warp sandiqlariga
        const warpItems = stash.filter(n => n !== 'glass')
        if (warpItems.length === 0) return
        for (const warp of Object.keys(chests)) {
            if (aborted() || needHomeAfterDeath) return
            if (!warpItems.some(n => countItem(n) > 0)) break
            await goWarp(warp)
            for (const itemName of warpItems) {
                await stashToWarpChests(warp, itemName)
            }
        }
        // warpda qolib ketmaslik uchun orolga qaytamiz
        if (!disconnected) {
            bot.chat('/is go')
            await sleep(1500)
        }
    }

    // Warp sandiqlariga bitta item turini joylaydi (inventar bo'shaguncha)
    async function stashToWarpChests(warp, itemName) {
        const chestList = chests[warp.toString()]
        for (const base of chestList) {
            if (aborted() || needHomeAfterDeath) return
            if (countItem(itemName) === 0) return
            const pos = itemName === 'sand' ? base : base.offset(0, -1, 0)
            const block = bot.blockAt(pos)
            if (!block || block.name !== 'chest') continue
            let chest
            try {
                chest = await bot.openChest(block)
            } catch (err) {
                logger(`Sandiq ochilmadi (${pos}): ${err.message}`)
                continue
            }
            await sleep(CONFIG.chestOpenDelayMs)
            await depositToChest(chest, itemName)
            await safeClose(chest)
        }
    }

    // Glass sandiqlariga inventardagi glassni joylaydi (gatherGlass ning teskarisi)
    async function stashGlass() {
        let lastStand = null
        for (const gc of glassChests) {
            if (aborted() || needHomeAfterDeath) return
            if (countItem('glass') === 0) return

            if (!lastStand || !lastStand.equals(gc.standPos)) {
                try {
                    await gotoGoal(new GoalBlock(gc.standPos.x, gc.standPos.y, gc.standPos.z))
                    lastStand = gc.standPos
                } catch (err) {
                    logger(`Stand pozitsiyaga borilmadi (${gc.standPos}): ${err.message}`)
                    lastStand = null
                    continue
                }
            }

            const block = bot.blockAt(gc.pos)
            if (!block || !block.name.includes('chest')) continue
            let chest
            try {
                chest = await bot.openChest(block)
            } catch (err) {
                logger(`Glass sandiq ochilmadi (${gc.pos}): ${err.message}`)
                continue
            }
            await sleep(CONFIG.chestOpenDelayMs)
            await depositToChest(chest, 'glass')
            await safeClose(chest)
        }
    }

    async function fillAllWarps() {
        stopRequested = false // avvalgi "stop" flagi yangi ishga xalaqit bermasin

        // Shop xariddan oldin inventarni bo'shatamiz: glass o'z sandiqlariga
        // ketadi (sand/coal fill jarayonining o'ziga kerak — qoladi)
        await stashInventory(['sand', 'coal'])

        for (const warp of Object.keys(chests)) { // ["1","2"]
            if (aborted()) break
            // o'limdan keyin avval orolga qaytamiz, /is warp qayta yuboriladi
            await recoverAfterDeath()
            logger(`\n=== START WARP ${warp} ===`, 'muhim')
            await goWarp(warp)

            // sand → coal
            await fillChests(warp, 'sand')
            await fillChests(warp, 'coal')

            logger(`=== DONE WARP ${warp} ===\n`, 'muhim')
        }

        if (!disconnected) bot.chat('/is go')
        logger('ALL WARPS DONE', 'muhim')
    }

    // To'ldirish tizimi: har aylanishda (round) BARCHA sandiqlar boshidan
    // ochib chiqiladi — inventardagi item joyi borlariga solinadi va jami
    // yana qancha kerakligi hisoblanadi. Keyin shu miqdor (yoki inventarga
    // sig'ganicha) shopdan BIR YO'LA sotib olinadi va aylanish takrorlanadi.
    // Hammasi to'lganda yoki shop item bermay qo'yganda to'xtaydi.
    async function fillChests(warp = 1, mode = 'sand') {
        const chestList = chests[warp.toString()]
        const itemName = mode === 'sand' ? 'sand' : 'coal'
        const maxRounds = 40 // himoya: cheksiz aylanib qolmaslik uchun

        logger(`Starting ${mode} filling...`)

        // i-sandiqning haqiqiy pozitsiyasi (coal sandig'i bir blok pastda)
        const chestPos = (i) =>
            mode === 'sand' ? chestList[i] : chestList[i].offset(0, -1, 0)

        // Bitta aylanish: barcha sandiqlarni ro'yxat tartibida ochadi,
        // inventardagi itemni soladi, jami qolgan ehtiyojni qaytaradi
        // (-1 = stop/uzilish/o'lim tufayli chala qoldi)
        async function fillPass() {
            let totalNeed = 0
            for (let i = 0; i < chestList.length; i++) {
                if (aborted() || needHomeAfterDeath) return -1
                const pos = chestPos(i)
                const block = bot.blockAt(pos)
                if (!block || block.name !== 'chest') {
                    logger(`No ${mode} chest ${i}`)
                    continue
                }

                // 2 urinish: joy va item bor turib deposit o'tmasa (inventar
                // desync) sandiq qayta ochiladi — server to'liq holatni qayta
                // yuborib sinxronlikni tiklaydi
                let space = 0
                for (let attempt = 0; attempt < 2; attempt++) {
                    let chest
                    try {
                        chest = await bot.openChest(block)
                    } catch (err) {
                        logger(`Sandiq ochilmadi (${pos}): ${err.message}`)
                        break
                    }
                    await sleep(CONFIG.chestOpenDelayMs)

                    space = chestFreeSpaceFor(chest, itemName)
                    if (space > 0 && countItem(itemName) > 0) {
                        space -= await depositToChest(chest, itemName)
                    }
                    await safeClose(chest)

                    if (space <= 0 || countItem(itemName) === 0) break
                    if (attempt === 0) {
                        logger(`Deposit to'liq o'tmadi (${pos}) — sandiq qayta ochiladi`)
                        await bot.waitForTicks(5)
                    }
                }
                totalNeed += Math.max(0, space)
            }
            return totalNeed
        }

        for (let round = 1; round <= maxRounds; round++) {
            // 1. barcha sandiqlarni ochib tekshiramiz + bor itemni solamiz
            const totalNeed = await fillPass()
            if (totalNeed < 0) break
            if (totalNeed <= 0) {
                logger(`${mode}: barcha sandiqlar to'la (${round} aylanishda)`, 'muhim')
                break
            }

            // 2. kerakli jami miqdorni (yoki inventarga sig'ganicha) shopdan olamiz
            const toBuy = Math.min(totalNeed, getInventorySpaceFor(itemName))
            if (toBuy <= 0) break
            logger(`${mode}: yana ${totalNeed} kerak — shopdan ${toBuy} olinmoqda (round ${round})`)
            const bought = await buyFromShop(mode, toBuy)
            if (bought <= 0) {
                logger(`Shopdan ${mode} olinmadi — to'ldirish chala qoldi (yana ${totalNeed} kerak)`, 'muhim')
                break
            }
            await sleep(150)
            // 3. keyingi aylanishda sandiqlar boshidan to'ldiriladi
        }

        logger(`${mode} filling DONE`)
    }

    // Shopdan item sotib oladi. SHIFT+chap klik bilan har bosishda TO'LIQ STACK
    // (64 ta) olinadi — oddiy klikdan (8/16) bir necha barobar tez. Shift-click
    // bu serverda o'tmasa avtomatik oddiy klikka qaytadi. "Your inventory is
    // full!" xabari kelsa darhol to'xtaydi — bosib vaqt ketkazmaydi.
    // Qaytaradi: real sotib olingan miqdor (0 = hech narsa olinmadi).
    function buyFromShop(type, amount) {
        return new Promise((resolve) => {
            const slotNumber = type === 'sand' ? 30 : 11
            const category = type === 'sand' ? 'Blocks' : 'Ores'
            const before = countItem(type)
            let invFull = false
            let finished = false

            const onMsg = (msg) => {
                if (msg && msg.includes('Your inventory is full!')) invFull = true
            }
            const finish = (result) => {
                if (finished) return
                finished = true
                clearTimeout(timeout)
                bot.removeListener('windowOpen', onWindow)
                bot.removeListener('messagestr', onMsg)
                resolve(result)
            }

            // klikdan keyin inventar soni o'zgarishini kutadi (maks ~8 tick)
            const waitGain = async (prev) => {
                for (let t = 0; t < 8; t++) {
                    await bot.waitForTicks(1)
                    if (countItem(type) !== prev) return countItem(type) - prev
                }
                return 0
            }

            // RAW klik paketi — bot.clickWindow ISHLATILMAYDI: u shop GUI da
            // lokal simulyatsiya qilib inventarni desync qiladi ("Can't find
            // ... in slots" xatosi, keyin ReadTimeout kick). Raw paketda holatni
            // faqat serverdan kelgan set_slot/window_items paketlari yangilaydi.
            const rawClick = (w, mode) => {
                const Item = require('prismarine-item')(bot.registry)
                bot._client.write('window_click', {
                    windowId: w.id,
                    stateId: w.stateId ?? -1,
                    slot: slotNumber,
                    mouseButton: 0,
                    mode, // 1 = shift-click (to'liq stack), 0 = oddiy klik
                    changedSlots: [],
                    cursorItem: Item.toNotch(null), // qo'l bo'sh
                })
            }

            const onWindow = async (w) => {
                clearTimeout(timeout)
                try {
                    if (!w.title.includes(category)) {
                        try { await bot.closeWindow(w) } catch (e) { /* ignore */ }
                        return finish(0)
                    }

                    let clickMode = 1 // 1 = shift-click (64 ta), 0 = oddiy klik
                    let noProgress = 0
                    await bot.waitForTicks(1)

                    while (!invFull && !disconnected && !stopRequested) {
                        const bought = countItem(type) - before
                        if (bought >= amount) break
                        if (getInventorySpaceFor(type) <= 0) break

                        const prev = countItem(type)
                        rawClick(w, clickMode)

                        const gained = await waitGain(prev)
                        if (gained > 0) {
                            noProgress = 0
                        } else if (clickMode === 1) {
                            // shift bosildi lekin item kelmadi — oddiy klikka qaytamiz
                            clickMode = 0
                            noProgress = 0
                        } else if (++noProgress >= 3) {
                            break // pul tugagan yoki shop javob bermayapti
                        }
                    }

                    await sleep(150)
                    try { await bot.closeWindow(w) } catch (e) { /* ignore */ }
                } catch (err) {
                    logger(`Shop klik xato: ${err.message}`)
                }
                finish(Math.max(0, countItem(type) - before))
            }

            // timeout bo'lsa listenerlar ham olib tashlanadi — leak qolmaydi
            const timeout = setTimeout(() => finish(0), 15000)

            bot.on('messagestr', onMsg)
            bot.once('windowOpen', onWindow)
            bot.chat(`/is shop ${category}`)
        })
    }

    // ==================================================================
    // ============== GLASS -> BOTTLE CRAFT & DEPOSIT QISMI =============
    // ==================================================================

    // Yerda drop bo'lib yotgan glass entitylarini topadi (yaqinidan boshlab)
    function findGroundGlass() {
        const glassDef = bot.registry.itemsByName.glass
        if (!glassDef) return []
        return Object.values(bot.entities)
            .filter(e => {
                if (!e || !e.position || !e.isValid) return false
                if (e.name !== 'item' && e.name !== 'Item') return false
                if (e.position.distanceTo(bot.entity.position) > CONFIG.groundGlassRadius) return false
                const stack = typeof e.getDroppedItem === 'function' ? e.getDroppedItem() : null
                return stack != null && stack.type === glassDef.id
            })
            .sort((a, b) =>
                a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position)
            )
    }

    // Yerda yotgan glass droplarni terib oladi. Drop bo'lmasa bitta skanerdan
    // keyin darhol chiqadi — tezlikka ta'sir qilmaydi. Terilgan glass bilan
    // ALOHIDA craft qilinmaydi: gatherGlass davomida sandiqlardan to'ldirilib,
    // craft har doim to'liq inventar bilan ketadi.
    async function pickupGroundGlass() {
        let pickedTotal = 0
        const failed = new Set()

        for (let attempt = 0; attempt < CONFIG.maxGroundPickups; attempt++) {
            if (aborted() || needHomeAfterDeath) break
            if (getInventorySpaceFor('glass') <= 0) break

            const drops = findGroundGlass().filter(e => !failed.has(e.id))
            if (drops.length === 0) break

            const target = drops[0]
            const before = countItem('glass')

            await safeGoNear(target.position, 1)

            // olinishini kutamiz: entity yo'qoladi yoki glass soni oshadi
            let picked = false
            for (let t = 0; t < 20; t++) { // maksimal ~2s
                await sleep(100)
                if (!bot.entities[target.id] || countItem('glass') > before) {
                    picked = true
                    break
                }
            }

            if (picked) {
                pickedTotal += Math.max(0, countItem('glass') - before)
            } else {
                failed.add(target.id) // yetib bo'lmadi — qayta urinmaymiz
            }
        }

        if (pickedTotal > 0) logger(`Yerdan terildi: +${pickedTotal} glass`)
        return pickedTotal
    }

    // Glass yig'ish: AVVAL yerda yotgan droplar, KEYIN sandiqlardan
    // (glassChests, ro'yxat tartibida — bir boshidan) inventar to'lguncha
    async function gatherGlass() {
        let gathered = 0
        let lastStand = null

        // 1. yerda to'kilib yotgan glass bo'lsa — birinchi ularni teramiz
        gathered += await pickupGroundGlass()

        for (let i = 0; i < glassChests.length; i++) {
            if (aborted() || needHomeAfterDeath) break
            if (getInventorySpaceFor('glass') <= 0) break

            const gc = glassChests[i]

            // Sandiqni ochish — 2 urinish: pathfinding xatosi, chunk hali
            // yuklanmagani yoki openChest timeout tufayli sandiq o'tkazib
            // yuborilmasligi uchun har bosqich qayta uriniladi
            let chest = null
            for (let attempt = 0; attempt < 2 && !chest; attempt++) {
                if (aborted() || needHomeAfterDeath) break

                // bir xil stand pozitsiyadagi sandiqlar uchun qayta yurmaymiz
                if (!lastStand || !lastStand.equals(gc.standPos)) {
                    try {
                        await gotoGoal(new GoalBlock(gc.standPos.x, gc.standPos.y, gc.standPos.z))
                        lastStand = gc.standPos
                    } catch (err) {
                        logger(`Stand pozitsiyaga borilmadi (${gc.standPos}): ${err.message}`)
                        lastStand = null
                        continue
                    }
                }

                const block = bot.blockAt(gc.pos)
                if (!block || !block.name.includes('chest')) {
                    // chunk hali yuklanmagan bo'lishi mumkin — biroz kutamiz
                    logger(`Glass chest ${i} hali ko'rinmayapti (${gc.pos})`)
                    await bot.waitForTicks(10)
                    continue
                }

                try {
                    chest = await bot.openChest(block)
                } catch (err) {
                    logger(`Glass sandiq ochilmadi (${gc.pos}): ${err.message}`)
                    await bot.waitForTicks(10)
                }
            }
            if (!chest) {
                logger(`Glass chest ${i} (${gc.pos}) o'tkazib yuborildi!`, 'muhim')
                continue
            }
            await sleep(CONFIG.chestOpenDelayMs)

            while (true) {
                const space = getInventorySpaceFor('glass')
                if (space <= 0) break
                const glassStacks = chest.containerItems().filter(it => it && it.name === 'glass')
                if (glassStacks.length === 0) break
                const got = await withdrawSafely(chest, glassStacks[0], Math.min(glassStacks[0].count, space))
                if (got === 0) break
                gathered += got
                await bot.waitForTicks(1)
            }

            await safeClose(chest)
        }

        if (gathered > 0) logger(`Glass yig'ildi: +${gathered} (inventarda: ${countItem('glass')})`)
        return gathered
    }

    // Inventardagi BARCHA glass ni glass_bottle ga craft qiladi.
    // mineflayer-craft-engine ishlatiladi: Recipe Book protokoli orqali
    // server crafting gridni O'ZI to'ldiradi (craft_recipe_request paketi),
    // bot faqat natijani yig'ib oladi — bot.craft dan ko'p barobar tez.
    // Fast usul o'tmasa 'adaptive' rejim avtomatik safe (bot.craft) ga qaytadi.
    async function craftBottles() {
        if (countItem('glass') < 3) return 0 // bitta craft uchun ham glass yetmaydi

        // crafting table ni topamiz va yoniga boramiz
        const tableDef = bot.registry.blocksByName.crafting_table
        if (!tableDef) {
            logger('crafting_table registry da topilmadi!', 'muhim')
            return 0
        }
        const table = bot.findBlock({
            matching: tableDef.id,
            maxDistance: CONFIG.craftingTableSearchRadius,
        })
        if (!table) {
            logger(`Crafting table topilmadi! (radius: ${CONFIG.craftingTableSearchRadius})`, 'muhim')
            return 0
        }

        const reached = await safeGoNear(table.position, CONFIG.chestReachRange)
        if (!reached) {
            logger('Crafting table ga yetib bo\'lmadi', 'muhim')
            return 0
        }

        const before = countItem('glass_bottle')
        const craftStart = Date.now()
        try {
            // mutlaq limit bilan — ulanish o'lsa cheksiz osilib qolmaydi
            const result = await Promise.race([
                bot.craftEngine.craft({
                    item: 'glass_bottle',
                    amount: 'all', // inventardagi barcha glass tugaguncha
                    table: [table.position.x, table.position.y, table.position.z],
                    mode: CONFIG.craftMode,
                    windowTimeoutMs: CONFIG.craftWindowTimeoutMs,
                    fastTimeoutMs: CONFIG.craftFastTimeoutMs,
                }),
                sleep(CONFIG.craftCallTimeoutMs).then(() => {
                    throw new Error(`craft ${CONFIG.craftCallTimeoutMs / 1000}s da tugamadi`)
                })
            ])
            const sec = ((Date.now() - craftStart) / 1000).toFixed(1)
            logger(`Craft: +${result.crafted} glass_bottle (${sec}s, mode: ${result.mode})`)
            return result.crafted
        } catch (err) {
            // qisman craft bo'lgan bo'lishi mumkin — haqiqiy natijani hisoblaymiz
            const made = Math.max(0, countItem('glass_bottle') - before)
            logger(`Craft xato: ${err.message} (qisman: +${made})`, 'muhim')
            return made
        }
    }

    // Tayyor bottle larni homeChestArea sandiqlariga soladi.
    // Sandiqlar deterministik tartibda (chestOrder) — har doim bir boshidan.
    async function depositBottlesHome() {
        if (countItem('glass_bottle') === 0) return 0

        const chestBlockIds = []
        if (bot.registry.blocksByName.chest) chestBlockIds.push(bot.registry.blocksByName.chest.id)
        if (bot.registry.blocksByName.trapped_chest) chestBlockIds.push(bot.registry.blocksByName.trapped_chest.id)

        const positions = bot.findBlocks({
            matching: chestBlockIds,
            maxDistance: CONFIG.homeChestSearchRadius,
            count: 256,
        })
            .filter(p => inHomeChestArea(p))
            .sort(chestOrder)

        if (positions.length === 0) {
            logger('homeChestArea ichida sandiq topilmadi!', 'muhim')
            return 0
        }

        let total = 0
        for (const p of positions) {
            if (aborted() || needHomeAfterDeath) break
            if (countItem('glass_bottle') === 0) break

            const block = bot.blockAt(p)
            if (!block || !block.name.includes('chest')) continue

            const reached = await safeGoNear(p, CONFIG.chestReachRange)
            if (!reached) {
                logger(`Sandiqqa yetib bo'lmadi: ${p} — keyingisiga o'tamiz`)
                continue
            }

            const { deposited } = await openAndDepositAll(block, 'glass_bottle')
            if (deposited > 0) {
                total += deposited
                logger(`(${p.x}, ${p.y}, ${p.z}): +${deposited} bottle`)
            }
        }

        return total
    }

    // Asosiy sikl: glass yig'ish -> craft -> deposit, glass tugaguncha
    // yoki deposit sandiqlar to'lguncha. "stop" whisper bilan to'xtatiladi.
    // Qaytaradi: true = glass zaxirasi tugayapti (AUTO rejimda fill kerak)
    async function craftLoop() {
        stopRequested = false
        const startTime = Date.now()
        let totalBottles = 0
        let cycle = 0
        let lowGlass = false

        logger('\n===== CRAFT LOOP BOSHLANDI =====', 'muhim')

        // Ishdan oldin inventarni bo'shatamiz: sand/coal warp sandiqlariga
        // ketadi (glass craft uchun kerak — inventarda qoladi)
        await stashInventory(['glass'])

        // inventarda avvalgi siklning bottle lari qolgan bo'lsa — avval topshiramiz
        if (countItem('glass_bottle') > 0) {
            totalBottles += await depositBottlesHome()
        }

        while (!aborted()) {
            cycle++
            const cycleStart = Date.now()

            // o'limdan keyin avval orolga qaytamiz, keyin ish davom etadi
            await recoverAfterDeath()

            // 1. glass yig'ish
            const got = await gatherGlass()
            if (disconnected) break
            if (needHomeAfterDeath) { await recoverAfterDeath(); continue }
            if (countItem('glass') < 3) {
                lowGlass = true
                logger('Glass tugadi — craft loop yakunlandi', 'muhim')
                break
            }
            // Sandiqlardan chegaradan kam yig'ildi — zaxira tugayapti:
            // qo'ldagi glassni craft qilib bo'lib chiqamiz (oxirgi sikl)
            if (got < CONFIG.lowGlassThreshold) lowGlass = true

            // 2. craft
            const made = await craftBottles()
            if (disconnected) break
            if (needHomeAfterDeath) { await recoverAfterDeath(); continue }
            if (made === 0) {
                logger('Craft qilinmadi — craft loop yakunlandi', 'muhim')
                break
            }

            // 3. deposit
            const dep = await depositBottlesHome()
            totalBottles += dep
            if (disconnected) break
            if (needHomeAfterDeath) { await recoverAfterDeath(); continue }

            if (countItem('glass_bottle') > 0) {
                logger('Deposit sandiqlarning hammasi to\'la — craft loop yakunlandi', 'muhim')
                break
            }

            const cycleSec = ((Date.now() - cycleStart) / 1000).toFixed(1)
            const perMin = Math.round(totalBottles / ((Date.now() - startTime) / 60000))
            logger(`Cycle ${cycle}: +${dep} bottle (${cycleSec}s) | tezlik: ~${perMin} bottle/min`, 'muhim')

            if (lowGlass) {
                logger(`Glass kam yig'ildi (<${CONFIG.lowGlassThreshold}) — craft loop yakunlandi`, 'muhim')
                break
            }

            // serverga nafas — paket bosimini kamaytiradi (ReadTimeout profilaktikasi)
            await sleep(CONFIG.cycleDelayMs)
        }

        const totalMin = ((Date.now() - startTime) / 60000).toFixed(1)
        if (disconnected) {
            logger(`===== CRAFT LOOP UZILDI (${totalBottles} bottle, ${totalMin} min) — qayta ulangach avtomatik davom etadi =====`, 'muhim')
        } else {
            await bot.chat('/is go')
            logger(`===== CRAFT LOOP TUGADI: ${totalBottles} bottle, ${totalMin} min =====`, 'muhim')
        }
        return lowGlass
    }

    // ==================================================================
    // ==================== AUTO REJIM (30 daqiqalik) ===================
    // ==================================================================

    // Bitta AUTO sikl: craft loop; agar glass zaxirasi tugayotgan bo'lsa
    // (bir yig'ishda lowGlassThreshold dan kam chiqsa) — fill ishga tushadi.
    // fillAllWarps o'zi tugagach /is go bilan orolga qaytaradi.
    async function autoCycle() {
        const lowGlass = await craftLoop()
        if (lowGlass && !aborted() && !needHomeAfterDeath) {
            logger('>>> AUTO: glass zaxirasi kam — sand/coal FILL boshlanmoqda', 'muhim')
            await fillAllWarps()
        }
    }

    // Keyingi AUTO siklgacha qolgan vaqt (whisper javoblari uchun)
    function fmtNextRun() {
        if (busy) return `hozir ishlayapti (${currentTask})`
        if (!autoEnabled) return 'AUTO o\'chiq'
        if (nextAutoRunAt === 0) return 'login kutilmoqda'
        const ms = nextAutoRunAt - Date.now()
        if (ms <= 0) return 'bir necha soniyada'
        return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`
    }

    // Rejalashtiruvchi: har 5s da tekshiradi, vaqti kelganda autoCycle ni
    // ishga tushiradi. Interval sikl BOSHLANISHIDAN hisoblanadi; sikl 30
    // daqiqadan cho'zilib ketsa, keyingisi tugashi bilan darhol boshlanadi.
    const autoTimer = setInterval(async () => {
        if (disconnected || !autoEnabled || busy || !bot.entity) return
        if (nextAutoRunAt === 0) {
            // birinchi ishga tushish — login va /is go uchun ozgina kutamiz
            nextAutoRunAt = Date.now() + CONFIG.autoFirstDelayMs
            return
        }
        if (Date.now() < nextAutoRunAt) return
        nextAutoRunAt = Date.now() + CONFIG.autoIntervalMs
        resumeTaskAfterReconnect = null // yangi sikl eski chala ishni bekor qiladi
        logger(`\n>>> AUTO SIKL boshlandi (keyingisi: ${new Date(nextAutoRunAt).toLocaleTimeString()})`, 'muhim')
        await runTask('auto', autoCycle)
    }, 5000)

    // ==================================================================
    // ======================= EVENT HANDLERLAR =========================
    // ==================================================================

    bot.on('messagestr', msg => {
        if (!msg) return
        logger(msg)
        // login so'rovi faqat bir marta bajariladi (har xil xabarlarda "login"
        // so'zi uchrasa qayta-qayta yubormaslik uchun)
        if (!loginTriggered && msg.toLowerCase().includes('login')) {
            loginTriggered = true
            startLogin()
        }
    })
    bot.on('login', () => {
        logger('Logged in', 'muhim')
    })
    // O'lim: mineflayer avtomatik respawn qiladi, keepInventory true —
    // buyumlar joyida. Faqat orolga qaytib ishni davom ettirish kerak.
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
        clearInterval(autoTimer)
        if (busy && currentTask && !stopRequested) {
            resumeTaskAfterReconnect = currentTask
            logger(`Ish (${currentTask}) uzilib qoldi — qayta ulangach AVTOMATIK davom ettiriladi`, 'muhim')
        }
        logger(`Ulanish uzildi (${reason}) — ${CONFIG.reconnectDelayMs / 1000}s dan keyin qayta ulanamiz...`, 'muhim')
        setTimeout(createBot, CONFIG.reconnectDelayMs)
    })
    // Owner ga javob: konsolga ham, o'yin ichiga whisper bilan ham boradi —
    // hostingda bot loglarini ochmasdan holatni bilish uchun
    function reply(user, text) {
        logger(text, 'muhim')
        try { bot.chat(`/msg ${user} ${text}`) } catch (e) { /* ignore */ }
    }

    bot.on('whisper', async (user, msg) => {
        if (!CONFIG.owners.includes(user)) return

        if (msg === 'drop') return drop()
        if (msg === 'stop') {
            stopRequested = true
            resumeTaskAfterReconnect = null // auto-resume ham bekor qilinadi
            reply(user, `STOP — joriy ish to'xtatiladi${autoEnabled ? ' (AUTO hali yoniq, butunlay o\'chirish: "auto off")' : ''}`)
            return
        }
        if (msg === 'fill') {
            if (busy) return reply(user, `Bot band (${currentTask})!`)
            await runTask('fill', fillAllWarps)
            return
        }
        // craft (yoki eski nomi go) — glass -> bottle -> deposit sikli
        if (msg === 'craft' || msg === 'go') {
            if (busy) return reply(user, `Bot band (${currentTask})!`)
            await runTask('craft', craftLoop)
            return
        }
        // ---- AUTO rejim boshqaruvi ----
        if (msg === 'auto on') {
            autoEnabled = true
            if (nextAutoRunAt === 0) nextAutoRunAt = Date.now() + 5000
            reply(user, `AUTO yoqildi — keyingi sikl: ${fmtNextRun()}`)
            return
        }
        if (msg === 'auto off') {
            autoEnabled = false
            reply(user, `AUTO o'chirildi${busy ? ` (joriy "${currentTask}" oxirigacha davom etadi)` : ''}`)
            return
        }
        // navbatni kutmasdan AUTO siklni darhol boshlash
        if (msg === 'auto now') {
            if (busy) return reply(user, `Bot band (${currentTask})!`)
            nextAutoRunAt = Date.now() + CONFIG.autoIntervalMs
            reply(user, 'AUTO sikl darhol boshlanmoqda')
            await runTask('auto', autoCycle)
            return
        }
        // keyingi AUTO sikl qachonligini bilish
        if (msg === 'next') {
            reply(user, `Keyingi AUTO sikl: ${fmtNextRun()}`)
            return
        }
        if (msg === 'status') {
            reply(user, `Busy: ${busy}${currentTask ? ` (${currentTask})` : ''} | AUTO: ${autoEnabled ? 'ON' : 'OFF'} | Keyingi sikl: ${fmtNextRun()} | Glass: ${countItem('glass')} | Bottles: ${countItem('glass_bottle')}`)
            return
        }
        // log darajasini ishlash paytida o'zgartirish: "loglevel muhim"
        if (msg.startsWith('loglevel ')) {
            const lvl = msg.split(' ')[1]
            if (LOG_LEVELS[lvl] === undefined) {
                console.log(`Noto'g'ri daraja: ${lvl} (logsiz | muhim | barchasi)`)
            } else {
                CONFIG.loggerType = lvl
                console.log(`Log darajasi o'zgartirildi: ${lvl}`)
            }
            return
        }
        if (msg.startsWith('check ')) {
            const args = msg.split(' ')[1]
            const items = bot.inventory.items().filter(item => item.name.includes(args))
            console.log(items)
            return
        }
        bot.chat(msg)
    })

    return bot
}


createBot()
