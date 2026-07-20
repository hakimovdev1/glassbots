// ======================================================================
// HUNGER MANAGER — glassFiller.js va crafter.js IKKALASI ham shu fayldan
// foydalanadi. Vazifasi:
//  - hunger (bot.food) belgilangan chegaradan pastga tushsa, bot CHAP
//    QO'LIDA (off-hand, slot 45) turgan ovqatni yeydi
//  - chap qo'lda ovqat qolmagan bo'lsa, "/is shop Food" ochib
//    minecraft:cooked_beef ni bitta shift-click bilan sotib oladi va
//    o'zi chap qo'liga oladi
//  - inventarda (asosiy, chap qo'ldan tashqari) 2 yoki undan ko'proq
//    ovqat stack/turi to'planib qolsa — bittasini tashlab yuboradi
//
// MUHIM: bu mustaqil orqa fon timer emas! bot.currentWindow ochiq bo'lsa
// (sandiq/crafting/shop bilan band bo'lsa) hech narsa qilmay chiqib
// ketadi — chunki off-hand ga equip qilish bot.currentWindow (yoki
// bot.inventory) ustida clickWindow ishlatadi, boshqa oyna ochiq turganda
// bu noto'g'ri slotlarga bosilib ketishi (desync) mumkin edi. Shuning
// uchun maybeEat() FAQAT chaqiruvchi kod o'zi "oyna yopiq" ekanini bilgan
// xavfsiz nuqtalarda (masalan har bir sandiqni ochishdan OLDIN, navbatdagi
// trip/cycle boshida) chaqirilishi kerak — glassFiller.js va crafter.js
// dagi asosiy sikllar ichiga shu tarzda joylashtirilgan.
// ======================================================================
'use strict'

const OFFHAND_SLOT = 45
const SHOP_WINDOW_TITLE = 'Island Shop | Food'

async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function createHungerManager(bot, options = {}) {
    const logger = options.logger || (() => { })
    // bot.food 0-20 oralig'ida (o'yindagi 10 ta suyak belgisi = 20 birlik,
    // har bir belgi 2 birlik). "10 dan hisoblasak 7dan kamaysa" -> 7*2=14
    const hungerThreshold = options.hungerThreshold ?? 14
    const shopFoodItem = options.shopFoodItem || 'cooked_beef'

    let handling = false // bir vaqtda faqat bitta eating routine ishlasin

    function isFoodItem(item) {
        return !!(item && bot.registry?.foodsByName && bot.registry.foodsByName[item.name])
    }

    function isHungry() {
        return typeof bot.food === 'number' && bot.food < hungerThreshold
    }

    function offHandItem() {
        return bot.inventory?.slots?.[OFFHAND_SLOT] || null
    }

    function offHandHasFood() {
        return isFoodItem(offHandItem())
    }

    // Off-hand dagi itemni yeydi/ichadi. mineflayer'ning bot.consume() faqat
    // asosiy qo'l (heldItem) bilan ishlaydi, shuning uchun xuddi shu
    // mexanizm (entity_status kodi 9 — "eating tugadi" signalini kutish)
    // qo'lda off-hand uchun takrorlanadi.
    function eatFromOffHand() {
        return new Promise(resolve => {
            let done = false
            const finish = () => {
                if (done) return
                done = true
                bot._client.removeListener('entity_status', onStatus)
                clearTimeout(timer)
                resolve()
            }
            const onStatus = packet => {
                if (bot.entity && packet.entityId === bot.entity.id && packet.entityStatus === 9) finish()
            }
            bot._client.on('entity_status', onStatus)
            // haqiqiy yeyish davomiyligi ~1.6s (Minecraft wiki) — sal ortiqcha kutamiz
            const timer = setTimeout(finish, 2600)
            try {
                bot.activateItem(true) // true = off-hand
            } catch (err) {
                finish()
            }
        })
    }

    // "/is shop Food" ochib minecraft:cooked_beef ustida BITTA shift-click
    // qiladi. RAW window_click paketi ishlatiladi (bot.clickWindow EMAS) —
    // crafter.js dagi buyFromShop bilan bir xil sabab: bot.clickWindow shop
    // GUI larida lokal simulyatsiya qilib inventarni desync qiladi.
    function buyFoodViaShop() {
        return new Promise(resolve => {
            let finished = false
            const finish = (result) => {
                if (finished) return
                finished = true
                clearTimeout(timer)
                bot.removeListener('windowOpen', onWindow)
                resolve(result)
            }

            const onWindow = async (w) => {
                clearTimeout(timer)
                try {
                    if (!w.title.includes(SHOP_WINDOW_TITLE)) {
                        try { await bot.closeWindow(w) } catch (e) { /* ignore */ }
                        return finish(false)
                    }
                    // server oynani TO'LIQ yuborishini kutamiz — aks holda
                    // slotlar hali bo'sh ko'rinib item topilmay qolishi mumkin
                    await sleep(300)

                    let slot = -1
                    for (let i = 0; i < w.inventoryStart; i++) {
                        const s = w.slots[i]
                        if (s && s.name === shopFoodItem) { slot = i; break }
                    }
                    if (slot === -1) {
                        logger(`Shopda "${shopFoodItem}" topilmadi!`, 'muhim')
                        try { await bot.closeWindow(w) } catch (e) { /* ignore */ }
                        return finish(false)
                    }

                    const Item = require('prismarine-item')(bot.registry)
                    bot._client.write('window_click', {
                        windowId: w.id,
                        stateId: w.stateId ?? -1,
                        slot,
                        mouseButton: 0,
                        mode: 1, // 1 = shift-click
                        changedSlots: [],
                        cursorItem: Item.toNotch(null),
                    })

                    await sleep(400) // server javobi (xarid) kelishini kutamiz
                    try { await bot.closeWindow(w) } catch (e) { /* ignore */ }
                    finish(true)
                } catch (err) {
                    logger(`Ovqat sotib olishda xato: ${err.message}`, 'muhim')
                    try { if (bot.currentWindow) await bot.closeWindow(bot.currentWindow) } catch (e) { /* ignore */ }
                    finish(false)
                }
            }

            const timer = setTimeout(() => finish(false), 8000)
            bot.once('windowOpen', onWindow)
            try {
                bot.chat('/is shop Food')
            } catch (err) {
                finish(false)
            }
        })
    }

    // Xariddan keyin item inventarga kelishini kutadi (server bilan
    // sinxronlashguncha bir necha tick vaqt ketishi mumkin)
    async function waitForItem(name, timeoutMs) {
        const start = Date.now()
        while (Date.now() - start < timeoutMs) {
            const item = bot.inventory.items().find(i => i.name === name)
            if (item) return item
            await sleep(100)
        }
        return null
    }

    async function buyFoodAndEquip() {
        logger('Chap qo\'lda ovqat qolmadi — shopdan sotib olinmoqda...', 'muhim')
        const bought = await buyFoodViaShop()
        if (!bought) {
            logger(`Shopdan ${shopFoodItem} sotib olinmadi`, 'muhim')
            return false
        }
        const item = await waitForItem(shopFoodItem, 3000)
        if (!item) {
            logger(`${shopFoodItem} inventarga kelmadi (xarid muvaffaqiyatsiz bo'lgan bo'lishi mumkin)`, 'muhim')
            return false
        }
        try {
            await bot.equip(item, 'off-hand')
        } catch (err) {
            logger(`Ovqatni chap qo'lga olishda xato: ${err.message}`, 'muhim')
            return false
        }
        logger(`${item.count} ta ${shopFoodItem} chap qo'lga olindi`, 'muhim')
        return true
    }

    // Inventarda (chap qo'ldan tashqari) 2+ ovqat stack/turi to'planib
    // qolsa — joy tejash uchun bittasini tashlaydi
    async function cleanupExtraFood() {
        const foodStacks = bot.inventory.items().filter(isFoodItem)
        if (foodStacks.length < 2) return
        const extra = foodStacks[0]
        try {
            await bot.tossStack(extra)
            logger(`Ortiqcha ovqat tashlandi: ${extra.count} ${extra.name}`, 'muhim')
        } catch (err) {
            logger(`Ortiqcha ovqatni tashlashda xato: ${err.message}`, 'muhim')
        }
    }

    async function eatRoutine() {
        if (!offHandHasFood()) {
            const bought = await buyFoodAndEquip()
            if (!bought) return
        }

        // hunger chegaraga yetguncha (yoki ovqat tugaguncha) ketma-ket yeydi —
        // bitta cooked_beef har doim yetarli bo'lavermaydi (juda och bo'lsa)
        let bites = 0
        while (isHungry() && offHandHasFood() && bites < 8) {
            await eatFromOffHand()
            await sleep(100) // update_health paketi kelishi uchun ozgina kutish
            bites++
        }

        await cleanupExtraFood()
    }

    // Chaqiruvchi kod xavfsiz nuqtada (oyna ochiq bo'lmaganda) chaqiradi.
    // Hamma shart bajarilmasa jim (no-op) qaytadi — chaqiruvchi tekshirish
    // haqida qayg'urmasdan istalgan joyda chaqiraveradi.
    async function maybeEat() {
        if (handling) return
        if (!bot.entity || typeof bot.food !== 'number') return
        if (!isHungry()) return
        if (bot.currentWindow) return // boshqa oyna band — keyingi xavfsiz nuqtada urinamiz

        handling = true
        try {
            await eatRoutine()
        } catch (err) {
            logger(`Ovqatlanishda kutilmagan xato: ${err?.stack || err.message}`, 'muhim')
        } finally {
            handling = false
        }
    }

    return { maybeEat, isHungry, offHandHasFood }
}

module.exports = { createHungerManager }
