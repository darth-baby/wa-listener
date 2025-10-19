// index.js
require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');

// ... (Настройки из .env, SQLite и функция очистки остаются без изменений) ...
const TARGET_GROUP_IDS = process.env.TARGET_GROUP_IDS ? process.env.TARGET_GROUP_IDS.split(',') : [];
const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:8000/incoming';

if (TARGET_GROUP_IDS.length === 0) {
    console.warn('Внимание: не указаны ID целевых групп в .env файле (TARGET_GROUP_IDS). Бот будет слушать все чаты.');
} else {
    console.log(`Бот будет слушать сообщения только из ${TARGET_GROUP_IDS.length} групп.`);
}

const db = new sqlite3.Database('./messages.db', (err) => {
  if (err) return console.error('DB error:', err.message);
  console.log('Connected to SQLite DB.');
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
    const cutoffTimestamp = Math.floor(Date.now() / 1000) - (olderThanDays * 24 * 60 * 60);

    db.run(`DELETE FROM messages WHERE timestamp < ?`, [cutoffTimestamp], function(err) {
        if (err) return console.error('DB cleanup error:', err.message);
        if (this.changes > 0) console.log(`DB cleanup: удалено ${this.changes} старых сообщений.`);
    });
}

setInterval(cleanupDatabase, 24 * 60 * 60 * 1000); 
cleanupDatabase();

const client = new Client({
  authStrategy: new LocalAuth({ clientId: "wa_listener" }),
  puppeteer: { 
    headless: false, // Для сервера всегда true
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', (qr) => {
  console.log('QR получен — отсканируй его в WhatsApp (Menu → Linked devices → Link a device).');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ WhatsApp client ready.');
});

client.on('auth_failure', msg => {
  console.error('Auth failure', msg);
});

// Слушаем входящие сообщения
client.on('message', async (msg) => {
  try {
    const chat = await msg.getChat();

    if (!chat.isGroup || (TARGET_GROUP_IDS.length > 0 && !TARGET_GROUP_IDS.includes(chat.id._serialized))) {
        console.log(`[ИГНОР] Сообщение пришло из личного чата, а не из группы. Проигнорировано.`);
        return;
    }

    // --- НОВОЕ: Получаем данные о контакте, отправившем сообщение ---
    const contact = await msg.getContact();
    const authorId = msg.author || msg.from;

    const payload = {
      // Старые данные
      wa_chat_id: chat.id._serialized,
      wa_author: authorId, // Уникальный ID вида 79...c.us
      wa_body: msg.body || '',
      is_group: chat.isGroup ? 1 : 0,
      timestamp: msg.timestamp || Math.floor(Date.now() / 1000),

      // --- НОВЫЕ ДАННЫЕ ---
      wa_user_name: contact.pushname || contact.name || "Имя не указано", // Имя из профиля или из контактов
      wa_user_number: contact.number // Номер телефона
    };

    // Сохранение в SQLite остается без изменений, но вы можете добавить новые поля и туда при желании
    const stmt = db.prepare(`INSERT INTO messages (wa_chat_id, wa_author, wa_body, is_group, timestamp, wa_name, wa_number) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    stmt.run(payload.wa_chat_id, payload.wa_author, payload.wa_body, payload.is_group, payload.timestamp, payload.wa_user_name, payload.wa_user_number, function(err) {
      if (err) return console.error('DB insert error:', err.message);
      console.log(`Сохранено сообщение (id=${this.lastID}) от ${payload.wa_user_name} в группе ${chat.name}`);
    });
    stmt.finalize();

    // Отправляем расширенный payload на backend
    axios.post(BACKEND_URL, payload)
      .then(res => console.log(`Отправлено на backend: статус ${res.status}`))
      .catch(err => console.warn('Ошибка при отправке на backend:', err.message));

  } catch (e) {
    console.error('Message handling error:', e);
  }
});

client.initialize();

process.on('SIGINT', () => {
  console.log('Shutting down...');
  client.destroy();
  db.close(() => {
    console.log('DB closed.');
    process.exit(0);
  });
});