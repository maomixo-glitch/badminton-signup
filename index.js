// index.js
// LINE badminton signup bot (Render 版)
// 功能：/new 建場、+N/-N 報名/取消、list 看名單（支援多場）
// 作者：為你整理好的穩定版

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import line from '@line/bot-sdk';

const app = express();

// ---------- LINE SDK ----------
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

// ---------- DB ----------
const DB_FILE = path.join(process.cwd(), 'data.json');
function loadDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const db = JSON.parse(raw);
    if (!db.events) db.events = {};
    if (!Array.isArray(db.roster)) db.roster = [];
    if (!db.config) db.config = {};
    return db;
  } catch (e) {
    return { config: {}, events: {}, roster: [] };
  }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
const db = loadDB();

// ---------- 小工具 ----------
const pad2 = n => `${n}`.padStart(2, '0');

function toYYYYMMDDFromMD(md) {
  // md = "8/23" -> 2025-08-23（自動補今年）
  const now = new Date();
  const [m, d] = md.split('/').map(v => parseInt(v, 10));
  const y = now.getFullYear();
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function getWeekdayStr(date) {
  // date: yyyy-mm-dd
  const d = new Date(date);
  const w = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `(${w})`;
}

// 解析 /new 指令（簡化版）
function fromNewInputToEventObj(input) {
  // 允許：
  // /new 8/23 15:00-17:00 大安運動中心 羽10
  // /new 2025-08-23 15:00-17:00 大安運動中心 羽10
  const s = input.replace(/^\/new\s*/i, '').trim();

  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;

  let dateRaw = parts[0];
  const timeRange = parts[1];

  // 剩下為地點與場地（最後一段視為場地，其餘視為地點）
  const tail = parts.slice(2);
  let court = '';
  let location = '';
  if (tail.length >= 2) {
    court = tail[tail.length - 1];
    location = tail.slice(0, -1).join(' ');
  } else {
    location = tail[0];
  }

  // 日期轉 yyyy-mm-dd
  let date = '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
    date = dateRaw;
  } else if (/^\d{1,2}\/\d{1,2}$/.test(dateRaw)) {
    date = toYYYYMMDDFromMD(dateRaw);
  } else {
    return null;
  }

  // 時間檢查
  if (!/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(timeRange)) return null;

  const fullLocation = court ? `${location}／${court}` : location;
  const title = '週末羽球';
  const max = 10; // 預設 10 人（你可改）

  return {
    date,       // yyyy-mm-dd
    timeRange,  // HH:MM-HH:MM
    location: fullLocation,
    title,
    max
  };
}

// 產生 event id：date + "_" + HHMMHHMM
function buildEventId(e) {
  const t = e.timeRange.replace(/:/g, '').replace('-', '');
  return `${e.date}_${t}`;
}

// 取得 LINE 顯示名稱
async function getDisplayName(event) {
  const userId = event.source.userId;
  if (!userId) return '神秘人';
  try {
    const prof = await client.getProfile(userId);
    return prof.displayName || '朋友';
  } catch {
    return '朋友';
  }
}

// 解析 +N 或 -N（沒帶數字預設 1）
const MAX_ADD_PER_ONCE = 10;
function parsePlusMinus(text) {
  const m = text.trim().match(/^([+\-])\s*(\d+)?$/);
  if (!m) return null;
  const sign = m[1]; // "+" or "-"
  const n = Math.max(1, Math.min(parseInt(m[2] || '1', 10), MAX_ADD_PER_ONCE));
  return { sign, n };
}

// 目前開放的場次（今天之後 & status=open）
function getOpenEvents() {
  const nowDate = new Date();
  const list = Object.values(db.events || {}).filter(e => {
    if (e.status === 'closed') return false;
    const d = new Date(e.date);
    return d >= new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
  }).sort((a, b) => (a.date + a.timeRange).localeCompare(b.date + b.timeRange));
  return list;
}

// 指定 eventId 的 roster（同一人只允許單筆）
function getRosterByEventId(eventId) {
  return db.roster.filter(r => r.event_id === eventId);
}
function findRosterRecord(eventId, userId) {
  return db.roster.find(r => r.event_id === eventId && r.userId === userId);
}
function totalCount(list) {
  return list.reduce((a, x) => a + (x.count || 1), 0);
}

// 名單呈現
function renderListText(e) {
  const lines = [];
  lines.push(`📌${e.title}`);
  lines.push(`📅 ${e.date.slice(5)}${getWeekdayStr(e.date)}`);
  lines.push(`⏰ ${e.timeRange}`);
  lines.push(`📍：${e.location}`);
  lines.push(`====================`);

  const roster = getRosterByEventId(e.event_id);
  const cur = totalCount(roster);
  lines.push(`✅ 正式名單 (${cur}/${e.max}人)：`);

  roster.forEach((m, i) => {
    const extra = m.count > 1 ? ` (+${m.count - 1})` : '';
    lines.push(`${i + 1}. ${m.name}${extra}`);
  });

  // 空位補足顯示
  for (let i = roster.length; i < Math.max(e.max, roster.length); i++) {
    if (i >= e.max) break;
    lines.push(`${i + 1}.`);
  }

  return lines.join('\n');
}

// 建立開場的「說明卡」
function renderStartCard(e) {
  const lines = [];
  lines.push(`🏸 週末羽球報名開始！`);
  lines.push(`📅 ${e.date.slice(5)}${getWeekdayStr(e.date)}`);
  lines.push(`⏰ ${e.timeRange}`);
  lines.push(`👥 名額：${e.max} 人`);
  lines.push('');
  lines.push(`📝 報名方式：`);
  lines.push(`• +1 ：只有自己 (1人)`);
  lines.push(`• +2 ：自己+朋友 (2人)`);
  lines.push(`• -1：自己取消`);
  lines.push('');
  lines.push(`輸入 "list" 查看報名狀況`);
  return lines.join('\n');
}

// ---------- 主要邏輯 ----------
async function handleNew(event, text) {
  const payload = fromNewInputToEventObj(text);
  if (!payload) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '格式錯誤唷～\n\n請用：\n/new 8/23 15:00-17:00 大安運動中心 羽10\n或\n/new 2025-08-23 15:00-17:00 大安運動中心 羽10',
    });
  }
  // 建 event
  const e = {
    event_id: buildEventId(payload),
    ...payload,
    status: 'open',
    createdAt: Date.now(),
  };

  // 重複判斷（同 id 略過）
  if (db.events[e.event_id]) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '這個場次已存在唷～請不要重複建立 🙏',
    });
  }
  db.events[e.event_id] = e;
  saveDB(db);

  // 回覆啟動卡 + 名單卡
  return client.replyMessage(event.replyToken, [
    { type: 'text', text: renderStartCard(e) },
    { type: 'text', text: renderListText(e) },
  ]);
}

// 當 +N/-N 時，如果多場就請選日期
async function askWhichEventToUse(event, events, verb) {
  const items = events.slice(0, 12).map(e => ({
    type: 'action',
    action: {
      type: 'message',
      label: e.date.slice(5), // 08-23
      text: `${verb} ${e.date}`, // 例如 +1 2025-08-23
    }
  }));
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `你想${verb === '+1' || verb.startsWith('+') ? '報名' : '取消'}哪一天場次？`,
    quickReply: { items }
  });
}

// 套用 +n/-n
async function applyPlusMinus(event, text) {
  // 支援附帶日期的寫法：+2 2025-08-23 或 +2 8/23
  // 先抓動作
  const m = text.trim().match(/^([+\-]\s*\d+)(?:\s+(.+))?$/);
  let op = null;
  let dateHint = null;
  if (m) {
    op = m[1].replace(/\s+/g, '');
    dateHint = m[2];
  } else {
    op = text.trim();
  }

  const parsed = parsePlusMinus(op);
  if (!parsed) {
    return client.replyMessage(event.replyToken, { type: 'text', text: '請用 +1 / +2 / -1 這種格式唷～' });
  }
  const { sign, n } = parsed;
  const userId = event.source.userId || 'anon';
  const name = await getDisplayName(event);

  // 找目標場次
  let target = null;
  if (dateHint) {
    // dateHint 可能是 2025-08-23 或 8/23
    let d = '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateHint)) d = dateHint;
    else if (/^\d{1,2}\/\d{1,2}$/.test(dateHint)) d = toYYYYMMDDFromMD(dateHint);

    const candidates = getOpenEvents().filter(e => e.date === d);
    if (candidates.length > 0) target = candidates[0];
  }
  if (!target) {
    const opens = getOpenEvents();
    if (opens.length === 0) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '目前沒有開放中的場次唷～' });
    } else if (opens.length === 1) {
      target = opens[0];
    } else {
      // 多場請選
      return askWhichEventToUse(event, opens, `${sign}${n}`);
    }
  }

  // 讀 roster & 目前總人數
  let roster = getRosterByEventId(target.event_id);
  let cur = totalCount(roster);

  if (sign === '+') {
    // 設定該成員的人數 = n（不是累加，方便「+3 改 +1」）
    const exist = findRosterRecord(target.event_id, userId);
    const newTotal = cur - (exist ? exist.count : 0) + n;
    if (newTotal > target.max) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '❌ 本週人數已達上限，下次早點報名 ㄎㄎ，或洽管理員',
      });
    }
    if (exist) {
      exist.count = n;
      exist.name = name;
      exist.ts = Date.now();
    } else {
      db.roster.push({
        event_id: target.event_id,
        userId, name, count: n,
        ts: Date.now(),
      });
    }
    saveDB(db);

    // 成功訊息 + 順位
    roster = getRosterByEventId(target.event_id);
    cur = totalCount(roster);
    const msg = `✅ ${name} 報名 ${n} 人成功 (ﾉ>ω<)ﾉ\n順位：${cur}`;
    return client.replyMessage(event.replyToken, [
      { type: 'text', text: msg },
      { type: 'text', text: renderListText(target) },
    ]);

  } else {
    // 減少（-1 表示把你的報名數變 0 => 刪除）
    const exist = findRosterRecord(target.event_id, userId);
    if (!exist) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '你本來就沒有報名唷～' });
    }
    const newCount = Math.max(0, exist.count - n);
    if (newCount === 0) {
      // 刪掉
      db.roster = db.roster.filter(r => !(r.event_id === target.event_id && r.userId === userId));
    } else {
      exist.count = newCount;
      exist.ts = Date.now();
    }
    saveDB(db);

    const msg = `✅ ${name} 已取消 ${Math.min(n, exist.count || n)} 人報名(๑•́ ₃ •̀๑)`;
    return client.replyMessage(event.replyToken, [
      { type: 'text', text: msg },
      { type: 'text', text: renderListText(target) },
    ]);
  }
}

async function handleList(event) {
  const opens = getOpenEvents();
  if (opens.length === 0) {
    return client.replyMessage(event.replyToken, { type: 'text', text: '目前沒有開放中的場次唷～' });
  } else if (opens.length === 1) {
    return client.replyMessage(event.replyToken, { type: 'text', text: renderListText(opens[0]) });
  } else {
    // 多場用 Quick Reply 讓他選看哪天
    const items = opens.slice(0, 12).map(e => ({
      type: 'action',
      action: { type: 'message', label: e.date.slice(5), text: `list ${e.date}` }
    }));
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '要看哪一天的名單？',
      quickReply: { items }
    });
  }
}

async function handleListWithDate(event, dateText) {
  let d = '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateText)) d = dateText;
  else if (/^\d{1,2}\/\d{1,2}$/.test(dateText)) d = toYYYYMMDDFromMD(dateText);

  const candidates = getOpenEvents().filter(e => e.date === d);
  if (candidates.length === 0) {
    return client.replyMessage(event.replyToken, { type: 'text', text: '找不到該日期的開放場次唷～' });
  }
  return client.replyMessage(event.replyToken, { type: 'text', text: renderListText(candidates[0]) });
}

// ---------- 事件進入點 ----------
app.post('/webhook', line.middleware(config), async (req, res) => {
  const results = await Promise.all(req.body.events.map(async (event) => {
    if (event.type !== 'message' || event.message.type !== 'text') return;
    const text = event.message.text.trim();

    // /new
    if (/^\/new\b/i.test(text)) return handleNew(event, text);

    // list [date]
    if (/^list\b/i.test(text) || /^名單\b/.test(text)) {
      const m = text.match(/^list\s+(.+)/i) || text.match(/^名單\s+(.+)/);
      if (m) return handleListWithDate(event, m[1].trim());
      return handleList(event);
    }

    // +N / -N（可加日期）
    if (/^[+\-]\s*\d+/.test(text)) return applyPlusMinus(event, text);

    // 單純 +1 / -1
    if (/^[+\-]\s*\d*$/.test(text)) return applyPlusMinus(event, text.replace(/\s+/, ''));

    // 其它：顯示幫助
    const help = [
      '指令：',
      '• /new YYYY-MM-DD | HH:MM-HH:MM | 地點 | 場地（也可用 8/23）',
      '• +1 / +2 / -1（多人同時開放會請你選擇日期）',
      '• list（或：list 2025-08-23 / 名單 8/23）',
    ].join('\n');
    return client.replyMessage(event.replyToken, { type: 'text', text: help });
  }));
  res.json(results);
});

// ---------- 健康檢查 ----------
app.get('/', (req, res) => res.status(200).send('OK'));
app.get('/healthz', (req, res) => res.status(200).send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));
