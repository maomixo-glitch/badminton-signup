// index.js — LINE 場次報名 Bot（支援 +N/-N、候補補位）
// 環境變數：CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET, PORT, ADMINS(逗號分隔)
// 依賴：@line/bot-sdk, express

const fs = require('fs');
const path = require('path');
const express = require('express');
const line = require('@line/bot-sdk');

// ====== 設定 ======
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const ADMINS = (process.env.ADMINS || '').split(',').map(s => s.trim()).filter(Boolean);
const MAX_ADD_PER_ONCE = 10; // +N/-N 的單次上限，可自行調整

// 管理員 ID 白名單
const adminUserIds = [
  'maomixo', // 你的 LINE userId
  'Uyyyyyyyyyyyyyyyyyyyyyy'  // 其他要加入的 ID
];

// 判斷是否為管理員
function isAdmin(userId, groupId, members) {
  if (adminUserIds.includes(userId)) return true; // 白名單直接通過
  const member = members.find(m => m.userId === userId);
  return member && member.isAdmin; // 或原本的判斷邏輯
}

// ====== 簡易 DB（檔案儲存）======
const DB_FILE = path.join(__dirname, 'data.json');
function loadDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const d = JSON.parse(raw);
    if (!d.events) d.events = [];
    if (!('current_event_id' in d)) d.current_event_id = null;
    return d;
  } catch (e) {
    return { current_event_id: null, events: [] };
  }
}
function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}
let db = loadDB();

// ====== LINE Client & App ======
const client = new line.Client(config);
const app = express();

app.get('/healthz', (req, res) => res.status(200).send('OK'));
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(r => res.json(r))
    .catch(err => {
      console.error(err);
      res.status(500).end();
    });
});

// ====== 小工具 ======
const isAdmin = (userId) => ADMINS.includes(userId);

function parsePlusMinus(text) {
  const m = text.trim().match(/^([+-])\s*(\d+)?$/);
  if (!m) return null;
  const sign = m[1];
  const n = Math.max(1, Math.min(parseInt(m[2] || '1', 10), MAX_ADD_PER_ONCE));
  return { sign, n };
}

function total(list) {
  return list.reduce((a, x) => a + (x.count || 1), 0);
}
function ensureCounts(list) {
  list.forEach(m => { if (!m.count || m.count < 1) m.count = 1; });
}
function indexByUserId(list, userId) {
  return list.findIndex(x => x.userId === userId);
}

function renderRow(i, m) {
  const tag = (m.count && m.count > 1) ? ` (+${m.count - 1})` : '';
  return `${i}. ${m.name}${tag}`;
}

function findCurrentEvent() {
  if (!db.current_event_id) return null;
  return db.events.find(e => e.event_id === db.current_event_id) || null;
}

function promoteFromWaitlist(cur) {
  ensureCounts(cur.attendees);
  ensureCounts(cur.waitlist);

  let free = cur.max - total(cur.attendees);
  if (free <= 0) return;

  let i = 0;
  while (free > 0 && i < cur.waitlist.length) {
    const w = cur.waitlist[i];
    const take = Math.min(w.count, free);

    const aidx = indexByUserId(cur.attendees, w.userId);
    if (aidx !== -1) cur.attendees[aidx].count += take;
    else cur.attendees.push({ userId: w.userId, name: w.name, count: take });

    w.count -= take;
    free -= take;
    if (w.count <= 0) cur.waitlist.splice(i, 1);
    else i++;
  }
}

function quickReplyDefault() {
  return {
    items: [
      { type: 'action', action: { type: 'message', label: '+1', text: '+1' } },
      { type: 'action', action: { type: 'message', label: '-1', text: '-1' } },
      { type: 'action', action: { type: 'message', label: '名單', text: 'list' } },
    ]
  };
}

function buildListText(cur) {
  ensureCounts(cur.attendees);
  const rows = [];
  for (let i = 0; i < cur.max; i++) {
    const m = cur.attendees[i];
    rows.push(m ? renderRow(i + 1, m) : `${i + 1}.`);
  }
  let text = `📌 ${cur.title || '本週羽球'}\n\n` +
             `📅 ${cur.date}\n` +
             `⏰ ${cur.timeRange}\n` +
             `地點：${cur.location}\n` +
             `====================\n` +
             `✅ 正式名單 (${total(cur.attendees)}/${cur.max}人)：\n` +
             rows.join('\n');

  if (cur.waitlist.length > 0) {
    const waitNames = cur.waitlist.map(m => `${m.name}${m.count > 1 ? `(+${m.count - 1})` : ''}`).join('、');
    text += `\n\n⏳ 候補：${waitNames}`;
  }
  return text;
}

function replyList(replyToken, cur) {
  const text = buildListText(cur);
  return client.replyMessage(replyToken, {
    type: 'text',
    text,
    quickReply: quickReplyDefault(),
  });
}

async function getDisplayName(event) {
  const userId = event.source.userId;
  if (event.source.type === 'group') {
    return client.getGroupMemberProfile(event.source.groupId, userId)
      .then(p => p.displayName)
      .catch(() => '（匿名）');
  }
  if (event.source.type === 'room') {
    return client.getRoomMemberProfile(event.source.roomId, userId)
      .then(p => p.displayName)
      .catch(() => '（匿名）');
  }
  return client.getProfile(userId)
    .then(p => p.displayName)
    .catch(() => '（匿名）');
}

// ====== 指令處理 ======
async function handlePlusN(event, n) {
  const cur = findCurrentEvent();
  if (!cur) {
    return client.replyMessage(event.replyToken, { type: 'text', text: '尚未建立場次，請管理員 /new 建立' });
  }

  ensureCounts(cur.attendees);
  ensureCounts(cur.waitlist);

  const userId = event.source.userId;
  const name = await getDisplayName(event);

  let idx = indexByUserId(cur.attendees, userId);
  if (idx !== -1) {
    cur.attendees[idx].count += n;
  } else {
    const left = cur.max - total(cur.attendees);
    if (left > 0) {
      const take = Math.min(n, left);
      cur.attendees.push({ userId, name, count: take });
      if (n > take) {
        const remain = n - take;
        const widx = indexByUserId(cur.waitlist, userId);
        if (widx !== -1) cur.waitlist[widx].count += remain;
        else cur.waitlist.push({ userId, name, count: remain });
      }
    } else {
      const widx = indexByUserId(cur.waitlist, userId);
      if (widx !== -1) cur.waitlist[widx].count += n;
      else cur.waitlist.push({ userId, name, count: n });
    }
  }

  saveDB();
  return replyList(event.replyToken, cur);
}

async function handleMinusN(event, n) {
  const cur = findCurrentEvent();
  if (!cur) {
    return client.replyMessage(event.replyToken, { type: 'text', text: '尚未建立場次，請管理員 /new 建立' });
  }

  ensureCounts(cur.attendees);
  ensureCounts(cur.waitlist);

  const userId = event.source.userId;

  let idx = indexByUserId(cur.attendees, userId);
  if (idx !== -1) {
    cur.attendees[idx].count -= n;
    if (cur.attendees[idx].count <= 0) cur.attendees.splice(idx, 1);
  } else {
    idx = indexByUserId(cur.waitlist, userId);
    if (idx !== -1) {
      cur.waitlist[idx].count -= n;
      if (cur.waitlist[idx].count <= 0) cur.waitlist.splice(idx, 1);
    } else {
      return client.replyMessage(event.replyToken, { type: 'text', text: '你目前不在名單中～' });
    }
  }

  // 從候補補位
  promoteFromWaitlist(cur);

  saveDB();
  return replyList(event.replyToken, cur);
}

function parseNewArgs(text) {
  // /new 2025-08-16 | 18:00-20:00 | 大安運動中心／羽10 [max=8] [title=週六羽球]
  const body = text.replace(/^\/new\s*/i, '');
  const parts = body.split('|').map(s => s.trim());

  if (parts.length < 3) return null;
  let [date, timeRange, location, ...rest] = parts;
  let max = 8;
  let title = '本週羽球';
  rest.forEach(seg => {
    const m1 = seg.match(/max\s*=\s*(\d+)/i);
    const m2 = seg.match(/title\s*=\s*(.+)/i);
    if (m1) max = Math.max(1, parseInt(m1[1], 10));
    if (m2) title = m2[1].trim();
  });

  return { date, timeRange, location, max, title };
}

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text = (event.message.text || '').trim();
  const lower = text.toLowerCase();

  // +N / -N
  const pm = parsePlusMinus(lower);
  if (pm) {
    if (pm.sign === '+') return handlePlusN(event, pm.n);
    else return handleMinusN(event, pm.n);
  }

  // list / 名單
  if (lower === 'list' || text === '名單') {
    const cur = findCurrentEvent();
    if (!cur) return client.replyMessage(event.replyToken, { type: 'text', text: '尚未建立場次，請管理員 /new 建立' });
    return replyList(event.replyToken, cur);
  }

  // /whoami
  if (lower === '/whoami') {
    const name = await getDisplayName(event);
    const userId = event.source.userId || '(無)';
    const s = `你的名稱：${name}\nuserId：${userId}`;
    return client.replyMessage(event.replyToken, { type: 'text', text: s });
  }

  // /new  只有管理員能用
  if (lower.startsWith('/new')) {
    const userId = event.source.userId;
    if (!isAdmin(userId)) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '只有管理員可以建立場次喔～' });
    }
    const args = parseNewArgs(text);
    if (!args) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '格式：/new 2025-08-16 | 18:00-20:00 | 大安運動中心／羽10 [max=8] [title=週六羽球]'
      });
    }
    const event_id = `evt_${Date.now()}`;
    const cur = {
      event_id,
      title: args.title,
      date: args.date,
      timeRange: args.timeRange,
      location: args.location,
      max: args.max,
      status: 'open',
      attendees: [],
      waitlist: [],
      createdAt: new Date().toISOString(),
    };
    db.events.push(cur);
    db.current_event_id = event_id;
    saveDB();

    const head = `本週羽球報名開放～`;
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: head,
      quickReply: quickReplyDefault(),
    });
    // 再貼名單
    return pushList(event, cur);
  }

  // /open /close（管理員）
  if (lower === '/open' || lower === '/close') {
    const userId = event.source.userId;
    if (!isAdmin(userId)) return client.replyMessage(event.replyToken, { type: 'text', text: '只有管理員可以操作～' });
    const cur = findCurrentEvent();
    if (!cur) return client.replyMessage(event.replyToken, { type: 'text', text: '尚未建立場次。' });
    cur.status = lower === '/open' ? 'open' : 'closed';
    saveDB();
    return replyList(event.replyToken, cur);
  }

  // /reset（管理員）
  if (lower === '/reset') {
    const userId = event.source.userId;
    if (!isAdmin(userId)) return client.replyMessage(event.replyToken, { type: 'text', text: '只有管理員可以操作～' });
    const cur = findCurrentEvent();
    if (!cur) return client.replyMessage(event.replyToken, { type: 'text', text: '尚未建立場次。' });
    cur.attendees = [];
    cur.waitlist = [];
    saveDB();
    return replyList(event.replyToken, cur);
  }

  // /send（管理員）— 重新貼一次統整
  if (lower === '/send') {
    const userId = event.source.userId;
    if (!isAdmin(userId)) return client.replyMessage(event.replyToken, { type: 'text', text: '只有管理員可以操作～' });
    const cur = findCurrentEvent();
    if (!cur) return client.replyMessage(event.replyToken, { type: 'text', text: '尚未建立場次。' });
    return replyList(event.replyToken, cur);
  }

  // help
  if (lower === 'help' || lower === '/help') {
    const helpText =
      '指令：\n' +
      '• +1 / -1：報名或取消\n' +
      '• +N / -N：一次加減人數（例如 +3）\n' +
      '• list / 名單：查看名單\n' +
      '• /new yyyy-mm-dd | 18:00-20:00 | 地點 [max=8]：建立場次（管理員）\n' +
      '• /open / /close：開關報名（管理員）\n' +
      '• /reset：重置名單（管理員）\n' +
      '• /send：重新貼名單（管理員）\n' +
      '• /whoami：顯示 userId';
    return client.replyMessage(event.replyToken, { type: 'text', text: helpText, quickReply: quickReplyDefault() });
  }

  // 其餘不處理
  return;
}

async function pushList(event, cur) {
  const text = buildListText(cur);
  const reply = {
    type: 'text',
    text,
    quickReply: quickReplyDefault(),
  };
  // 若是在群組：用 reply 即可
  return client.replyMessage(event.replyToken, reply);
}

// ====== 啟動伺服器 ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server on ${PORT}`);
});
