// LINE 羽球報名 Bot（Render 版）
// 指令：/new 建立、+1 報名、-1 取消、list/名單 查名單、/reset、/close、/send、/whoami
require('dotenv').config();
const fs = require('fs');
const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();

// 健康檢查
app.get('/', (_, res) => res.send('OK'));

// LINE Webhook 端點（這個要貼到 LINE Developers）
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    const results = await Promise.all((req.body.events || []).map(handleEvent));
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

// ---- 簡單檔案型「資料庫」 ----
const DB_PATH = './data.json';
function loadDB() {
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ currentEvent: null }, null, 2));
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function saveDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

function emptyEvent(date, timeRange, location, max = 8) {
  return { date, timeRange, location, max, status: 'open', attendees: [], waitlist: [] };
}

async function getDisplayName(event) {
  try {
    const userId = event.source.userId;
    if (event.source.groupId) {
      const prof = await client.getGroupMemberProfile(event.source.groupId, userId);
      return { userId, name: prof.displayName };
    } else if (event.source.roomId) {
      const prof = await client.getRoomMemberProfile(event.source.roomId, userId);
      return { userId, name: prof.displayName };
    } else {
      const prof = await client.getProfile(userId);
      return { userId, name: prof.displayName };
    }
  } catch {
    return { userId: event.source.userId, name: `User_${(event.source.userId || '').slice(-4)}` };
  }
}
const inList = (list, id) => list.findIndex(x => x.userId === id);

function buildFlex(ev) {
  const { date, timeRange, location, max, attendees, waitlist, status } = ev;
  const normalizedTime = timeRange.includes(' - ') ? timeRange : timeRange.replace('-', ' - ');
  const rows = Array.from({ length: max }, (_, i) => `${i + 1}. ${attendees[i]?.name || ''}`).join('\n');
  const wl = waitlist.length ? `\n— 候補 —\n${waitlist.map((w,i)=>`${i+1}. ${w.name}`).join('\n')}` : '';
  const text =
`📅 ${date}
⏰ ${normalizedTime}
地點：${location}
====================
${status === 'closed' ? '⛔ 報名已關閉' : `✅ 正式名單 (${attendees.length}/${max}人)：`}
${rows}${wl}`;

  return {
    type: 'flex',
    altText: `羽球名單：${date} ${normalizedTime}`,
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents: [
        { type: 'text', text: '🏸 週六羽球', weight: 'bold', size: 'lg' },
        { type: 'text', text, wrap: true, margin: 'md' }
      ]},
      footer: { type: 'box', layout: 'horizontal', contents: [
        { type: 'button', style: 'primary',   action: { type: 'message', label: '+1', text: '+1' } },
        { type: 'button', style: 'secondary', action: { type: 'message', label: '-1', text: '-1' } },
        { type: 'button', style: 'secondary', action: { type: 'message', label: '名單', text: 'list' } }
      ]}
    }
  };
}

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return null;
  const text = event.message.text.trim();
  const lower = text.toLowerCase();

  const db = loadDB(); let cur = db.currentEvent;

  // 可選：限制管理員 userId（填入你的 userId）
  const ADMINS = []; // 例如 ['Uxxxxxxxxxxxxxxxxxxxxxxxxxxxx']
  const isAdmin = () => ADMINS.length === 0 || ADMINS.includes(event.source.userId);

  if (lower === '/whoami') {
    return client.replyMessage(event.replyToken, { type: 'text', text: `你的 userId：${event.source.userId}` });
  }

  if (lower.startsWith('/new')) {
    if (!isAdmin()) return client.replyMessage(event.replyToken, { type: 'text', text: '你沒有權限使用 /new。' });
    const parts = text.replace(/^\/new\s*/i, '').split('|').map(s => s.trim());
    if (parts.length < 3) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '格式：/new 日期 | 時段 | 地點\n例：/new 2025-08-14 | 18:00-20:00 | 大安運動中心／羽10' });
    }
    const [date, timeRange, location] = parts;
    cur = emptyEvent(date, timeRange, location, 8);
    db.currentEvent = cur; saveDB(db);
    return client.replyMessage(event.replyToken, [
      { type: 'text', text: '本週羽球報名開放～' },
      buildFlex(cur)
    ]);
  }

  if (lower === '/reset') {
    if (!isAdmin()) return client.replyMessage(event.replyToken, { type: 'text', text: '你沒有權限使用 /reset。' });
    if (!cur) return client.replyMessage(event.replyToken, { type: 'text', text: '尚未建立場次，先用 /new 建立。' });
    cur.attendees = []; cur.waitlist = []; cur.status = 'open'; saveDB(db);
    return client.replyMessage(event.replyToken, [{ type: 'text', text: '名單已重置。' }, buildFlex(cur)]);
  }

  if (lower === '/close') {
    if (!isAdmin()) return client.replyMessage(event.replyToken, { type: 'text', text: '你沒有權限使用 /close。' });
    if (!cur) return client.replyMessage(event.replyToken, { type: 'text', text: '尚未建立場次。' });
    cur.status = 'closed'; saveDB(db);
    return client.replyMessage(event.replyToken, [{ type: 'text', text: '報名已關閉。' }, buildFlex(cur)]);
  }

  if (lower === '/send') {
    if (!isAdmin()) return client.replyMessage(event.replyToken, { type: 'text', text: '你沒有權限使用 /send。' });
    if (!cur) return client.replyMessage(event.replyToken, { type: 'text', text: '尚未建立場次。' });
    return client.replyMessage(event.replyToken, buildFlex(cur));
  }

  if (['list', '名單'].includes(lower)) {
    if (!cur) return client.replyMessage(event.replyToken, { type: 'text', text: '尚未建立場次。' });
    return client.replyMessage(event.replyToken, buildFlex(cur));
  }

  if (!cur) {
    return client.replyMessage(event.replyToken, { type: 'text', text: '尚未建立場次，管理員請用 /new 建立：\n/new 2025-08-14 | 18:00-20:00 | 大安運動中心／羽10' });
  }

  if (cur.status === 'closed' && lower.startsWith('+')) {
    return client.replyMessage(event.replyToken, { type: 'text', text: '報名已關閉。' });
  }

  if (lower.startsWith('+')) {
    const who = await getDisplayName(event);
    if (inList(cur.attendees, who.userId) !== -1 || inList(cur.waitlist, who.userId) !== -1) {
      return client.replyMessage(event.replyToken, [{ type: 'text', text: '你已經在名單裡囉～' }, buildFlex(cur)]);
    }
    if (cur.attendees.length < cur.max) cur.attendees.push({ ...who, ts: Date.now() });
    else { cur.waitlist.push({ ...who, ts: Date.now() }); await client.replyMessage(event.replyToken, { type: 'text', text: '本次已滿，已加入候補名單。' }); }
    saveDB(db);
    const target = event.source.groupId || event.source.roomId || event.source.userId;
    return client.pushMessage(target, buildFlex(cur)); // 用 push 更新整張名單
  }

  if (lower.startsWith('-')) {
    const who = await getDisplayName(event);
    let idx = inList(cur.attendees, who.userId);
    if (idx !== -1) {
      cur.attendees.splice(idx, 1);
      if (cur.waitlist.length > 0) cur.attendees.push(cur.waitlist.shift());
      saveDB(db);
      return client.replyMessage(event.replyToken, buildFlex(cur));
    }
    idx = inList(cur.waitlist, who.userId);
    if (idx !== -1) {
      cur.waitlist.splice(idx, 1);
      saveDB(db);
      return client.replyMessage(event.replyToken, buildFlex(cur));
    }
    return client.replyMessage(event.replyToken, { type: 'text', text: '你不在名單裡喔～' });
  }

  return client.replyMessage(event.replyToken, { type: 'text', text: '指令：+1 報名、-1 取消、list 查看名單；管理員：/new、/reset、/close、/send、/whoami' });
}

// 啟動 server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server on ${PORT}`);
});
