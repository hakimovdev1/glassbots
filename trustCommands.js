// ======================================================================
// TRUSTED BOSHQARUVI — glassFiller.js va crafter.js uchun UMUMIY modul.
// Whisper buyruqlari:
//   trusted           -> /is trusted ro'yxatini o'qib egaga yuboradi
//   trust <name>      -> /is trust <name>; chatdagi server tasdig'i bilan
//                        tekshiriladi ("... has trusted ... to your Island.")
//   rmtrust <name|*>  -> trusted oynasida playerga left-click; "*" — hammasi.
//                        Har click chatdagi "Island Trust for <name> has been
//                        revoked." xabari bilan tasdiqlanadi.
// Natijalar hech qachon taxmin qilinmaydi — faqat server javobiga ishoniladi.
// O'zgartirish kerak bo'lsa FAQAT shu faylni o'zgartiring.
// ======================================================================
'use strict'

const WINDOW_TIMEOUT_MS = 10000  // trusted oynasi ochilishini kutish limiti
const CONFIRM_TIMEOUT_MS = 5000  // chatdan tasdiq xabarini kutish limiti
const RMTRUST_ALL_LIMIT = 30     // "rmtrust *" da maksimal player (cheksiz loopdan himoya)

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

// createTrustCommands(bot, { reply, isBusy }) -> { handle }
//  bot    - mineflayer bot obyekti
//  reply  - reply(user, text): egaga javob yuborish (log + /msg)
//  isBusy - () => boolean: bot katta vazifa bilan bandmi — band paytda
//           trusted oynasini ochish deposit/craft oynalari bilan to'qnashib
//           desync qilgani uchun buyruqlar rad etiladi
function createTrustCommands(bot, { reply, isBusy = () => false }) {

    // /is trusted oynasini ochib qaytaradi (ochilmasa yoki boshqa oyna bo'lsa null).
    // Avval oynani kutishni boshlaymiz, KEYIN buyruq yuboramiz —
    // aks holda oyna listener ulanmasidan oldin ochilib qolishi mumkin
    async function openTrustedWindow() {
        const windowPromise = new Promise((resolve) => {
            const onOpen = (window) => {
                clearTimeout(timer)
                resolve(window)
            }
            const timer = setTimeout(() => {
                bot.removeListener('windowOpen', onOpen)
                resolve(null)
            }, WINDOW_TIMEOUT_MS)
            bot.once('windowOpen', onOpen)
        })
        bot.chat('/is trusted')
        const window = await windowPromise
        if (!window) return null
        if (!window.title.includes('Trusted Members')) {
            // boshqa oyna ochilib qoldi — yopib, "topilmadi" deb qaytamiz
            try { bot.closeWindow(window) } catch (e) { /* ignore */ }
            return null
        }
        return window
    }

    // Oynadagi player slotlarini topadi: [{ index, name }]
    function findPlayerSlots(window) {
        const players = []
        for (let i = 0; i < window.slots.length; i++) {
            const slot = window.slots[i]
            if (!slot || !slot.customName) continue
            const part = slot.customName.split('"color":"aqua","text":"')[1]
            if (!part) continue
            const name = part.split('"')[0]
            if (name) players.push({ index: i, name })
        }
        return players
    }

    // Chatdan matchFn ga mos xabar kelishini kutadi (timeout ichida kelmasa false).
    // MUHIM: bu promise harakat (click/chat) DAN OLDIN yaratilishi kerak —
    // aks holda server javobi listener ulanmasidan oldin kelib qolishi mumkin
    function waitForMessage(matchFn, timeoutMs = CONFIRM_TIMEOUT_MS) {
        return new Promise((resolve) => {
            const onMsg = (msg) => {
                if (msg && matchFn(msg)) {
                    cleanup()
                    resolve(true)
                }
            }
            const timer = setTimeout(() => {
                cleanup()
                resolve(false)
            }, timeoutMs)
            function cleanup() {
                clearTimeout(timer)
                bot.removeListener('messagestr', onMsg)
            }
            bot.on('messagestr', onMsg)
        })
    }

    function closeCurrentWindow() {
        try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch (e) { /* ignore */ }
    }

    // Playerga left-click qilib, "has been revoked" tasdig'ini kutadi.
    // true = server haqiqatan untrust qilganini tasdiqladi.
    async function clickAndConfirmRevoke(target) {
        // tasdiqni clickdan OLDIN kuta boshlaymiz:
        // "Island Trust for <name> has been revoked."
        const revoked = waitForMessage(m =>
            m.includes('has been revoked') &&
            m.toLowerCase().includes(target.name.toLowerCase()))
        try {
            await bot.clickWindow(target.index, 0, 0) // 0, 0 = oddiy left-click
        } catch (err) {
            return false
        }
        return revoked
    }

    // ============== trusted — ro'yxatni o'qib yuborish ==============
    async function cmdTrusted(user) {
        const window = await openTrustedWindow()
        if (!window) {
            return reply(user, 'trusted ro\'yxatini olib bo\'lmadi')
        }
        const names = findPlayerSlots(window).map(p => p.name)
        try { bot.closeWindow(window) } catch (e) { /* ignore */ }
        reply(user, `trusted players: ${names.length ? names.join(', ') : 'topilmadi'}`)
    }

    // ============== trust <name> — tasdiq bilan qo'shish ==============
    async function cmdTrust(user, name) {
        if (!name) {
            return reply(user, 'ishlatilishi: trust <name>')
        }
        // Minecraft nik formati: 3-16 ta harf/raqam/pastki chiziq
        if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
            return reply(user, `noto'g'ri nik: ${name}`)
        }

        // Tasdiq xabarini buyruqdan OLDIN kuta boshlaymiz:
        // "... has trusted <name> to your Island."
        const trusted = waitForMessage(m => m.includes('has trusted'))
        bot.chat(`/is trust ${name}`)

        if (await trusted) {
            reply(user, `${name} trust qilindi ✔`)
        } else {
            reply(user, `${name}: trust tasdig'i kelmadi — nik xato yoki allaqachon trusted bo'lishi mumkin`)
        }
    }

    // ============== rmtrust <name|*> — tasdiq bilan o'chirish ==============
    async function cmdRmtrust(user, name) {
        if (!name) {
            return reply(user, 'ishlatilishi: rmtrust <name|*>')
        }

        // "*" — BARCHA trusted playerlarni olib tashlash.
        // Har clickdan keyin server GUI ni yangilab yuborishi mumkin,
        // shuning uchun har safar oynani QAYTADAN ochib, ro'yxatdagi
        // birinchi playerga bosamiz — ro'yxat bo'shaguncha.
        if (name === '*') {
            let removed = 0
            for (let i = 0; i < RMTRUST_ALL_LIMIT; i++) {
                const window = await openTrustedWindow()
                if (!window) break
                const players = findPlayerSlots(window)
                if (players.length === 0) {
                    try { bot.closeWindow(window) } catch (e) { /* ignore */ }
                    break
                }
                const target = players[0]
                const ok = await clickAndConfirmRevoke(target)
                closeCurrentWindow()
                if (!ok) {
                    // tasdiq kelmadi — shu player ustida aylanib qolmaslik uchun to'xtaymiz
                    reply(user, `${target.name} uchun revoke tasdig'i kelmadi — to'xtadik`)
                    break
                }
                removed++
                await sleep(500)
            }
            return reply(user, `rmtrust *: ${removed} ta player untrust qilindi`)
        }

        const window = await openTrustedWindow()
        if (!window) {
            return reply(user, 'trusted oynasini ochib bo\'lmadi')
        }
        const target = findPlayerSlots(window)
            .find(p => p.name.toLowerCase() === name.toLowerCase())
        if (!target) {
            try { bot.closeWindow(window) } catch (e) { /* ignore */ }
            return reply(user, `${name} trusted ro'yxatida topilmadi`)
        }

        const ok = await clickAndConfirmRevoke(target)
        closeCurrentWindow()
        reply(user, ok
            ? `${name} untrust qilindi ✔`
            : `${name}: revoke tasdig'i kelmadi — untrust bo'lmagan bo'lishi mumkin`)
    }

    // handle(user, msg) -> true = buyruq shu modulga tegishli edi va bajarildi
    // (yoki rad etildi), false = boshqa buyruq — chaqiruvchi o'zi davom etadi
    async function handle(user, msg) {
        const parts = msg.trim().split(/\s+/)
        const cmd = parts[0]
        if (cmd !== 'trusted' && cmd !== 'trust' && cmd !== 'rmtrust') return false

        if (isBusy()) {
            reply(user, 'Bot band — trusted buyruqlari ish tugagach ishlaydi')
            return true
        }

        try {
            if (cmd === 'trusted') await cmdTrusted(user)
            else if (cmd === 'trust') await cmdTrust(user, parts[1] || '')
            else await cmdRmtrust(user, parts[1] || '')
        } catch (err) {
            // kutilmagan xato bot jarayonini yiqitmasin, ochiq oyna qolmasin
            closeCurrentWindow()
            reply(user, `${cmd} xato: ${err.message || err}`)
        }
        return true
    }

    return { handle }
}

module.exports = { createTrustCommands }
