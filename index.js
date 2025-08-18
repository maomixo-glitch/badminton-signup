/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const express = require('express');
const line = require('@line/bot-sdk');

// ====== 環境變數與常數 ======
const {
  CHANNEL_ACCESS_TOKEN,
  CHANNEL_SECRET,
  PORT = 3000,
  DB_FILE = path.join(__dirname, 'data.json'),
} = process.env;

const DEFAULT_MAX = 8; // 預設正取上限（你要 8 人）

// ====== LINE SDK ======
const config = {
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET,
};
const client = new line.Client(config);

// ====== Express ======
const app = express();
app.get('/healthz', (_, res) => res.send('ok'));
app.post('/webhook', line.middleware(config), async (req, res) => {
  const results = await Promise.all(req.body.events.map(handleEvent));
  res.json(results);
});

// ====== DB 讀寫 ======
function ensureDBShape(db) {
  if (!db) db = {};
  if (!db.config) db.config = { defaultMax: DEFAULT_MAX };
  if (!db.events) db.events = {}; // id -> event
  if (!db.names) db.names = {};   // userId -> displayName
  return db;
}
function loadDB() {
  try {
    const s = fs.readFileSync(DB_FILE, 'utf-8');
    return ensureDBShape(JSON.parse(s));
  } catch {
    return ensureDBShape({});
  }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
}

// ====== 小工具 ======
const pad2 = (n) => String(n).padStart(2, '0');
const todayYMD = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const nowMinutes = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};
const toYYYYMMDDFromMD = (md) => {
  // md: 9/06 -> 當年 2025-09-06
  const [m, d] = md.split('/').map(v => parseInt(v, 10));
  const now = new Date();
  return `${now.getFullYear()}-${pad2(m)}-${pad2(d)}`;
};
const mdDisp = (ymd) => {
  const [, m, d] = ymd.split('-');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
};

// 活動是否已過期（當天時間也算）
function eventExpired(e) {
  const today = todayYMD();
  if (e.date > today) return false;
  if (e.date < today) return true;
  // 同一天，若現在時間 >= 結束時間，就過期
  const endMins = (() => {
    const t = e.timeRange || '';
    const m = t.match(/^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/);
    if (!m) return 24 * 60;
    const h2 = parseInt(m[3], 10);
    const mm2 = parseInt(m[4], 10);
    return h2 * 60 + mm2;
  })();
  return nowMinutes() >= endMins;
}

// 取顯示名稱（含快取），抓不到用 userId 後 6 碼
async function resolveDisplayName(evt) {
  const db = loadDB();
  const names = db.names;
  const userId = evt.source?.userId;
  if (!userId) return '匿名';

  if (names[userId]) return names[userId];

  try {
    let p;
    if (evt.source.type === 'user') {
      p = await client.getProfile(userId);
    } else if (evt.source.type === 'group') {
      p = await client.getGroupMemberProfile(evt.source.groupId, userId);
    } else if (evt.source.type === 'room') {
      p = await client.getRoomMemberProfile(evt.source.roomId, userId);
    }
    if (p?.displayName) {
      names[userId] = p.displayName;
      saveDB(db);
      return p.displayName;
    }
  } catch (e) {
    console.warn('get name failed:', e.message);
  }
  return userId.slice(-6);
}

const totalCount = (list) => list.reduce((a, m) => a + (m.count || 1), 0);
const findIndexById = (list, id) => list.findIndex(m => m.userId === id);

function getOpenEvents(db) {
  return Object.values(db.events)
    .filter(e => !eventExpired(e))
    .sort((a, b) => (a.date + a.timeRange).localeCompare(b.date + b.timeRange));
}

// ====== 新增/取消人數（含備取遞補） ======
function addPeople(evtObj, userId, name, n) {
  const cur = totalCount(evtObj.attendees);
  const idx = findIndexById(evtObj.attendees, userId);
  if (idx !== -1) {
    evtObj.attendees[idx].count += n;
    return { status: 'ok', where: 'main' };
  }
  if (cur + n <= evtObj.max) {
    evtObj.attendees.push({ userId, name, count: n });
    return { status: 'ok', where: 'main' };
  }
  // 進備取
  const w = findIndexById(evtObj.waitlist, userId);
  if (w !== -1) evtObj.waitlist[w].count += n;
  else evtObj.waitlist.push({ userId, name, count: n });
  return { status: 'wait', where: 'wait' };
}

function removePeople(evtObj, userId, nAbs) {
  let toRemove = Math.abs(nAbs);
  // 先在正取扣
  let idx = findIndexById(evtObj.attendees, userId);
  if (idx !== -1) {
    const m = evtObj.attendees[idx];
    if (m.count > toRemove) { m.count -= toRemove; toRemove = 0; }
    else { toRemove -= m.count; evtObj.attendees.splice(idx, 1); }
  }
  // 再到備取扣
  if (toRemove > 0) {
    let w = findIndexById(evtObj.waitlist, userId);
    if (w !== -1) {
      const m = evtObj.waitlist[w];
      if (m.count > toRemove) { m.count -= toRemove; toRemove = 0; }
      else { toRemove -= m.count; evtObj.waitlist.splice(w, 1); }
    }
  }

  // 正取有空缺 -> 從備取遞補
  let cur = totalCount(evtObj.attendees);
  while (cur < evtObj.max && evtObj.waitlist.length > 0) {
    const first = evtObj.waitlist[0];
    const canTake = Math.min(first.count, evtObj.max - cur);
    const i = findIndexById(evtObj.attendees, first.userId);
    if (i === -1) evtObj.attendees.push({ userId: first.userId, name: first.name, count: canTake });
    else evtObj.attendees[i].count += canTake;
    first.count -= canTake;
    cur += canTake;
    if (first.count <= 0) evtObj.waitlist.shift();
  }
}

function renderEventCard(e) {
  // 列正取
  const cur = totalCount(e.attendees);
  const linesMain = e.attendees.length
    ? e.attendees.map((m, i) => `${i + 1}. ${m.name} (+${m.count})`)
    : ['(目前還沒有入冊～)'];

  // 列備取
  const linesWait = e.waitlist.length
    ? e.waitlist.map((m, i) => `${i + 1}. ${m.name} (+${m.count})`)
    : [];

  let text = [
    `✨ 週末羽球`,
    `🗓 ${mdDisp(e.date)}(${weekdayLabel(e.date)})`,
    `⏰ ${e.timeRange}`,
    `📍 ${e.location}`,
    `====================`,
    `✅ 正式名單 (${cur}/${e.max}人)：`,
    ...linesMain,
  ];
  if (linesWait.length) {
    text = text.concat([
      `--------------------`,
      `🕒 備取名單：`,
      ...linesWait,
    ]);
  }

  return {
    type: 'text',
    text: text.join('\n').slice(0, 4900), // LINE 限制 5000 字
  };
}

function weekdayLabel(ymd) {
  const [y, m, d] = ymd.split('-').map(v => parseInt(v, 10));
  const w = new Date(y, m - 1, d).getDay();
  return '日一二三四五六'[w];
}

// ====== 解析 /new ======
function parseNewPayload(s) {
  // 格式：/new 9/06 18:00-20:00 大安運動中心 羽10 [max=8]
  // 或：  /new 2025-09-06 18:00-20:00 大安運動中心 羽10 [max=10]
  s = s.replace(/^\/new\s*/i, '').trim();
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;

  let dateRaw = parts[0];
  let timeRange = parts[1];
  let rest = parts.slice(2);

  // 解析 max=?
  let max = DEFAULT_MAX;
  const mX = rest[rest.length - 1]?.match(/^max=(\d{1,2})$/i);
  if (mX) {
    max = Math.max(1, parseInt(mX[1], 10));
    rest = rest.slice(0, -1);
  }
  const location = rest.join(' ');

  // 日期轉 yyyy-mm-dd
  let yyyyMMDD = '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) yyyyMMDD = dateRaw;
  else if (/^\d{1,2}\/\d{1,2}$/.test(dateRaw)) yyyyMMDD = toYYYYMMDDFromMD(dateRaw);
  else return null;

  // 時間檢核
  if (!/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(timeRange)) return null;

  return { date: yyyyMMDD, timeRange, location, max };
}

// ====== 解析 +N/-N ======
function parsePlusMinus(text) {
  // 支援：+3, -1, +3 @9/06, -1 @2025-09-06
  const m = text.trim().match(/^([+\-])\s*(\d+)(?:\s*@\s*([0-9\/\-]+))?$/);
  if (!m) return null;
  const sign = m[1] === '+' ? 1 : -1;
  let n = parseInt(m[2], 10);
  n = Math.min(Math.max(n, 1), 10);
  let dateStr = m[3] || '';

  if (dateStr) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      // ok
    } else if (/^\d{1,2}\/\d{1,2}$/.test(dateStr)) {
      dateStr = toYYYYMMDDFromMD(dateStr);
    } else {
      dateStr = '';
    }
  }
  return { sign, n, dateStr };
}

// ====== Quick Reply: 讓使用者選日期 ======
function buildChooseDateQuickReply(openEvts, tagText) {
  // tagText 例如 "+3" 或 "-1"
  return {
    type: 'text',
    text: '你想套用在哪一天？',
    quickReply: {
      items: openEvts.slice(0, 12).map(e => ({
        type: 'action',
        action: {
          type: 'message',
          label: mdDisp(e.date),
          text: `${tagText} @${mdDisp(e.date)}`
        }
      }))
    }
  };
}

// ====== 核心處理 ======
async function handleEvent(evt) {
  if (evt.type !== 'message' || evt.message.type !== 'text') return null;
  const text = (evt.message.text || '').trim();

  // /new
  if (/^\/new\b/i.test(text)) {
    const payload = parseNewPayload(text);
    if (!payload) {
      return client.replyMessage(evt.replyToken, {
        type: 'text',
        text: '格式：/new 9/06 18:00-20:00 地點 場地（可選 max=8）',
      });
    }
    // 過期檢查：如果建立時間已經過當天結束時段，視為無效
    if (eventExpired({ date: payload.date, timeRange: payload.timeRange })) {
      return client.replyMessage(evt.replyToken, { type: 'text', text: '時間已過，無法建立～' });
    }

    const db = loadDB();
    const id = 'evt_' + Date.now();
    db.events[id] = {
      id,
      ...payload,
      attendees: [],
      waitlist: [],
      createdAt: Date.now(),
    };
    saveDB(db);

    const msg = {
      type: 'text',
      text: `已建立活動：${mdDisp(payload.date)} ${payload.timeRange} ${payload.location}\n名額：${payload.max} 人`,
    };
    return client.replyMessage(evt.replyToken, [msg, renderEventCard(db.events[id])]);
  }

  // /list
  if (/^\/?list\b/i.test(text)) {
    const db = loadDB();
    const openEvts = getOpenEvents(db);
    if (!openEvts.length) {
      return client.replyMessage(evt.replyToken, { type: 'text', text: '目前沒有開放中的場次唷～' });
    }
    const msgs = openEvts.map(renderEventCard);
    return client.replyMessage(evt.replyToken, msgs.slice(0, 5));
  }

  // +N/-N
  const pm = parsePlusMinus(text);
  if (pm) {
    const { sign, n, dateStr } = pm;
    const db = loadDB();
    const openEvts = getOpenEvents(db);
    if (!openEvts.length) {
      return client.replyMessage(evt.replyToken, { type: 'text', text: '目前沒有開放中的場次唷～' });
    }
    let targetEvt = null;

    if (dateStr) {
      targetEvt = openEvts.find(e => e.date === dateStr);
      if (!targetEvt) {
        return client.replyMessage(evt.replyToken, { type:'text', text:'找不到該日期或已過期～' });
      }
    } else if (openEvts.length === 1) {
      targetEvt = openEvts[0];
    } else {
      // 讓使用者選日期
      const tagText = `${sign > 0 ? '+' : '-'}${n}`;
      return client.replyMessage(evt.replyToken, buildChooseDateQuickReply(openEvts, tagText));
    }

    // safety: 若過期（當天時間已過），不接受
    if (eventExpired(targetEvt)) {
      return client.replyMessage(evt.replyToken, { type:'text', text:'本場次已結束，無法操作～' });
    }

    const userId = evt.source.userId;
    const name = await resolveDisplayName(evt);

    if (sign > 0) {
      // 加人
      const ret = addPeople(targetEvt, userId, name, n);
      saveDB(db);
      const cur = totalCount(targetEvt.attendees);
      const msg1 = (ret.where === 'main')
        ? `✅ ${name} 報名 ${n} 人成功 (ﾉ>ω<)ﾉ\n目前：${cur}/${targetEvt.max}`
        : `🕒 ${name} 進入備取 ${n} 人（正取已滿）`;
      return client.replyMessage(evt.replyToken, [
        { type:'text', text: msg1 },
        renderEventCard(targetEvt),
      ]);
    } else {
      // 減人
      removePeople(targetEvt, userId, n);
      saveDB(db);
      const cur = totalCount(targetEvt.attendees);
      const msg1 = `✅ ${name} 已取消 ${Math.abs(n)} 人（´•̥ ω •̥`）\n目前：${cur}/${targetEvt.max}`;
      return client.replyMessage(evt.replyToken, [
        { type:'text', text: msg1 },
        renderEventCard(targetEvt),
      ]);
    }
  }

  // /help
  if (/^\/?help\b/i.test(text)) {
    return client.replyMessage(evt.replyToken, {
      type: 'text',
      text:
        '指令：\n' +
        '・/new 9/06 18:00-20:00 地點 場地（可選 max=8）\n' +
        '・/list（列出目前開放）\n' +
        '・+1 / +2 / -1（僅一場時）\n' +
        '・+3 @9/06（指定日期）',
    });
  }

  // 其他訊息忽略
  return null;
}

// ====== 啟動 ======
app.listen(PORT, () => {
  console.log('Server running on', PORT);
});
