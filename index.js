// index.js
// 羽球報名 LINE Bot（Render 版）
// 需求對齊：簡化 /new、+N/-N、多場選擇、滿員提示、日提醒、list、所有人可建場

const express = require('express');
const line = require('@line/bot-sdk');
const fs = require('fs');
const path = require('path');

const app = express();

// ====== LINE 設定 ======
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

// ====== 檔案儲存（最簡易版） ======
const DB_FILE = path.join(__dirname, 'data.json');

let db = {
  events: {
    // '20250823': { id, date, md, dow, time, location, title, max, status, groupId, attendees:[{userId,name,count,ts}] }
  },
};

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('loadDB error', e);
  }
}
function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('saveDB error', e);
  }
}
loadDB();

// ====== 小工具 ======
const DEFAULT_MAX = 10;
const TITLE = '週末羽球';

const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
function pad2(n) { return n.toString().padStart(2, '0'); }

function dateIdFromYYYYMMDD(s) {
  return s.replace(/-/g, ''); // 2025-08-23 -> 20250823
}
function toYYYYMMDDFromMD(md) {
  // md = 8/23 -> 今年的 2025-08-23
  const now = new Date();
  const [m, d] = md.split('/').map(v => parseInt(v, 10));
  const y = now.getFullYear();
  return `${y}-${pad2(m)}-${pad2(d)}`;
}
function fromNewInputToEventObj(input) {
  // 允許兩種：
  // 1) /new 8/23 15:00-17:00 大安運動中心 羽10
  // 2) /new 2025-08-23 15:00-17:00 大安運動中心 羽10
  const s = input.replace(/^\/new\s*/i, '').trim();

  // 用空白切：日期 / 時間 / 地點 / 場地（地點與場地可有空白我用第一個兩段固定）
  // 我們採以下規則：
  // 第1段：日期（8/23 或 YYYY-MM-DD）
  // 第2段：時間（15:00-17:00）
  // 第3段~最後：地點與場地（最後一段視為場地），中間段合併成地點
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;

  let dateRaw = parts[0];
  let timeRange = parts[1];

  // 剩下為地點與場地（可沒有場地）
  let tail = parts.slice(2);
  let court = '';
  let location = '';

  if (tail.length >= 2) {
    court = tail[tail.length - 1];
    location = tail.slice(0, -1).join(' ');
  } else {
    location = tail[0];
  }

  // 日期轉 yyyy-mm-dd
  let yyyyMMDD = '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
    yyyyMMDD = dateRaw;
  } else if (/^\d{1,2}\/\d{1,2}$/.test(dateRaw)) {
    yyyyMMDD = toYYYYMMDDFromMD(dateRaw);
  } else {
    return null;
  }

  if (!/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(timeRange)) return null;

  // 組 location 顯示（地點／場地）
  const locShow = court ? `${location}／${court}` : location;

  // 產出其他欄位
  const id = dateIdFromYYYYMMDD(yyyyMMDD);
  const d = new Date(yyyyMMDD);
  const md = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const dow = weekdays[d.getDay()];

  return {
    id,
    date: yyyyMMDD,
    md,           // 08-23
    dow,          // 六
    time: timeRange,
    location: locShow,
    title: TITLE,
    max: DEFAULT_MAX,
    status: 'open',
    attendees: [], // {userId,name,count,ts}
    groupId: '',   // 建立當下會紀錄來源群組
  };
}

function totalCount(list) {
  return list.reduce((a, x) => a + (x.count || 1), 0);
}
function findAttendee(list, userId) {
  return list.findIndex(m => m.userId === userId);
}
function activeEvents(db) {
  // db 可能是 null/undefined
  const evtsObj = (db && db.events) ? db.events : {};
  return Object.values(evtsObj).filter(e => e.status !== 'closed');
}

function renderIntroCard(e) {
  // 建立場次後的宣告卡 + 說明
  const lines = [];
  lines.push('🏸 週末羽球報名開始！');
  lines.push(`📅 ${e.md}(${e.dow})`);
  lines.push(`⏰ ${e.time}`);
  lines.push(`👥 名額：${e.max} 人`);
  lines.push('');
  lines.push('📝 報名方式：');
  lines.push('• +1 ：只有自己 (1人)');
  lines.push('• +2 ：自己+朋友 (2人)');
  lines.push('• -1：自己取消');
  lines.push('');
  lines.push('輸入 "list" 查看報名狀況');
  return lines.join('\n');
}

function renderListText(e) {
  const lines = [];
  lines.push('📌週末羽球報名');
  lines.push(`📅 ${e.md}(${e.dow})`);
  lines.push(`⏰ ${e.time}`);
  lines.push(`📍：${e.location}`);
  lines.push('====================');
  const cur = totalCount(e.attendees);
  lines.push(`✅ 正式名單 (${cur}/${e.max}人)：`);
  if (e.attendees.length === 0) {
    lines.push('（尚無報名）');
  } else {
    e.attendees.forEach((m, i) => {
      const extra = (m.count > 1 ? ` (+${m.count - 1})` : '');
      lines.push(`${i + 1}. ${m.name}${extra}`);
    });
  }
  return lines.join('\n');
}

// ====== LINE Webhook ======
app.post('/webhook', express.json(), (req, res) => {
  Promise
    .all((req.body.events || []).map(handleEvent))
    .then(() => res.status(200).end())
    .catch(err => {
      console.error(err);
      res.status(500).end();
    });
});

// for Render health check
app.get('/', (req, res) => res.send('OK'));

// daily reminder trigger
app.get('/cron', async (req, res) => {
  try {
    await sendTomorrowReminders();
    res.send('cron ok');
  } catch (e) {
    console.error(e);
    res.status(500).send('cron error');
  }
});

async function handleEvent(event) {
  if (event.type === 'postback') {
    return handlePostback(event);
  }

  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;
  }

  const text = event.message.text.trim();
  const lower = text.toLowerCase();

  // 建場
  if (lower.startsWith('/new')) {
    const obj = fromNewInputToEventObj(text);
    if (!obj) {
      return reply(event, { type: 'text', text: '格式：\n/new 8/23 15:00-17:00 大安運動中心 羽10\n或 /new 2025-08-23 15:00-17:00 大安運動中心 羽10' });
    }
    // 同日期不可重覆
    if (db.events[obj.id]) {
      return reply(event, { type: 'text', text: '該日期已存在場次，不能重複建立喔！' });
    }
    // 紀錄 groupId 供之後提醒
    obj.groupId = event.source.groupId || event.source.roomId || '';
    db.events[obj.id] = obj;
    saveDB();

    // 建立後自動貼說明卡
    const summary = renderIntroCard(obj);
    const list = renderListText(obj);
    return reply(event, [
      { type: 'text', text: summary },
      {
        type: 'text',
        text: list,
        quickReply: {
          items: [
            { type: 'action', action: { type: 'postback', label: '+1', data: `act=join&id=${obj.id}&n=1` } },
            { type: 'action', action: { type: 'postback', label: '-1', data: `act=leave&id=${obj.id}&n=1` } },
            { type: 'action', action: { type: 'postback', label: '名單', data: `act=list&id=${obj.id}` } },
          ]
        }
      }
    ]);
  }

  // list
  if (lower === 'list' || text === '名單') {
    const evs = activeEvents();
    if (evs.length === 0) return reply(event, { type: 'text', text: '目前沒有開放報名的場次～' });
    if (evs.length === 1) {
      const e = evs[0];
      return reply(event, {
        type: 'text',
        text: renderListText(e),
        quickReply: {
          items: [
            { type: 'action', action: { type: 'postback', label: '+1', data: `act=join&id=${e.id}&n=1` } },
            { type: 'action', action: { type: 'postback', label: '-1', data: `act=leave&id=${e.id}&n=1` } },
          ]
        }
      });
    } else {
      return askPickEvent(event, 'list');
    }
  }

  // +N / -N（純文字）
  const m = text.match(/^\s*([+\-])\s*(\d+)?\s*(?:([0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}\/[0-9]{1,2}))?\s*$/);
  if (m) {
    const sign = m[1];
    const n = Math.min(parseInt(m[2] || '1', 10), 10);   // 上限 10
    let targetId = '';

    // 若有指定日期就用該日期
    if (m[3]) {
      const d = /^\d{4}-\d{2}-\d{2}$/.test(m[3]) ? m[3] : toYYYYMMDDFromMD(m[3]);
      targetId = dateIdFromYYYYMMDD(d);
    }

    // 無指定 → 看 active events
    const evs = activeEvents();
    if (!targetId) {
      if (evs.length === 0) return reply(event, { type: 'text', text: '目前沒有開放報名的場次～' });
      if (evs.length === 1) {
        targetId = evs[0].id;
      } else {
        // 多場 → 先讓他選
        return askPickEvent(event, sign === '+' ? `postJoin:${n}` : `postLeave:${n}`);
      }
    }

    if (sign === '+') {
      return doJoin(event, targetId, n);
    } else {
      return doLeave(event, targetId, n);
    }
  }

  // /help 或 /?
  if (lower === '/help' || lower === '/?') {
    const help = [
      '指令：',
      '• /new 8/23 15:00-17:00 大安運動中心 羽10',
      '• +1 / +2 / +3 / -1 （可加日期：+2 8/23）',
      '• list / 名單   查看名單',
    ].join('\n');
    return reply(event, { type: 'text', text: help });
  }

  return null;
}

// ====== postback（選日期；或按鈕 +1/-1/名單） ======
async function handlePostback(event) {
  const data = event.postback.data || '';
  // act=join&id=20250823&n=2
  const p = Object.fromEntries(new URLSearchParams(data).entries());

  if (p.act === 'join') {
    const id = p.id;
    const n = Math.min(parseInt(p.n || '1', 10), 10);
    return doJoin(event, id, n);
  }
  if (p.act === 'leave') {
    const id = p.id;
    const n = Math.min(parseInt(p.n || '1', 10), 10);
    return doLeave(event, id, n);
  }
  if (p.act === 'list') {
    const id = p.id;
    const e = db.events[id];
    if (!e) return reply(event, { type: 'text', text: '場次不存在' });
    return reply(event, { type: 'text', text: renderListText(e) });
  }

  // 後置路由，如 postJoin:2 / postLeave:1
  if (data.startsWith('pick=')) {
    // pick=20250823|postJoin:2
    const [id, action] = data.replace(/^pick=/, '').split('|');
    if (action.startsWith('postJoin:')) {
      const n = parseInt(action.split(':')[1], 10) || 1;
      return doJoin(event, id, n);
    }
    if (action.startsWith('postLeave:')) {
      const n = parseInt(action.split(':')[1], 10) || 1;
      return doLeave(event, id, n);
    }
    if (action === 'list') {
      const e = db.events[id];
      if (!e) return reply(event, { type: 'text', text: '場次不存在' });
      return reply(event, { type: 'text', text: renderListText(e) });
    }
  }

  return null;
}

function askPickEvent(event, mode) {
  // mode 可為 'list' 或 'postJoin:2' / 'postLeave:1'
  const evs = activeEvents();
  const items = evs.map(e => ({
    type: 'action',
    action: {
      type: 'postback',
      label: e.md,
      data: `pick=${e.id}|${mode}`,
      displayText: e.md
    }
  }));
  return reply(event, {
    type: 'text',
    text: '你想報名(取消)哪一天場次？',
    quickReply: { items }
  });
}

// ====== 報名 / 取消 ======
async function doJoin(event, id, n) {
  const e = db.events[id];
  if (!e || e.status !== 'open') {
    return reply(event, { type: 'text', text: '場次不存在或已關閉' });
  }

  // 取名稱
  const profile = await client.getProfile(event.source.userId);
  const name = profile.displayName || '匿名';

  const idx = findAttendee(e.attendees, event.source.userId);
  let old = 0;
  if (idx !== -1) old = e.attendees[idx].count;

  // 檢查名額
  const cur = totalCount(e.attendees);
  const after = cur - old + n;  // 將舊值移除再加新值
  if (after > e.max) {
    return reply(event, { type: 'text', text: '❌ 本週人數已達上限，下次早點報名 ㄎㄎ，或洽管理員' });
  }

  const nowTs = Date.now();

  if (idx === -1) {
    e.attendees.push({ userId: event.source.userId, name, count: n, ts: nowTs });
  } else {
    e.attendees[idx].count = n;
    e.attendees[idx].ts = nowTs;
  }
  saveDB();

  const order = e.attendees.findIndex(m => m.userId === event.source.userId) + 1;
  await reply(event, { type: 'text', text: `✅ ${name} 報名 ${n} 人成功 (ﾉ>ω<)ﾉ\n順位：${order}` });

  // 當下也回貼名單（含 +1 / -1）
  return reply(event, {
    type: 'text',
    text: renderListText(e),
    quickReply: {
      items: [
        { type: 'action', action: { type: 'postback', label: '+1', data: `act=join&id=${e.id}&n=1` } },
        { type: 'action', action: { type: 'postback', label: '+2', data: `act=join&id=${e.id}&n=2` } },
        { type: 'action', action: { type: 'postback', label: '-1', data: `act=leave&id=${e.id}&n=1` } },
      ]
    }
  });
}

async function doLeave(event, id, n) {
  const e = db.events[id];
  if (!e || e.status !== 'open') {
    return reply(event, { type: 'text', text: '場次不存在或已關閉' });
  }
  const idx = findAttendee(e.attendees, event.source.userId);
  const profile = await client.getProfile(event.source.userId);
  const name = profile.displayName || '匿名';

  if (idx === -1) {
    return reply(event, { type: 'text', text: '你目前沒有在名單中喔～' });
  }

  // n 這裡代表要取消幾人，需求是 -1 就把 count= count -1，若 <=0 則移除全部
  // 但你描述「-1：自己取消」比較像取消1人；因此我這裡讓他遞減
  e.attendees[idx].count = Math.max(0, e.attendees[idx].count - n);
  if (e.attendees[idx].count === 0) {
    e.attendees.splice(idx, 1);
  }
  saveDB();

  await reply(event, { type: 'text', text: `✅ ${name} 已取消 ${n} 人報名(๑•́ ₃ •̀๑)` });

  return reply(event, {
    type: 'text',
    text: renderListText(e),
    quickReply: {
      items: [
        { type: 'action', action: { type: 'postback', label: '+1', data: `act=join&id=${e.id}&n=1` } },
        { type: 'action', action: { type: 'postback', label: '-1', data: `act=leave&id=${e.id}&n=1` } },
      ]
    }
  });
}

// ====== 每天 15:00 自動貼「隔天名單」 ======
async function sendTomorrowReminders() {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const key = `${tomorrow.getFullYear()}-${pad2(tomorrow.getMonth() + 1)}-${pad2(tomorrow.getDate())}`;
  const id = dateIdFromYYYYMMDD(key);
  const e = db.events[id];
  if (!e || !e.groupId) return;

  const msgs = [{ type: 'text', text: renderListText(e) }];
  if (totalCount(e.attendees) < 6) {
    msgs.push({ type: 'text', text: '本週人數告急，請大家踴躍報名 (๑´ㅂ`๑)' });
  }
  await client.pushMessage(e.groupId, msgs);
}

// ====== 共用回覆 ======
function reply(event, message) {
  const messages = Array.isArray(message) ? message : [message];
  return client.replyMessage(event.replyToken, messages);
}

// ====== 啟動 ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server on', PORT));
