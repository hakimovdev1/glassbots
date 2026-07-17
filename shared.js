// ======================================================================
// UMUMIY KONSTANTALAR — glassFiller.js va crafter.js IKKALASI ham shu
// fayldan oladi. Sandiq tartibi va homeChestArea ikkala botda BIR XIL
// bo'lishi SHART: crafter shu tartibda to'ldiradi, glassFiller shu
// tartibda oladi — bottle lar doim ro'yxat boshidagi sandiqlarda turadi.
// O'zgartirish kerak bo'lsa FAQAT shu faylni o'zgartiring.
// ======================================================================
'use strict'

// Glass_bottle deposit/restock sandiqlari joylashgan quti (box):
const HOME_CHEST_AREA = {
    min: { x: 3765, y: 79, z: 5882 },
    max: { x: 3776, y: 81, z: 5892 },
}

// Sandiqlarni ochish tartibi — HAR DOIM bir xil (random emas, bir boshidan):
// avval past qavat (y), keyin z, keyin x bo'yicha o'sish tartibida.
function chestOrder(a, b) {
    return a.y - b.y || a.z - b.z || a.x - b.x
}

// Berilgan pozitsiya HOME_CHEST_AREA qutisi ichidami?
function inHomeChestArea(p) {
    const { min, max } = HOME_CHEST_AREA
    return p.x >= min.x && p.x <= max.x &&
        p.y >= min.y && p.y <= max.y &&
        p.z >= min.z && p.z <= max.z
}

// ======================= LOG TIZIMI =======================
// loggerType qiymatlari:
//  'logsiz'   - hech qanday log chiqarilmaydi
//  'muhim'    - faqat muhim voqealar: boshlanish/tugash, sikl natijalari,
//               xatolar, uzilish/qayta ulanish, buyruq javoblari
//  'barchasi' - hamma narsa: har bir sandiq, qadam, server xabarlari ham
const LOG_LEVELS = { logsiz: 0, muhim: 1, barchasi: 2 }

// msgLevel: 'muhim' yoki undefined (undefined = faqat 'barchasi' da ko'rinadi)
function shouldLog(loggerType, msgLevel) {
    const current = LOG_LEVELS[loggerType] !== undefined ? LOG_LEVELS[loggerType] : 2
    const needed = msgLevel === 'muhim' ? 1 : 2
    return current >= needed
}

module.exports = { HOME_CHEST_AREA, chestOrder, inHomeChestArea, LOG_LEVELS, shouldLog }
