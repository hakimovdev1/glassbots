// .env har doim SHU FAYL yonidan o'qiladi — pm2/systemd boshqa papkadan
// ishga tushirsa ham (cwd farq qilsa ham) parol topiladi
require('dotenv').config({ path: require('path').join(__dirname, '.env') })
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
// trusted / trust / rmtrust whisper buyruqlari — boshqa botlar bilan YAGONA manbadan
const { createTrustCommands } = require('./trustCommands')
require('colors').enable()

process.on('uncaughtException', err => {
  console.error(`[PROCESS] Uncaught exception: ${err.message}`.red)
  saveLog('PROCESS', `Uncaught exception: ${err.stack || err.message}`, true)
})
process.on('unhandledRejection', reason => {
  console.error(`[PROCESS] Unhandled rejection: ${reason}`.red)
  saveLog('PROCESS', `Unhandled rejection: ${reason}`, true)
})
const fs = require('fs')
const path = require('path')
const admins = ['HAKIMOV', 'IveNeS_UZ', 'Zenomus'] // botlarni boshqaruvchilar niklari
// log yozib boruvchi ishlashi — main.js dan ASALFARM_LOGGER_TYPE=logsiz
// berilsa fayl loglari o'chadi, boshqa hollarda yoqiq
const canLoggerWork = (process.env.ASALFARM_LOGGER_TYPE || 'barchasi') !== 'logsiz'
const honeyChestWarp = 'sell' // asalni qaysi warpga borib oladi
const afkWarp = 'afk' // bot uchun afk warpi

// Hostingda env unutilsa botlar "undefined" parol bilan login qilishga
// urinib bekorga aylanmasin — darhol aniq xabar bilan chiqamiz
if (!process.env.ASALFARM_PASSWORD) {
  console.error("XATO: ASALFARM_PASSWORD env o'zgaruvchisi berilishi shart! (.env fayliga ASALFARM_PASSWORD=... yozing)")
  process.exit(1)
}

var playerList = []
const BOTS_CONFIG = [
  ...Array(6)
    .fill()
    .map((_, i) => ({
      username: `asalFarm_N${i + 1}`,
      password: process.env.ASALFARM_PASSWORD,
      host: 'hypixel.uz',
      port: 25565
    })),
  ...Array(5)
    .fill()
    .map((_, i) => ({
      username: `KH_BOT_N${i + 1}`,
      password: process.env.ASALFARM_PASSWORD.split('_')[0],
      host: 'hypixel.uz',
      port: 25565
    }))
]
let totalMoney = 0
let timeout
function formatMoney(amount) {
  return `$${amount.toLocaleString('en-US')}`
}
function getPlayerList() {
  return playerList
}
async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ======================= JARAYON ICHI BROADCAST =======================
// Barcha MinecraftBot obyektlari ro'yxati (createAndInitBot to'ldiradi,
// BOTS_CONFIG tartibida: N1, N2, ... — shu tartib zanjir tartibi hisoblanadi).
// ZANJIR USULI: N1 buyruqni bajarib bo'lgach DARHOL (sleep/setTimeout'siz)
// navbatdagi botga — N2 ga — uzatadi, N2 bajarib N3 ga uzatadi va h.k.
// Bitta bot offline bo'lsa shunchaki o'tkazib yuboriladi, zanjir undan
// keyingi botga davom etadi (eski whisper-zanjiridagi "hammasi to'xtab
// qoladi" muammosi yo'q). Hammasi BITTA jarayonda, sinxron ishlagani
// uchun butun zanjir millisekund ichida tugaydi.
const allBots = []

// cmdText ni BARCHA online botlarga zanjir tartibida, kutishsiz yuboradi.
// 'claim' va 'sell' maxsus amal, qolgan hamma narsa chatga yoziladi.
// Natija: { sent: nechta botga yuborildi, offline: [offline bot nomlari] }
function broadcastCommand(cmdText) {
  let sent = 0
  const offline = []
  for (const mb of allBots) {
    if (mb.status !== 'online' || !mb.bot) {
      offline.push(mb.botUsername)
      continue
    }
    try {
      if (cmdText === 'claim') withdrawHoney(mb.bot, mb.mcData)
      else if (cmdText === 'sell') mb.bot.chat('/is shop Food')
      else mb.bot.chat(cmdText)
      sent++
    } catch (e) {
      saveLog(mb.botUsername, `broadcast xato: ${e.message}`, true)
    }
  }
  return { sent, offline }
}

// Keyingi kelgan xabarlar ichidan test() ga MOS kelganini kutadi (timeout bilan).
// Eski koddagi bot.once('messagestr') xato edi: u keyingi BIRINCHI xabarni
// olardi — oraga boshqa xabar (masalan TPS) kelib qolsa javob yo'qolardi.
function waitForMessage(bot, test, timeoutMs = 5000) {
  return new Promise(resolve => {
    const onMessage = msg => {
      if (!test(msg)) return
      cleanup()
      resolve(msg)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve(null)
    }, timeoutMs)
    function cleanup() {
      clearTimeout(timer)
      bot.off('messagestr', onMessage)
    }
    bot.on('messagestr', onMessage)
  })
}

// Botni berilgan koordinataga pathfinder bilan yuboradi ("bind come" uchun)
function moveTo(position, bot) {
  bot.pathfinder.setGoal(
    new goals.GoalBlock(position.x, position.y, position.z)
  )
}
class MinecraftBot {
  constructor(botUsername, botPassword, serverIP, serverPort) {
    this.botUsername = botUsername
    this.botPassword = botPassword
    this.serverIP = serverIP
    this.serverPort = serverPort
    this.bot = null
    this.status = 'idle'
    this.reconnectScheduled = false
    this.tpsInterval = null
    this.watchdogInterval = null
    this.lastActivity = 0
    this.connectedAt = 0
  }
  // Barcha davriy timerlarni tozalash — eski bot obyekti ustida interval
  // ishlab qolmasligi uchun har init() va har 'end' da chaqiriladi
  clearTimers() {
    if (this.tpsInterval) {
      clearInterval(this.tpsInterval)
      this.tpsInterval = null
    }
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval)
      this.watchdogInterval = null
    }
  }
  // kicked/error hodisalaridan keyin har doim 'end' ham keladi, shuning uchun
  // bitta uzilish uchun faqat bitta reconnect rejalashtiriladi
  scheduleReconnect(delayMs) {
    if (this.reconnectScheduled) return
    this.reconnectScheduled = true
    setTimeout(() => {
      try {
        this.init()
      } catch (e) {
        this.reconnectScheduled = false
        this.scheduleReconnect(Math.random() * 45000 + 60000)
      }
    }, delayMs)
  }
  handleDisconnect() {
    this.scheduleReconnect(Math.random() * 45000 + 60000)
  }

  init() {
    this.reconnectScheduled = false
    this.clearTimers()
    const botArgs = {
      host: this.serverIP,
      port: this.serverPort,
      username: this.botUsername,
      password: this.botPassword,
      version: '1.20.1',
      connectTimeout: 60000,
      keepAliveInterval: 60000,
      checkTimeoutInterval: 90000 // sekin/laggy serverda erta uzilib ketmaslik uchun
    }
    this.bot = mineflayer.createBot(botArgs)
    this.mcData = require('minecraft-data')(this.bot.version)
    this.status = 'connecting'

    // trusted / trust <name> / rmtrust <name|*> buyruqlari (trustCommands.js) —
    // har (qayta) ulanishda YANGI bot obyektiga bog'lab qayta yaratiladi
    this.trustCommands = createTrustCommands(this.bot, {
      reply: (user, text) => {
        console.log(`[${this.botUsername}] ${text}`)
        try { this.bot.chat(`/msg ${user} ${text}`) } catch (e) { /* ignore */ }
      }
    })

    // ============== ULANISH WATCHDOG (hosting uchun) ==============
    // Ikki holatni ushlaydi:
    //  1) ulanib olib spawn bo'lmay qotib qolish (login queue/limbo)
    //  2) "zombi" ulanish — socket ochiq, lekin server paket yubormayapti
    // Ikkalasida ham bot.end() -> 'end' handler odatdagidek reconnect qiladi.
    // Busiz bot hostingda indamay osilib qolar va qayta ulanmasdi.
    this.connectedAt = Date.now()
    this.lastActivity = Date.now()
    this.bot._client.on('packet', () => {
      this.lastActivity = Date.now()
    })
    this.watchdogInterval = setInterval(() => {
      if (this.status === 'disconnected') return
      if (this.status === 'connecting' && Date.now() - this.connectedAt > 3 * 60 * 1000) {
        console.log(`[${this.botUsername}] Watchdog: 3 daqiqada spawn bo'lmadi — qayta ulanamiz`.yellow)
        saveLog(this.botUsername, 'Watchdog: spawn timeout', true)
        try { this.bot.end('spawn timeout') } catch (e) { /* ignore */ }
        return
      }
      if (Date.now() - this.lastActivity > 2 * 60 * 1000) {
        console.log(`[${this.botUsername}] Watchdog: server 2 daqiqa javob bermadi (zombi ulanish) — qayta ulanamiz`.yellow)
        saveLog(this.botUsername, 'Watchdog: zombie timeout', true)
        try { this.bot.end('zombie timeout') } catch (e) { /* ignore */ }
      }
    }, 15000)
    this.bot.once('spawn', () => {
      console.log(`${this.botUsername} Bot spawned`.green)
      this.bot.loadPlugin(pathfinder)
      const defaultMove = new Movements(this.bot)
      this.bot.pathfinder.setMovements(defaultMove)
      this.status = 'online'
    })

    this.bot.on('death', () => {
      setTimeout(() => {
        // 1s ichida ulanish uzilgan bo'lishi mumkin — chat throw qilmasin
        try {
          if (this.bot?._client && !this.bot._client.ended) {
            this.bot.chat('/is warp ' + afkWarp)
          }
        } catch (e) { /* ignore */ }
      }, 1000)
    })
    this.bot.on('playerJoined', player => {
      if (!playerList.includes(player.username))
        playerList.push(player.username)
    })

    this.bot.on('playerLeft', playerLeft => {
      if (playerList.includes(playerLeft.username)) {
        playerList = playerList.filter(player => player != playerLeft.username)
      }
    })

    this.bot.on('end', reason => {
      //   console.log(`[${this.botUsername}] END: ${reason}`.red)
      saveLog(this.botUsername, reason, true)
      this.status = 'disconnected'
      // o'lik bot ustida tps/watchdog intervallar ishlab qolmasin
      this.clearTimers()

      const reasonStr = String(reason)

      if (reasonStr === '20min') {
        this.scheduleReconnect(20 * 60 * 1000)
        return
      }

      if (reasonStr === 'reconnect') {
        this.scheduleReconnect(1000)
        return
      }

      if (reasonStr.startsWith('quit ')) {
        const parsedSeconds = parseInt(reasonStr.split('quit ')[1], 10)
        const seconds = Number.isNaN(parsedSeconds) ? 60 : parsedSeconds
        this.scheduleReconnect(seconds * 1000)
        return
      }

      this.handleDisconnect()
    })

    this.bot.on('error', err => {
      console.error(`[${this.botUsername}] ERROR: ${err.message}`.red)
      saveLog(this.botUsername, err.message, true)
      // ulanish haqiqatan uzilgan bo'lsa 'end' hodisasi reconnect qiladi;
      // 5s dan keyin ham 'end' kelmagan-u client o'lik bo'lsa, o'zimiz qilamiz
      setTimeout(() => {
        if (!this.bot || !this.bot._client || this.bot._client.ended) {
          this.status = 'disconnected'
          this.handleDisconnect()
        }
      }, 5000)
    })

    this.bot.on('kicked', (reason, loggedIn) => {
      const reasonStr = JSON.stringify(reason)
      console.log(`[${this.botUsername}] KICKED: ${reasonStr}`.yellow)
      saveLog(this.botUsername, reasonStr, true)
      this.status = 'disconnected'

      if (reasonStr.includes('Повторите попытку через 10 минут')) {
        this.scheduleReconnect(10 * 60 * 1000 + 15000)
        return
      }

      this.handleDisconnect()
    })

    this.bot.on('windowOpen', async window => {
      setTimeout(() => {
        // 19s ichida oyna allaqachon yopilgan/almashgan yoki ulanish uzilgan
        // bo'lishi mumkin — faqat hali ochiq turgan bo'lsa yopamiz
        try {
          if (this.bot?.currentWindow === window) this.bot.closeWindow(window)
        } catch (e) { /* ignore */ }
      }, 19000)
      if (window.title.includes('Island Shop | Food')) {
        let honeyCount = 0
        this.bot.inventory.slots.forEach(slot => {
          if (
            slot?.type != undefined &&
            slot?.type != null &&
            slot?.name == 'honey_bottle'
          ) {
            honeyCount += slot?.count
          }
        })
        for (let i = 0; i < honeyCount; i++) {
          setTimeout(() => {
            this.bot.simpleClick.rightMouse(21, 0, 0)
          }, i * 12.5)
        }
        setTimeout(async () => {
          await this.bot.closeWindow(window)
          this.bot.chat('/is warp ' + afkWarp)
          this.bot.chat('/is withdraw money 9999999999999999')
          this.bot.chat('/bal')
        }, honeyCount * 20 + 100)
        return
      }
      if (window.title.includes('Select a Schematic')) {
        setTimeout(() => {
          this.bot.simpleClick.leftMouse(13, 0, 0)
        }, 100)
        setTimeout(() => {
          this.bot.closeWindow(window)
        }, 300)
      }
      if (window.title.includes('Ishonchingiz komilmi?')) {
        setTimeout(() => {
          this.bot.simpleClick.leftMouse(15, 0, 0)
        }, 100)
        setTimeout(() => {
          this.bot.closeWindow(window)
        }, 300)
      }
    })
    this.tpsInterval = setInterval(() => {
      try {
        if (
          this.bot &&
          this.bot.player &&
          this.bot._client &&
          !this.bot._client.ended
        ) {
          this.bot.chat('/tps')
        }
      } catch (e) { /* uzilish oralig'ida chat throw qilishi mumkin — e'tiborsiz */ }
    }, 25000)

    // Ommaviy chat buyruqlari: "% <buyruq>" — buni HAR BIR bot o'zi ko'rib
    // o'zi bajaradi (hamma serverda bir xil chatni ko'radi, tarqatish shart emas)
    this.bot.on('chat', (username, message) => {
      if (
        username == 'hausemaster' &&
        message.toLowerCase().includes('serverda')
      ) {
        withdrawHoney(this.bot, this.mcData)
        return
      }
      if (admins.includes(username) && message.startsWith('% ')) {
        const cmd = message.slice(2).trim()
        if (cmd === 'claim') {
          withdrawHoney(this.bot, this.mcData)
          return
        }
        if (cmd === 'sell') {
          // sotadigan asal bo'lsagina do'kon ochiladi
          const hasHoney = this.bot.inventory
            .items()
            .some(item => item.name === 'honey_bottle')
          if (hasHoney) this.bot.chat('/is shop Food')
          return
        }
      }
    })

    this.bot.on('messagestr', async message => {
      if (message.trim() === '') return
      if (
        message.startsWith('Skyblock » You have successfully sold') ||
        message.includes('seconds to login')
      )
        return
      if (
        this.bot.username == 'asalFarm_N1' &&
        message.includes('Skyblock » You successfully withdrew')
      ) {
        const money = +message
          .split('Skyblock » You successfully withdrew ')[1]
          .split(' ')[0]
          .replace(/[,$]/g, '')
          .trim()

        handleMoneyMessage(
          `${formatMoney(money)} has been received from asalFarm_N1.`,
          this.bot
        )
      }
      if (this.bot.username === 'asalFarm_N1') {
        if (message.startsWith('TPS from last 1m, 5m, 15m:')) return
        console.log(message)
      }
      if (!message.startsWith('TPS from last 1m, 5m, 15m:'))
        saveLog(this.botUsername, message)
      if (
        message.includes(' has been received from ') &&
        !message.includes(' -> ')
      ) {
        const player = message
          .split(' has been received from ')[1]
          .replace('.', '')
        const money = message.split(' has been received from ')[0]
        const formattedMoney = +money
          .split(',')
          .join('')
          .replace('$', '')
          .trim()
        handleMoneyMessage(message, this.bot)
      }
      if (message == 'Server: Serverni kunlik restartiga 30 sekund qoldi') {
        this.bot.quit('20min')
      }
      if (message.includes('Balance: $')) {
        if (this.bot.username === 'asalFarm_N1') return
        let balX = message.split('Balance: $')[1].split(',').join('')
        if (balX == '0') return
        if (balX > 1350000) {
          setTimeout(() => {
            withdrawHoney(this.bot, this.mcData)
          }, 30000)
        }
        this.bot.chat(`/pay asalFarm_N1 ${balX}`)
      }
      if (message.includes('/register')) {
        this.bot.chat('/register ' + this.botPassword + ' ' + this.botPassword)
      }
      if (
        message.includes('/login') ||
        message.includes('секунд(-ы) на вход.')
      ) {
        this.bot.chat('/login ' + this.botPassword)
        setTimeout(async () => {
          this.bot?._client?.chat('/is warp ' + afkWarp)
        }, 1000)
        console.log(`${this.bot.username} Login passed`.green)
      }

      // ======= WHISPER BUYRUQLARI =======
      // Format: "[YUBORUVCHI -> me] xabar". Faqat adminlardan qabul qilinadi,
      // buyruqlar ro'yxati va bajarilishi — handleWhisper metodida.
      // Eski bot->bot whisper zanjiri olib tashlangan: endi "bind say"
      // broadcastCommand orqali hamma botga jarayon ichida yetkaziladi.
      const whisper = message.match(/^\[(\S+) -> me\] (.+)$/)
      if (whisper) {
        const [, sender, text] = whisper
        if (admins.includes(sender)) {
          try {
            await this.handleWhisper(sender, text.trim())
          } catch (e) {
            saveLog(this.botUsername, `whisper buyruqda xato: ${e.stack || e.message}`, true)
          }
        }
        return
      }
    })
  }
  // ======================= WHISPER BUYRUQLARI =======================
  // Admin botga shaxsiy xabar yuboradi: /msg <bot_nomi> <buyruq>
  // Tushuniladigan buyruqlar:
  //   bind say <xabar>     -> BARCHA online botlar <xabar>ni bajaradi/yozadi
  //                           ('claim' va 'sell' maxsus amal sifatida);
  //                           javobda nechta botga yetkazilgani aytiladi
  //   bind claim           -> shu botning o'zi asalni yig'ib sotadi
  //   bind sell            -> shu botning o'zi do'konni ochib sotadi
  //   bind count <item>    -> inventardagi <item> soni bilan javob beradi
  //   bind drop <item|all> -> itemlarni tashlaydi, nechta tashlaganini aytadi
  //   bind come            -> admin oldiga keladi
  //   bind quit <sekund>   -> serverdan chiqib, <sekund>dan keyin qaytadi
  //   bind click <tur>     -> oynada klik (hozircha: mobspawn)
  //   balance              -> o'z balansi bilan javob beradi
  //   boshqa istalgan matn -> shu bot uni chatga yozadi (buyruq bo'lsa bajaradi)
  async handleWhisper(admin, text) {
    // ba'zi server xabarlari whisper ko'rinishida kelib qolishi mumkin
    if (text === 'Server: Restart...') return
    const reply = m => {
      try {
        this.bot.chat(`/msg ${admin} ${m}`)
      } catch (e) { /* ulanish uzilgan bo'lsa jim qolamiz */ }
    }

    if (text === 'balance') {
      this.bot.chat('/bal')
      // eski kod faqat asalFarm_N1 dan javob qaytarardi — endi so'ralgan
      // botning o'zi javob beradi
      const balMsg = await waitForMessage(this.bot, m => m.includes('Balance: $'))
      reply(balMsg || 'balans javobi kelmadi')
      return
    }

    // === Trusted boshqaruvi: trusted / trust <name> / rmtrust <name|*> ===
    if (await this.trustCommands.handle(admin, text)) return

    if (!text.startsWith('bind ')) {
      // maxsus buyruq emas — shu botning o'zi chatga yozadi
      this.bot.chat(text)
      return
    }
    const bind = text.slice('bind '.length).trim()

    if (bind.startsWith('say ')) {
      // BARCHA botlarga. slice ishlatiladi (split emas) — xabar ichida
      // "say" so'zi uchrasa ham buzilmaydi
      const msg = bind.slice('say '.length).trim()
      const { sent, offline } = broadcastCommand(msg)
      reply(`${sent} ta botga yuborildi${offline.length ? `, offline: ${offline.join(', ')}` : ''}`)
      return
    }
    if (bind === 'claim') {
      withdrawHoney(this.bot, this.mcData)
      return
    }
    if (bind === 'sell') {
      this.bot.chat('/is shop Food')
      return
    }
    if (bind.startsWith('count ')) {
      const itemName = bind.slice('count '.length).trim()
      const total = this.bot.inventory
        .items()
        .filter(item => item.name === itemName)
        .reduce((sum, item) => sum + item.count, 0)
      reply(`${itemName}: ${total} ta`)
      return
    }
    if (bind.startsWith('drop ')) {
      const itemName = bind.slice('drop '.length).trim()
      const items = this.bot.inventory
        .items()
        .filter(item => itemName === 'all' || item.name === itemName)
      let dropped = 0
      // ketma-ket, har birini kutib tashlaymiz — eski kod hammasini bir
      // vaqtda tashlar va sonini tashlashdan OLDIN aytib yuborardi (doim 0)
      for (const item of items) {
        try {
          await this.bot.tossStack(item)
          dropped += item.count
          await sleep(250)
        } catch (e) {
          saveLog(this.botUsername, `drop xato (${item.name}): ${e.message}`, true)
        }
      }
      reply(`${dropped} ta tashlandi`)
      return
    }
    if (bind === 'come') {
      const player = this.bot.players[admin]
      if (!player || !player.entity) {
        reply('sizni topa olmadim.')
        return
      }
      moveTo(player.entity.position, this.bot)
      return
    }
    if (bind.startsWith('quit ')) {
      const parsedSeconds = parseInt(bind.slice('quit '.length), 10)
      const seconds = Number.isNaN(parsedSeconds) ? 60 : parsedSeconds
      this.bot.quit('quit ' + seconds)
      return
    }
    if (bind.startsWith('click ')) {
      await windowClicks(this.bot, bind.slice('click '.length).trim())
      return
    }
    reply(`tushunarsiz buyruq: bind ${bind}`)
  }

  getStatus() {
    return {
      username: this.botUsername,
      status: this.status,
      position: this.bot?.entity?.position || null
    }
  }
}

function saveLog(username, log = 'empty!**', isError = false) {
  log = String(log)
  if (!log.trim() || !canLoggerWork) return

  try {
    const now = new Date()
    const uzTime = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tashkent',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(now)

    const [date, time] = uzTime.split(', ')
    const [month, day, year] = date.split('/')
    const timestamp = `${day} ${year} at ${time}`

    // DATA_DIR berilsa (main.js / Coolify volume) loglar o'sha yerga yoziladi —
    // redeploy da o'chib ketmaydi
    const basePath = path.join(process.env.DATA_DIR || __dirname, 'logs')

    if (isError) {
      // yangi hostingda logs/ hali yaratilmagan bo'ladi — appendFile ENOENT
      // bilan yiqilib error loglar butunlay yo'qolmasligi uchun
      if (!fs.existsSync(basePath)) {
        fs.mkdirSync(basePath, { recursive: true })
      }
      const errorLogPath = path.join(basePath, 'errors.txt')
      const errorEntry = `[${username}] [${timestamp}] ${log}\n`

      fs.appendFile(errorLogPath, errorEntry, 'utf8', err => {
        if (err) console.error(`Xatolik logini yozishda xatolik:`, err)
      })

      return
    }

    const userLogPath = path.join(basePath, username)
    const monthName = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tashkent',
      month: 'long'
    }).format(now)

    const dayFormatted = day.padStart(2, '0')
    const monthPath = path.join(userLogPath, monthName)

    if (!fs.existsSync(monthPath)) {
      fs.mkdirSync(monthPath, { recursive: true })
    }

    const logFilePath = path.join(monthPath, `${dayFormatted}.txt`)
    const logEntry = `[${timestamp}] ${log}\n`

    fs.appendFile(logFilePath, logEntry, 'utf8', err => {
      if (err) console.error(`Log yozishda xatolik (${logFilePath}):`, err)
    })
  } catch (error) {
    console.error('saveLog funksiyasida xatolik:', error)
  }
}

const validPlayers = new Set([
  'asalFarm_N1',
  'asalFarm_N2',
  'asalFarm_N3',
  'asalFarm_N4',
  'asalFarm_N5',
  'asalFarm_N6',
  'KH_BOT_N1',
  'KH_BOT_N2',
  'KH_BOT_N3',
  'KH_BOT_N4',
  'KH_BOT_N5'
])

let receivedPlayers = new Set()
async function handleMoneyMessage(message, bot) {
  clearTimeout(timeout)
  timeout = setTimeout(() => triggerEnd(bot), 15000)

  if (
    message.includes(' has been received from ') &&
    !message.includes(' -> ')
  ) {
    try {
      const [moneyPart, playerPart] = message.split(' has been received from ')
      const player = playerPart.replace('.', '').trim()
      const formattedMoney = Number(
        moneyPart.replace(/[,$]/g, '').replace('$', '').trim()
      )

      if (
        !isNaN(formattedMoney) &&
        validPlayers.has(player) &&
        !receivedPlayers.has(player)
      ) {
        totalMoney += formattedMoney
        receivedPlayers.add(player)
      }

      if (receivedPlayers.size === validPlayers.size) {
        let end = await triggerEnd(bot)
        console.log(end)
      }
    } catch (err) {
      console.error('Xabarni parse qilishda xatolik:', err)
    }
  }
}

function triggerEnd(bot) {
  clearTimeout(timeout)
  console.log(`${formatMoney(totalMoney)} yig'ib olindi`.green)
  bot.chat('/bal')
  saveLog(bot.username, `${formatMoney(totalMoney)} yig'ib olindi`)

  for (const name of admins) {
    if (!playerList.includes(name)) continue
    bot.chat(`/msg ${name} Jami ${formatMoney(totalMoney)} yig'ib olindi`)
  }
  totalMoney = 0
  receivedPlayers = new Set()
  return true
}

// Tashqi qobiq: ish o'rtasida ulanish uzilsa yoki kutilmagan xato chiqsa
// jarayon unhandled rejection bilan iflos qolmaydi — log yozilib chiqiladi,
// bot reconnect tizimi odatdagidek ishlayveradi
async function withdrawHoney(bot, mcData) {
  try {
    await withdrawHoneyInner(bot, mcData)
  } catch (error) {
    console.log(`[${bot.username}] withdrawHoney xato: ${error.message}`)
    saveLog(bot.username, `withdrawHoney xato: ${error.stack || error.message}`, true)
  }
}

async function withdrawHoneyInner(bot, mcData) {
  bot.chat(`/is warp ${honeyChestWarp}`)
  await new Promise(resolve => setTimeout(resolve, 500))

  const chestPositions = await bot.findBlocks({
    matching: mcData.blocksByName.chest.id,
    maxDistance: 4,
    count: 4
  })

  if (!chestPositions.length) {
    console.log(`[${bot.username}] No chests found nearby.`)
    saveLog(bot.username, `No chests found nearby.`)
    return
  }

  const openedChests = new Set()

  for (let pos of chestPositions) {
    let chestKey = `${pos.x},${pos.y},${pos.z}`
    if (openedChests.has(chestKey)) {
      continue
    }

    let chestBlock = bot.blockAt(pos)
    if (!chestBlock) {
      console.log(`[${bot.username}] No block found at position ${pos}`)
      saveLog(bot.username, `No block found at position ${pos}`)
      continue
    }

    let attempts = 0
    let chest = null
    const maxAttempts = 3

    while (!chest && attempts < maxAttempts) {
      try {
        chest = await bot.openChest(chestBlock)
      } catch (error) {
        console.log(`Error opening chest: ${error.message}. Retrying...`)
        saveLog(
          bot.username,
          `Error opening chest: ${error.message}. Retrying...`
        )
        attempts++
        await new Promise(resolve => setTimeout(resolve, 5000))
      }
    }

    if (!chest) {
      console.log(
        `[${bot.username}] Failed to open chest after multiple attempts.`
      )
      saveLog(bot.username, `Failed to open chest after multiple attempts.`)
      continue
    }

    openedChests.add(chestKey)

    function hasFreeSlot() {
      return bot.inventory.emptySlotCount() > 0
    }

    for (let slot of chest.containerItems()) {
      if (slot.name === 'honey_bottle' && slot.count > 0) {
        if (!hasFreeSlot()) break
        try {
          await chest.withdraw(slot.type, null, slot.count)
        } catch (error) {
          console.log(
            `[${bot.username}] Error withdrawing items: ${error.message}`
          )
          saveLog(bot.username, `Error withdrawing items: ${error.message}`)
        }
      }
    }

    await chest.close()
    await new Promise(resolve => setTimeout(resolve, 1000))

    if (!hasFreeSlot()) {
      console.log(`[${bot.username}] Inventory full, stopping.`)
      saveLog(bot.username, `Inventory full, stopping.`)
      break
    }
  }

  bot.chat('/is shop Food')
}
async function windowClicks(bot, type) {
  switch (type) {
    case 'mobspawn':
      await mobSpawn(bot)
      break
    default:
      console.log(`[${bot.username}] ❌ Noto'g'ri tur: ${type}`)

      saveLog(bot.username, `❌ Noto'g'ri tur: ${type}`)
  }
}

async function mobSpawn(bot) {
  bot.chat('/is settings')
  bot.once('windowOpen', async window => {
    await bot.waitForTicks(5)
    const slotIndex = 10,
      item = window.slots[slotIndex]
    if (!item) return

    const lore = item?.nbt?.value?.display?.value?.Lore?.value?.value
    const beforeValue = extractValue(lore)

    await bot.simpleClick.leftMouse(slotIndex)

    setTimeout(() => {
      const newItem = window.slots[slotIndex]
      const newLore = newItem?.nbt?.value?.display?.value?.Lore?.value?.value
      const afterValue = extractValue(newLore)

      console.log(`[${bot.username}] ${beforeValue} -> ${afterValue}`)
      admins.forEach(admin => {
        bot.chat(`/msg ${admin} mobspawn ${beforeValue} -> ${afterValue}`)
      })
      saveLog(bot.username, `mobspawn ${beforeValue} -> ${afterValue}`)
      bot.closeWindow(window)
    }, 2000)
  })
}

function extractValue(lore) {
  // NBT strukturasi kutilgandan farq qilsa throw qilmasdan "Noma'lum" qaytadi
  try {
    if (!lore) return "Noma'lum"
    const valueLine = lore.find(line => line.includes('"Value"'))
    if (!valueLine) return "Noma'lum"
    return (
      lore[lore.indexOf(valueLine) + 1].split('"text"')[1].split('"')[1] ||
      "Noma'lum"
    )
  } catch (e) {
    return "Noma'lum"
  }
}

async function createAndInitBot(
  username,
  password,
  serverIP,
  serverPort,
  delay = 5
) {
  await sleep(delay * 1000)
  const bot = new MinecraftBot(username, password, serverIP, serverPort)
  allBots.push(bot) // broadcast ("bind say") shu ro'yxat orqali tarqatiladi
  try {
    bot.init()
  } catch (err) {
    // birinchi init yiqilsa (DNS/socket xatosi) bot butunlay o'chib
    // qolmasin — backoff bilan qayta uriniladi
    console.error(`[${username}] Botni ishga tushirishda xato: ${err.message}`.red)
    saveLog(username, `Init xato: ${err.stack || err.message}`, true)
    bot.scheduleReconnect(30000)
  }
}
BOTS_CONFIG.forEach((config, index) => {
  const time = index * 3.5
  const { username, password, host, port } = config
  createAndInitBot(username, password, host, port, time)
})

module.exports = { MinecraftBot }