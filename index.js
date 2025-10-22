require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
let startTimestamp = Math.floor(Date.now() / 1000);

const TARGET_GROUP_IDS = process.env.TARGET_GROUP_IDS
  ? process.env.TARGET_GROUP_IDS.split(',')
  : [];
const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:8000/incoming';
const CHROME_PATH = process.env.CHROME_PATH

// Заменяем стандартный puppeteer на "усиленный"
const puppeteer = require('puppeteer-extra');
// Подключаем плагин для маскировки
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

if (TARGET_GROUP_IDS.length === 0) {
  console.warn('⚠️ Внимание: не указаны TARGET_GROUP_IDS. Бот будет слушать все группы.');
} else {
  console.log(`🎯 Бот слушает ${TARGET_GROUP_IDS.length} групп(ы).`);
}

const db = new sqlite3.Database('./messages.db', (err) => {
  if (err) return console.error('❌ DB error:', err.message);
  console.log('🗄️ Подключено к SQLite.');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_chat_id TEXT,
    wa_author TEXT,
    wa_body TEXT,
    is_group INTEGER,
    timestamp INTEGER,
    wa_name TEXT,
    wa_number TEXT
  )`);
});

function cleanupDatabase() {
  const olderThanDays = 7;
  const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 24 * 60 * 60;

  db.run(`DELETE FROM messages WHERE timestamp < ?`, [cutoff], function (err) {
    if (err) return console.error('DB cleanup error:', err.message);
    if (this.changes > 0)
      console.log(`🧹 Очистка БД: удалено ${this.changes} старых сообщений.`);
  });
}
cleanupDatabase();
setInterval(cleanupDatabase, 24 * 60 * 60 * 1000);

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'me' }),
  puppeteer: {
    // ВАЖНО: Указываем puppeteer, который мы настроили выше
    // Вместо того чтобы библиотека использовала свой собственный
    puppeteer, 
    headless: false, // Оставляем false для отладки, потом можно будет сменить на 'new' или true
    executablePath: CHROME_PATH,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox'
        // Можно добавить еще несколько "человечных" аргументов, но stealth-plugin уже делает многое
    ]
  },
  webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
  }
});

client.on('qr', (qr) => {
  console.log('📲 QR получен — отсканируйте в WhatsApp: Menu → Linked devices → Link a device');
  qrcode.generate(qr, { small: true });
});

client.once('ready', async () => {
  console.log('✅ WhatsApp клиент готов (событие получено).');
  console.log('⏳ Проверяем полную загрузку клиента (до 120 секунд)...');

  const maxWaitTime = 120000; // 120 секунд в мс
  const checkInterval = 10000; // проверять каждые 10 секунд
  let timeWaited = 0;
  let isClientReallyReady = false;

  while (timeWaited < maxWaitTime) {
    try {
      // Пытаемся выполнить действие, требующее полной загрузки
      await client.getState(); 
      console.log('👍 Проверка состояния пройдена, клиент полностью функционален!');
      isClientReallyReady = true;
      break; // Выходим из цикла, если проверка успешна
    } catch (err) {
      console.log(`...проверка не удалась, ждём ещё ${checkInterval / 1000} сек...`);
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      timeWaited += checkInterval;
    }
  }

  if (isClientReallyReady) {
    console.log('📡 Готов к приёму сообщений.');
    startTimestamp = Math.floor(Date.now() / 1000);
  } else {
    console.error('❌ Клиент не смог полностью инициализироваться за 120 секунд. Вероятно, "зомби-состояние".');
    console.error('Завершение работы. Попробуйте перезапустить бота.');
    process.exit(1); // Аварийно завершаем процесс
  }
});

client.on('auth_failure', (msg) => {
  console.error('❌ Ошибка авторизации:', msg);
});

client.on('disconnected', (reason) => {
  console.warn('⚠️ Клиент отключён:', reason);
});


client.on('message', async (msg) => {
  try {
    // Игнор старых сообщений при загрузке истории
    if (msg.timestamp < startTimestamp) {
      console.log(`[СКИП] Старое сообщение от ${msg.from}`);
      return;
    }

    // Пытаемся получить чат
    const chat = await msg.getChat().catch(() => null);
    if (!chat) {
      console.warn('⚠️ Не удалось получить чат (ещё не загружен).');
      return;
    }

    // Проверяем фильтр по группам
    if (!chat.isGroup || (TARGET_GROUP_IDS.length > 0 && !TARGET_GROUP_IDS.includes(chat.id._serialized))) {
      console.log(`[ИГНОР] Сообщение из личного чата или нецелевой группы (${chat.name || msg.from}).`);
      return;
    }

    // Получаем контакт (автора)
    const contact = await msg.getContact().catch(() => null);
    const payload = {
      wa_chat_id: chat.id._serialized,
      wa_author: msg.author || msg.from,
      wa_body: msg.body || '',
      is_group: chat.isGroup ? 1 : 0,
      timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
      wa_name: contact?.pushname || contact?.name || 'Имя не указано',
      wa_number: contact?.number || 'Неизвестно',
    };

    const stmt = db.prepare(
      `INSERT INTO messages (wa_chat_id, wa_author, wa_body, is_group, timestamp, wa_name, wa_number)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      payload.wa_chat_id,
      payload.wa_author,
      payload.wa_body,
      payload.is_group,
      payload.timestamp,
      payload.wa_name,
      payload.wa_number,
      function (err) {
        if (err) return console.error('❌ DB insert error:', err.message);
        console.log(`💾 Сообщение (id=${this.lastID}) от ${payload.wa_name} в группе ${chat.name}`);
      }
    );
    stmt.finalize();

    axios.post(BACKEND_URL, payload)
      .then(res => console.log(`📤 Отправлено на backend: статус ${res.status}`))
      .catch(err => console.warn('⚠️ Ошибка при отправке на backend:', err.message));

  } catch (e) {
    console.error('💥 Ошибка при обработке сообщения:', e.message);
  }
});


client.initialize();

process.on('SIGINT', () => {
  console.log('\n🛑 Остановка...');
  client.destroy();
  db.close(() => {
    console.log('📁 База закрыта.');
    process.exit(0);
  });
});
