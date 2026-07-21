// .env har doim SHU FAYL yonidan o'qiladi — main.js orqali ham, to'g'ridan
// to'g'ri `node zenomus.js` bilan ham parol topilsin (cwd farq qilsa ham)
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const mineflayer = require("mineflayer");
const { goals: { GoalBlock }, pathfinder, Movements } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
// trusted / trust / rmtrust whisper buyruqlari — boshqa botlar bilan YAGONA manbadan
const { createTrustCommands } = require('./trustCommands');
// Oddiy wait helper
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
// Chunk load xatoliklarini yashirish
const originalConsoleWarn = console.warn;
console.warn = function (...args) {
    const message = args.join(" ");
    if (message.includes("Ignoring block entities as chunk failed to load")) {
        return; // Bu xatoliklarni chiqarmaslik
    }
    originalConsoleWarn.apply(console, args);
};

// VPS da bitta kutilmagan xato yoki ushlanmagan promise butun jarayonni
// yiqitmasin — bot uzilishi 'end'/'error' orqali baribir reconnect qiladi.
// (Node 15+ da unhandledRejection default holda jarayonni o'ldiradi.)
process.on("uncaughtException", (err) => {
    console.log(`[zenomus] Uncaught exception: ${err?.stack || err}`);
});
process.on("unhandledRejection", (reason) => {
    console.log(`[zenomus] Unhandled rejection: ${reason?.stack || reason}`);
});

// Hostingda env unutilsa botlar "undefined" parol bilan bekorga login
// qilishga urinmasin — darhol aniq xabar bilan chiqamiz
if (!process.env.ZENOMUS_PASSWORD) {
    console.error("XATO: ZENOMUS_PASSWORD env o'zgaruvchisi berilishi shart! (.env fayliga ZENOMUS_PASSWORD=... yozing)");
    process.exit(1);
}


const BOT_CONFIGS = [
    {
        username: "Zenomus_N1",
        isMiner: true,
        mineLoc: { x: -749, y: 88, z: -6336 },
        mineLook: 180,
        is180: false,      // <-- bu yerda 180° aylanishni yoqish/o‘chirish
        turnAfter: 10,    // qancha muvaffaqiyatli blockdan keyin aylanish (default 10)
    },
    {
        username: "Zenomus_N2",
        isMiner: true,
        mineLoc: { x: -749, y: 88, z: -6325 },
        mineLook: 180,
        is180: true,
        turnAfter: 20,
    },
    {
        username: "Zenomus_N3",
        isMiner: true,
        mineLoc: { x: -749, y: 88, z: -6314 },
        mineLook: 180,
        is180: true,
        turnAfter: 20,
    },
    {
        username: "Zenomus_N4",
        isMiner: true,
        mineLoc: { x: -749, y: 88, z: -6303 }, // Koordinatalar orqali mine joyi
        mineLook: 0,
        is180: true,
        turnAfter: 20,
    },
    {
        username: "Zenomus_N5",
        isMiner: true,
        mineLoc: { x: -749, y: 88, z: -6292 }, // Koordinatalar orqali mine joyi
        mineLook: 0,
        is180: false,
        turnAfter: 10,
    },
    {
        username: "Zenomus_N6",
        isMiner: true,
        mineLoc: { x: -734, y: 88, z: -6292 }, // Koordinatalar orqali mine joyi
        mineLook: 0,
        is180: false,
        turnAfter: 10,
    },
    {
        username: "Zenomus_N7",
        isMiner: true,
        mineLoc: { x: -734, y: 88, z: -6303 }, // Koordinatalar orqali mine joyi
        mineLook: 0,
        is180: true,
        turnAfter: 20,
    },
    {
        username: "Zenomus_N8",
        isMiner: true,
        mineLoc: { x: -734, y: 88, z: -6314 }, // Koordinatalar orqali mine joyi
        mineLook: 180,
        is180: false,
        turnAfter: 20,
    },
    // {
    //     username: "Zenomus_N9",
    //     isMiner: true,
    //     mineLoc: { x: -734, y: 88, z: -6325 }, // Koordinatalar orqali mine joyi
    //     mineLook: 180,
    //     is180: false,
    //     turnAfter: 20,
    // },
];
// Heartbeat fayli — DATA_DIR berilgan bo'lsa (Coolify volume) o'sha yerga,
// aks holda shu papkaga. Yozishda xato bo'lsa (read-only FS) jimgina o'tamiz,
// aks holda har 10s da jarayon crash bo'lardi.
const HEARTBEAT_FILE = require("path").join(
    process.env.DATA_DIR || __dirname,
    "zenomus_heartbeat",
);
setInterval(() => {
    try {
        require("fs").writeFileSync(HEARTBEAT_FILE, Date.now().toString());
    } catch (e) {
        /* yozib bo'lmadi — e'tiborsiz qoldiramiz */
    }
}, 10000);
class ZenomusBot {
    constructor(config, host, port, delay = 0) {
        this.username = config.username;
        this.host = host;
        this.port = port;
        this.password = process.env.ZENOMUS_PASSWORD;
        this.reconnectDelay = 30000; // 30 seconds
        this.maxReconnectAttempts = 5;
        this.reconnectAttempts = 0;
        this.isConnected = false;
        this.isMiner = config.isMiner;
        this.mineLoc = config.mineLoc;

        // NEW: 180deg konfiguratsiyasi va hisoblagich
        this.is180 = !!config.is180;
        this.turnAfter = Number.isInteger(config.turnAfter) ? config.turnAfter : 10;
        this.minedSinceTurn = 0;
        this.mining = false;
        // Add random delay before first connection to avoid simultaneous connections
        setTimeout(() => this.createBot(), delay);
    }

    createBot() {
        try {
            this.bot = mineflayer.createBot({
                host: this.host,
                port: this.port,
                username: this.username,
                version: "1.18.2", // Enchant muammolarini oldini olish uchun
                hideErrors: false,
                checkTimeoutInterval: 30000,
                keepAlive: true,
            });
            this.bot.loadPlugin(pathfinder);
            this.setupEventHandlers();
        } catch (error) {
            this.scheduleReconnect();
        }
    }
    setupEventHandlers() {
        this.bot.on("login", () => {
            this.isConnected = true;
            this.reconnectAttempts = 0;
        });

        this.bot.on("spawn", () => {
            // Bot spawn bo'lgandan keyin login jarayonini kutish
        });

        this.bot.on("end", (reason) => {
            this.isConnected = false;
            this.mining = false; // uzilganda mining loop to'xtaydi — reconnectda qayta boshlansin
            if (this.isMiner && reason === "socketClosed") {
                setTimeout(() => this.createBot(), 900000); // 15 minutes for miner
            } else {
                this.scheduleReconnect();
            }
        });

        this.bot.on("kicked", (reason) => {
            // reason string YOKI obyekt bo'lishi mumkin — to'g'ridan .includes()
            // chaqirsak obyektda TypeError bo'lib crash bo'lardi
            const reasonStr = this.parseKickReason(reason);
            const isBot = reasonStr.includes('Вы не прошли проверку, возможно вы бот');
            console.log(`🚫 ${this.username} kicked: ${reasonStr}`);
            this.isConnected = false;
            this.mining = false;
            this.scheduleReconnect(isBot);
        });

        this.bot.on("error", (err) => {
            // Chunk load xatoliklarini yashirish
            if (err.message && err.message.includes("chunk failed to load")) {
                return; // Bu xatoliklarni e'tiborsiz qoldirish
            }

            this.isConnected = false;
            this.mining = false;
            this.scheduleReconnect();
        });

        // trusted / trust <name> / rmtrust <name|*> buyruqlari (trustCommands.js)
        const trustCommands = createTrustCommands(this.bot, {
            reply: (user, text) => {
                console.log(`[${this.username}] ${text}`);
                try { this.bot.chat(`/msg ${user} ${text}`); } catch (e) { /* ignore */ }
            },
        });

        this.bot.on('whisper', async (username, message) => {
            if (username === 'HAKIMOV' || username === 'Zenomus') {
                // === Trusted boshqaruvi: trusted / trust <name> / rmtrust <name|*> ===
                if (await trustCommands.handle(username, message.trim())) return;
                const cmd = message.trim().toLowerCase();

                if (cmd === 'drop') {
                    for (const item of this.bot.inventory.items()) {
                        if (!item.name.includes('pickaxe')) { // pickaxe qoldiradi
                            await this.bot.tossStack(item);
                            await new Promise(r => setTimeout(r, 50)); // 0.05s delay
                        }
                    }
                    return; // Drop tugagach, boshqa narsani qilmaydi
                }

                // Drop emas bo'lsa, 1-3s random delay bilan chatga yozadi
                setTimeout(() => {
                    this.bot.chat(message);
                }, Math.random() * 2000 + 1000);
            }
        });


        // Miner bot specific chat handlers
        this.bot.on("chat", (username, message) => {
            if (this.isMiner) {
                this.handleMinerChat(username, message);
            }
        });

        this.bot.on("message", (jsonMsg) => {
            try {
                const msg = jsonMsg.toString().toLowerCase();
                const msgStr = jsonMsg.toString();

                // Handle registration and login with delays
                if (msg.includes("register")) {
                    setTimeout(
                        () => {
                            this.bot.chat(
                                `/register ${this.password} ${this.password}`,
                            );
                            console.log(`🔐 ${this.username} -> /register`);
                        },
                        Math.random() * 3000 + 2000,
                    ); // 2-5 second delay
                } else if (msg.includes("login")) {
                    this.bot.chat(`/login ${this.password}`);
                } else if (msg.includes('успешно вошли')) {
                    console.log(`🔑 ${this.username} -> Successfully joined`);
                    // Bot specific actions after login
                    setTimeout(() => { this.handlePostLogin() }, 500); // 1 second delay
                }

            } catch (error) {
                console.log(
                    `${this.username} xabar qayta ishlashda xatolik: ${error.message}`,
                );
            }
        });

        // Miner bot specific event handlers
        if (this.isMiner) {
            this.bot.once("death", () => {
                setTimeout(() => {
                    this.handlePostLogin(); // Death dan keyin qayta mine joyiga borish
                }, 1000);
            });

            this.bot.on("diggingAborted", () => {
                this.mining = false;
                this.bot.quit();
            });
        }
    }

    handlePostLogin() {
        setTimeout(() => {
            // reset hisoblash
            this.minedSinceTurn = 0;
            if (typeof this.mineLoc === "string") {
                this.bot.chat(`/is warp ${this.mineLoc}`);

                if (this.isMiner) {
                    setTimeout(() => {
                        this.startMining();
                    }, 1000);
                }
            } else if (
                typeof this.mineLoc === "object" &&
                this.mineLoc.x !== undefined
            ) {
                this.bot.chat('/is warp miner')
                setTimeout(() => {
                    // .catch() SHART — reject bo'lsa (yo'l topilmadi) ushlanmagan
                    // promise butun jarayonni yiqitardi
                    this.goToCoordinates(
                        this.mineLoc.x,
                        this.mineLoc.y,
                        this.mineLoc.z,
                    ).catch((err) => {
                        console.log(`${this.username} goToCoordinates xatolik: ${err.message}`);
                    });
                }, 1000);
            }
        }, 1000)
    }


    async goToCoordinates(x, y, z) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer = null;
            const onGoalReached = async () => finish(true);
            const onPathUpdate = (r) => {
                if (r && r.status === 'noPath') {
                    console.log(`❌ Bu koordinataga yo‘l topilmadi: ${x}, ${y}, ${z}`);
                    finish(false, new Error("Yo‘l topilmadi"));
                }
            };
            // Barcha listener/timerlarni bir joyda tozalaymiz — aks holda har
            // reconnect/deathda ular to'planib xotira sizishiga olib kelardi
            const cleanup = () => {
                if (timer) clearTimeout(timer);
                if (this.bot) {
                    this.bot.removeListener('goal_reached', onGoalReached);
                    this.bot.removeListener('path_update', onPathUpdate);
                }
            };
            const finish = async (ok, err) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (!ok) return reject(err);

                console.log(`✅ Bot koordinataga yetdi: ${x}, ${y}, ${z}`);
                const botconfig = BOT_CONFIGS.find((b) => b.username === this.username);
                // mineLook bo‘lsa – qarashni sozlash
                if (botconfig && botconfig.mineLook !== undefined) {
                    try {
                        const yaw = (botconfig.mineLook * Math.PI) / 180;
                        await this.bot.look(yaw, 0, true);
                        console.log(`👀 Bot qaradi: yaw=${botconfig.mineLook}°, pitch=0°`);
                    } catch (err2) {
                        console.log(`❌ Qarashda xatolik: ${err2.message}`);
                    }
                }
                if (botconfig && botconfig.isMiner) {
                    setTimeout(() => {
                        try {
                            this.startMining();
                        } catch (err2) {
                            console.error("⛏️ startMining() bajarishda xatolik:", err2.message);
                        }
                    }, 2000);
                }
                resolve(true);
            };

            try {
                if (!this.bot || !this.bot.pathfinder) {
                    return finish(false, new Error("Pathfinder plugin yoqilmagan!"));
                }

                // Harakatlanish qoidalarini o‘rnatamiz
                const mcData = require('minecraft-data')(this.bot.version);
                const defaultMove = new Movements(this.bot, mcData);
                this.bot.pathfinder.setMovements(defaultMove);

                // Maqsadni belgilash
                this.bot.pathfinder.setGoal(new GoalBlock(x, y, z));
                this.bot.on('goal_reached', onGoalReached);
                this.bot.on('path_update', onPathUpdate);

                // Zaxira: 60s ichida na yetdi, na noPath — osilib qolmaslik uchun
                timer = setTimeout(() => finish(false, new Error("goToCoordinates timeout")), 60000);
            } catch (error) {
                finish(false, error);
            }
        });
    }




    handleMinerChat(username, message) {
        if (username === "Zenomus" || username === "Zenomus") {
            if (message === "% dep") {
                this.bot.chat("/is deposit experience 9999999999999999999999");
            }
        }
    }
    // Normalize angle helper
    _normalizeAngle(a) {
        return Math.atan2(Math.sin(a), Math.cos(a));
    }
    async startMining() {
        if (!this.isMiner) return;
        if (this.mining) return; // already mining
        this.mining = true;
        this.minedSinceTurn = 0;
        // Reconnectdan keyin ikkita loop bir vaqtda ishlab qolmasin: shu loop
        // qaysi bot uchun ochilganini eslab qolamiz, bot almashsa to'xtaymiz
        const sessionBot = this.bot;

        while (this.mining && this.isConnected && this.bot === sessionBot) {
            try {
                // ensure pickaxe equipped
                const pickaxe = this.bot.inventory
                    .items()
                    .find((i) => i.name && i.name.includes("pickaxe"));

                if (pickaxe) {
                    try {
                        await this.bot.equip(pickaxe, "hand");
                    } catch (err) {
                        console.log(
                            `${this.username} pickaxe ushlashda xatolik: ${err.message}`,
                        );
                    }
                } else {
                    console.log(`${this.username} pickaxe topilmadi, chiqyapti...`);
                    this.mining = false;
                    return this.bot.quit();
                }

                const block = this.bot.blockAtCursor(7);
                if (!block) {
                    // nada block, kutib yana tekshir
                    await wait(100);
                    continue;
                }

                try {
                    await this.bot.dig(block, true);
                    // Muvaffaqiyatli qazildi
                    this.minedSinceTurn++;

                    // Agar is180 true va yetarli block qazilgan bo'lsa -> 180 gradus aylanish
                    if (this.is180 && this.minedSinceTurn >= this.turnAfter) {
                        this.minedSinceTurn = 0;
                        try {
                            const yaw = (this.bot.entity && this.bot.entity.yaw) || 0;
                            const pitch = (this.bot.entity && this.bot.entity.pitch) || 0;
                            const newYaw = this._normalizeAngle(yaw + Math.PI);
                            await this.bot.look(newYaw, pitch, true);
                            // kichik pauza rotation uchun
                            await wait(300);
                        } catch (err) {
                            console.log(`${this.username} rotate error: ${err.message}`);
                        }
                    }
                } catch (err) {
                    // qazishda xatolik bo'lsa hisoblamaymiz
                    console.log(`${this.username} qazishda xatolik: ${err.message}`);
                    await wait(100);
                }
            } catch (err) {
                console.log(`${this.username} mining loop error: ${err.message}`);
                await wait(500);
            }
            // kichik pauza tight-loopni oldini olish uchun
            await wait(50);
        }
    }


    parseKickReason(reason) {
        try {
            if (typeof reason === "string") return reason;
            if (reason && reason.extra) {
                return reason.extra.map((part) => part.text || "").join("");
            }
            return JSON.stringify(reason);
        } catch {
            return "Noma'lum sabab";
        }
    }

    scheduleReconnect(isBot = null) {
        if (isBot) {
            console.log('BotFilter orqali blocklandi, 30min...')
            setTimeout(() => {
                if (!this.isConnected) {
                    this.createBot();
                }
            }, 60000 * 30);
            return
        }
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            return;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay + Math.random() * 10000; // Add random delay

        setTimeout(() => {
            if (!this.isConnected) {
                this.createBot();
            }
        }, delay);
    }

    disconnect() {
        this.isConnected = false;
        if (this.bot) {
            this.bot.quit("Dastur to'xtatildi");
        }
    }
}

class BotManager {
    constructor(host, port) {
        this.host = host;
        this.port = port;
        this.bots = [];
        this.spawnDelay = 3500; // Increased delay between bot spawns

        // Silent bot manager initialization

        this.startSpawning();
        this.setupGracefulShutdown();
    }

    startSpawning() {
        let currentIndex = 0;

        const interval = setInterval(() => {
            if (currentIndex >= BOT_CONFIGS.length) {
                clearInterval(interval);
                return;
            }

            const config = BOT_CONFIGS[currentIndex];
            const delay = Math.random() * 2000; // Random delay up to 5 seconds
            const bot = new ZenomusBot(config, this.host, this.port, delay);

            this.bots.push(bot);
            currentIndex++;
        }, this.spawnDelay);
    }

    setupGracefulShutdown() {
        process.on("SIGINT", () => {
            this.disconnectAllBots();
            process.exit(0);
        });

        process.on("SIGTERM", () => {
            this.disconnectAllBots();
            process.exit(0);
        });
    }

    disconnectAllBots() {
        this.bots.forEach((bot) => {
            try {
                bot.disconnect();
            } catch (error) {
                // Silent error handling
            }
        });
    }

    getStats() {
        const connected = this.bots.filter((bot) => bot.isConnected).length;
        const miners = this.bots.filter(
            (bot) => bot.isMiner && bot.isConnected,
        ).length;
        const regular = connected - miners;
        return {
            total: this.bots.length,
            connected: connected,
            disconnected: this.bots.length - connected,
            miners: miners,
            regular: regular,
        };
    }
}

// Configuration
const HOST = "hypixel.uz";
const PORT = 25565;

const manager = new BotManager(HOST, PORT);
