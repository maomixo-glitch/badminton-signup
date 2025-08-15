// index.js
// LINE Badminton Signup Bot (Render-Friendly)
// 作者: 依你的需求客製化（多場次 / Flex 按鈕 / Quick Reply / 白名單 / +N/-N 修正）

const express = require('express');
const line = require('@line/bot-sdk');
const fs = require('fs');
const path = require('path');

// ====== 環境變數 ======
const {
  CHANNEL_ACCESS_TOKEN,
  CHANNEL_SECRET,
  PORT = 3000,
  ADMINS = '', // 逗號分隔的 userId 清單
} = process.env;

const admins = ADMINS.split(',').map(s => s.trim()).filter(Boolean);

// ====== LINE SDK ======
const config = {
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET,
};
const client = new line.Client(config);

// ====== Express ======
const app = express();
app.use(express.json());

// 健康檢查
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// ====== DB（存本機檔案） ======
const DB_FILE = path.join(__dirname, 'data.json');
const initDB = { events: [] }; // { date, timeRange, location, max, title, status, attendees: [{userId,name,count}] }

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(initDB, null, 2));
      return JSON.parse(JSON.stringify(initDB));
    }
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('loadDB error:', e);
    return JSON.parse(JSON.stringify(initDB));
  }
}
function saveDB(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('saveDB error:', e);
  }
}

let db = loadDB();

// ====== 工具 ======
const MAX_ADD_PER_ONCE = 10; // +N/-N 單次上限
const DEFAULT_MAX = 10;

// 解析 +N / -N（可含日期）
function parsePlusMinusWithDate(text) {
  // 範例：+3、-1、+1 2025-08-16、-2 2025-08-23
  const m = text.trim().match(/^([+-])\s*(\d+)?(?:\s+(\d{4}-\d{2}-\d{2}))?$/);
  if (!m) return null;
  const sign = m[1];
  const n = Math.min(parseInt(m[2] || '1', 10), MAX_ADD_PER_ONCE);
  const date = m[3] || null;
  return { sign, n, date };
}

// 解析 名單 [日期]
function parseListWithDate(text) {
  const m = text.trim().match(/^名單(?:\s+(\d{4}-\d{2}-\d{2}))?$|^list(?:\s+(\d{4}-\d{2}-\d{2}))?$/i);
  if (!m) return null;
  const date = m[1] || m[2] || null;
  return { date };
}

// 總人數（sum of count）
function total(list = []) {
  return list.reduce((a, x) => a + (x.count || 1), 0);
}

function findEventByDate(date) {
  return db.events.find(e => e.date === date) || null;
}

function openEventsSorted() {
  return db.events
    .filter(e => e.status !== 'closed')
    .sort((a, b) => a.date.localeCompare(b.date));
}

function pickDefaultEvent() {
  const opens = openEventsSorted();
  return opens[0] || null;
}

function isAdmin(userId) {
  if (!admins.length) return true; // 若未設定 ADMINS，預設允許
  return admins.includes(userId);
}

async function getDisplayName(userId) {
  try {
    const prof = await client.getProfile(userId);
    return prof.displayName || '匿名';
  } catch (e) {
    return '匿名';
  }
}

// ====== Flex / Quick Reply ======

function quickReplyChoose(signLabel = '+1') {
  const items = openEventsSorted().slice(0, 4).map(e => ({
    type: 'action',
    action: {
      type: 'message',
      label: `${signLabel} ${e.date.slice(5)}`, // 08-16
      text: `${signLabel} ${e.date}`,
    },
  }));
  return { items };
}

function flexEventCard(e) {
  return {
    type: 'flex',
    altText: `${e.title || '週末羽球'} ${e.date}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: e.title || '週末羽球', weight: 'bold', size: 'lg' },
          { type: 'text', text: e.date, size: 'sm', color: '#888888' },
          { type: 'text', text: e.timeRange || '', size: 'sm', color: '#888888' },
          { type: 'text', text: `地點：${e.location || ''}`, size: 'sm', wrap: true },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: `名額：${total(e.attendees)}/${e.max}`, size: 'sm' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'md',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#22c55e',
            action: { type: 'message', label: '+1', text: `+1 ${e.date}` },
          },
          {
            type: 'button',
            style: 'secondary',
            action: { type: 'message', label: '-1', text: `-1 ${e.date}` },
          },
          {
            type: 'button',
            style: 'link',
            action: { type: 'message', label: '名單', text: `名單 ${e.date}` },
          },
        ],
      },
    },
  };
}

async function sendEventCards(replyToken) {
  const opens = openEventsSorted().slice(0, 2);
  if (opens.length === 0) {
    return client.replyMessage(replyToken, { type: 'text', text: '目前沒有開放場次。' });
  }
  const messages = opens.map(flexEventCard);
  return client.replyMessage(replyToken, messages);
}

// ====== 名單輸出 ======
function renderListText(e) {
  const lines = [];
  lines.push(`📌 ${e.title || '週末羽球'}`);
  lines.push(`📅 ${e.date}`);
  if (e.timeRange) lines.push(`⏰ ${e.timeRange}`);
  if (e.location) lines.push(`📍 地點：${e.location}`);
  lines.push('====================');

  const cur = total(e.attendees);
  lines.push(`✅ 正式名單 (${cur}/${e.max}人)：`);

  // 排名序
  const arr = e.attendees.slice();
  arr.forEach((m, i) => {
    const extra = m.count > 1 ? ` (+${m.count - 1})` : '';
    lines.push(`${i + 1}. ${m.name}${extra}`);
  });

  // 補空位顯示
  for (let i = arr.length + 1; i <= e.max; i++) {
    lines.push(`${i}.`);
  }

  return lines.join('\n');
}

async function replyList(replyToken, e) {
  return client.replyMessage(replyToken, {
    type: 'text',
    text: renderListText(e),
  });
}

// ====== +N / -N 實作（針對特定場次） ======
async function handlePlusNForEvent(event, n, e) {
  const userId = event.source.userId;
  const name = await getDisplayName(userId);

  // 找此人
  let m = e.attendees.find(x => x.userId === userId);
  if (!m) {
    m = { userId, name, count: 0 };
    e.attendees.push(m);
  }
  m.name = name; // 更新名稱
  m.count = Math.min(m.count + n, MAX_ADD_PER_ONCE);

  if (total(e.attendees) > e.max) {
    // 超過上限就回覆提示（這邊不自動佔位，看你需求）
    m.count = Math.max(m.count - n, 0);
    saveDB(db);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `這一場名額已滿 (${total(e.attendees)}/${e.max})，無法再增加。`,
    });
  }

  // 移除 count <= 0 的
  e.attendees = e.attendees.filter(x => x.count > 0);

  saveDB(db);
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `已為 ${name} 在 ${e.date} 場次 +${n}`,
    quickReply: quickReplyChoose('+1'),
  });
}

async function handleMinusNForEvent(event, n, e) {
  const userId = event.source.userId;
  const name = await getDisplayName(userId);

  let m = e.attendees.find(x => x.userId === userId);
  if (!m) {
    return client.replyMessage(event.replyToken, { type: 'text', text: '你目前沒有在名單中。' });
  }
  m.count = Math.max(m.count - n, 0);
  if (m.count <= 0) {
    e.attendees = e.attendees.filter(x => x.userId !== userId);
  }

  saveDB(db);
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `已為 ${name} 在 ${e.date} 場次 -${n}`,
    quickReply: quickReplyChoose('-1'),
  });
}

// ====== 建立場次 (/new) ======
// 格式：/new YYYY-MM-DD | HH:MM-HH:MM | 地點
function parseNewPayload(s) {
  // 以 | 分段
  const parts = s.split('|').map(t => t.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const date = parts[0];
  const timeRange = parts[1] || '';
  const location = parts[2] || '';
  let title = parts[3] || '週末羽球';
  let max = parseInt(parts[4] || DEFAULT_MAX, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!Number.isFinite(max) || max < 1) max = DEFAULT_MAX;

  return { date, timeRange, location, title, max };
}

async function handleNew(event, payload) {
  const userId = event.source.userId || '';
  if (!isAdmin(userId)) {
    return client.replyMessage(event.replyToken, { type: 'text', text: '只有管理員可以建立場次喔～' });
  }

  const p = parseNewPayload(payload);
  if (!p) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '格式錯誤，請用：\n/new YYYY-MM-DD | HH:MM-HH:MM | 地點',
    });
  }

  let e = findEventByDate(p.date);
  if (e) {
    // 同日期已存在 → 覆蓋更新
    e.timeRange = p.timeRange;
    e.location = p.location;
    e.title = p.title || e.title || '週末羽球';
    e.max = p.max || e.max || DEFAULT_MAX;
    e.status = 'open';
  } else {
    e = {
      date: p.date,
      timeRange: p.timeRange,
      location: p.location,
      title: p.title || '週末羽球',
      max: p.max || DEFAULT_MAX,
      status: 'open',
      attendees: [],
    };
    db.events.push(e);
  }
  saveDB(db);

  // 建完立即顯示卡片
  return client.replyMessage(event.replyToken, flexEventCard(e));
}

// ====== /send：把目前 open 的兩場貼出卡片 ======
async function handleSend(event) {
  return sendEventCards(event.replyToken);
}

// ====== 路由（Webhook） ======
app.post('/webhook', async (req, res) => {
  const events = req.body.events || [];
  const results = await Promise.all(events.map(handleEvent));
  res.json(results);
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return null;

  const text = (event.message.text || '').trim();

  // /new
  const newMatch = text.match(/^\/new\s+(.+)/i);
  if (newMatch) {
    return handleNew(event, newMatch[1]);
  }

  // /send
  if (/^\/send$/i.test(text)) {
    return handleSend(event);
  }

  // 名單 [date]
  const listParsed = parseListWithDate(text);
  if (listParsed) {
    let target = listParsed.date ? findEventByDate(listParsed.date) : null;
    if (!target) {
      const opens = openEventsSorted();
      if (opens.length === 0) {
        return client.replyMessage(event.replyToken, { type: 'text', text: '目前沒有開放場次。' });
      }
      if (opens.length > 1 && !listParsed.date) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '請選擇要查看的場次：',
          quickReply: {
            items: openEventsSorted().slice(0, 4).map(e => ({
              type: 'action',
              action: { type: 'message', label: e.date.slice(5), text: `名單 ${e.date}` },
            })),
          },
        });
      }
      target = opens[0];
    }
    return replyList(event.replyToken, target);
  }

  // +N / -N [date]
  const pm = parsePlusMinusWithDate(text);
  if (pm) {
    let target = pm.date ? findEventByDate(pm.date) : null;
    if (!target) {
      const opens = openEventsSorted();
      if (opens.length === 0) {
        return client.replyMessage(event.replyToken, { type: 'text', text: '目前沒有開放場次。' });
      }
      if (opens.length > 1 && !pm.date) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '請選擇要報名的場次：',
          quickReply: quickReplyChoose(pm.sign === '+' ? '+1' : '-1'),
        });
      }
      target = opens[0];
    }
    if (pm.sign === '+') return handlePlusNForEvent(event, pm.n, target);
    return handleMinusNForEvent(event, pm.n, target);
  }

  // 其他情況不回或回簡短說明
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: '指令：\n' +
      '・/new YYYY-MM-DD | HH:MM-HH:MM | 地點 |（可選標題）|（可選名額）\n' +
      '・/send（貼出兩場卡片）\n' +
      '・+1 / -1（有多場會跳選單）\n' +
      '・+3 2025-08-16（指定日期）\n' +
      '・名單 / 名單 2025-08-16',
  });
}

// ====== 啟動 ======
app.listen(PORT, () => {
  console.log(`Server on ${PORT}`);
});
