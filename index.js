/* eslint-disable no-console */
process.env.TZ = 'Asia/Taipei';

const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const { getAuth, appendRow, readConfig, writeConfig } = require('./gsheet');

// ====== Google Sheet auth 快取 ======
let SHEET_AUTH = null;
async function getSheetAuth() {
  if (!SHEET_AUTH) SHEET_AUTH = getAuth();
  return SHEET_AUTH;
}

// ====== 依新版欄位(A:J)寫入 signup 分頁 ======
/**
 * Append one row to "signup" sheet (A:J).
 * Columns:
 * A timestamp (ISO), B name, C user_id, D sourceType, E to,
 * F action, G detail, H event_date (YYYY-MM-DD), I event_time (HH:MM-HH:MM), J location
 */
async function logToSheetRow(row) {
  try {
    const auth = await getSheetAuth();
    await appendRow(auth, row); // 你的 gsheet.js 會 append 到 signup!A:J
  } catch (e) {
    console.warn('logToSheet failed:', e.message);
  }
}

// 方便呼叫：用物件組合 row 後寫入
async function logToSheet({
  name = '',
  userId = '',
  sourceType = '',
  to = '',
  action = '',
  detail = '',
  eventDate = '',
  eventTime = '',
  location = '',
}) {
  const row = [
    new Date().toISOString(),
    name,
    userId,
    sourceType,
    to,
    action,
    detail,
    eventDate,
    eventTime,
    location,
  ];
  await logToSheetRow(row);
}

// ====== DB in memory + Google Sheet 持久化 ======
const DEFAULT_MAX = 8;

function ensureDBShape(db) {
  if (!db) db = {};
  if (!db.config) db.config = { defaultMax: DEFAULT_MAX };
  if (!db.events) db.events = {}; // id -> event
  if (!db.names) db.names = {};   // userId -> displayName
  return db;
}

let MEM_DB = null;

async function loadDB() {
  if (MEM_DB) return MEM_DB;
  const auth = await getSheetAuth();
  const fromSheet = await readConfig(auth).catch(() => ({}));
  MEM_DB = ensureDBShape(fromSheet);
  return MEM_DB;
}

async function saveDB(db) {
  MEM_DB = ensureDBShape(db);
  const auth = await getSheetAuth();
  await writeConfig(auth, MEM_DB);
}

// ====== 小工具 ======
const SIGNUP_DEADLINE_MINUTES = 60; // 開始後 60 分鐘停止「報名 +」
const REMIND_BEFORE_MIN = 60;       // 開打前 60 分提醒

const pad2 = (n) => String(n).padStart(2, '0');
const weekdayZh = (d) => ['日','一','二','三','四','五','六'][d.getDay()];
const mdDisp = (ymd) => {
  const [, m, d] = ymd.split('-');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
};
const toYYYYMMDDFromMD = (md) => {
  const [m, d] = md.split('/').map(v => parseInt(v, 10));
  const now = new Date();
  return `${now.getFullYear()}-${pad2(m)}-${pad2(d)}`;
};
function parseTimeRange(range) {
  const m = range.match(/^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/);
  if (!m) return null;
  return {
    sh: parseInt(m[1], 10),
    sm: parseInt(m[2], 10),
    eh: parseInt(m[3], 10),
    em: parseInt(m[4], 10),
  };
}
function endDateObj(dateYMD, range) {
  const t = parseTimeRange(range);
  if (!t) return new Date(`${dateYMD}T23:59:59+08:00`);
  const d = new Date(`${dateYMD}T00:00:00+08:00`);
  d.setHours(t.eh, t.em, 0, 0);
  return d;
}
function isExpiredEvent(e) {
  return new Date() >= endDateObj(e.date, e.timeRange);
}
function isSignupClosed(e) {
  const start = new Date(`${e.date}T${e.timeRange.split('-')[0]}:00+08:00`);
  const deadline = new Date(start.getTime() + SIGNUP_DEADLINE_MINUTES * 60000);
  return new Date() >= deadline;
}
function getToFromEvent(evt) {
  return evt?.source?.groupId || evt?.source?.roomId || evt?.source?.userId;
}
function getOpenEvents(db, to) {
  return Object.values(db.events)
    .filter(e => e.to === to)        // 只顯示同一對話的
    .filter(e => !isExpiredEvent(e)) // 未過期
    .sort((a, b) => (a.date + a.timeRange).localeCompare(b.date + b.timeRange));
}
const totalCount = (list) => list.reduce((a, m) => a + (m.count || 0), 0);
const findIndexById = (list, id) => list.findIndex(m => m.userId === id);

// 取得「開始時間」Date（+08:00）
function startDateObj(e) {
  const t = parseTimeRange(e.timeRange);
  if (!t) return new Date(`${e.date}T00:00:00+08:00`);
  const hh = String(t.sh).padStart(2, '0');
  const mm = String(t.sm).padStart(2, '0');
  return new Date(`${e.date}T${hh}:${mm}:00+08:00`);
}
// 距離開始還有幾分鐘（負值代表已開始）
function minutesToStart(e) {
  return Math.round((startDateObj(e) - new Date()) / 60000);
}

// Quick Reply：+ / - 選日期
function buildChooseDateQuickReply(openEvts, tagText) {
  return {
    type: 'text',
    text: '你想套用在哪一天？',
    quickReply: {
      items: openEvts.slice(0, 12).map(e => ({
        type: 'action',
        action: { type: 'message', label: mdDisp(e.date), text: `${tagText} @${mdDisp(e.date)}` }
      }))
    }
  };
}
// Quick Reply：刪除場次選日期
function buildDeleteChooseQuickReply(openEvts) {
  return {
    type: 'text',
    text: '要刪除哪一天？',
    quickReply: {
      items: openEvts.slice(0, 12).map(e => ({
        type: 'action',
        action: { type: 'message', label: mdDisp(e.date), text: `刪除 @${mdDisp(e.date)}` }
      }))
    }
  };
}

// 卡片
function renderEventCard(e) {
  const d = new Date(`${e.date}T00:00:00+08:00`);
  const cur = totalCount(e.attendees);
  const mainLines = e.attendees.length
    ? e.attendees.map((m, i) => `${i + 1}. ${m.name} (+${m.count})`)
    : ['(目前還沒有人報名ಠ_ಠ)'];
  const waitLines = e.waitlist.length
    ? e.waitlist.map((m, i) => `${i + 1}. ${m.name} (+${m.count})`)
    : [];

  let lines = [
    '🏸 羽球報名',
    `📅 ${mdDisp(e.date)}(${weekdayZh(d)})${e.timeRange}`,
    `📍 ${e.location}`,
    '====================',
    `✅ 正式名單 (${cur}/${e.max}人)：`,
    ...mainLines,
  ];
  if (waitLines.length) {
    lines = lines.concat(['--------------------', '🕒 備取名單：', ...waitLines]);
  }
  return { type: 'text', text: lines.join('\n').slice(0, 4900) };
}

// ====== 正取/備取邏輯 ======
function addPeople(evtObj, userId, name, n) {
  let cur = totalCount(evtObj.attendees);
  const idx = findIndexById(evtObj.attendees, userId);
  if (idx !== -1) {
    const canAdd = Math.max(0, evtObj.max - cur);
    const toMain = Math.min(n, canAdd);
    if (toMain > 0) {
      evtObj.attendees[idx].count += toMain;
      n -= toMain;
      cur += toMain;
    }
    if (n > 0) {
      const w = findIndexById(evtObj.waitlist, userId);
      if (w !== -1) evtObj.waitlist[w].count += n;
      else evtObj.waitlist.push({ userId, name, count: n });
      return { status: 'wait', addedMain: toMain, addedWait: n };
    }
    return { status: 'main', addedMain: toMain, addedWait: 0 };
  }

  const canAdd = Math.max(0, evtObj.max - cur);
  const toMain = Math.min(n, canAdd);
  if (toMain > 0) {
    evtObj.attendees.push({ userId, name, count: toMain });
    n -= toMain;
    cur += toMain;
  }
  if (n > 0) {
    const w = findIndexById(evtObj.waitlist, userId);
    if (w !== -1) evtObj.waitlist[w].count += n;
    else evtObj.waitlist.push({ userId, name, count: n });
    return { status: toMain > 0 ? 'mixed' : 'wait', addedMain: toMain, addedWait: n };
  }
  return { status: 'main', addedMain: toMain, addedWait: 0 };
}
function removePeople(evtObj, userId, nAbs) {
  let toRemove = Math.abs(nAbs);

  // ① 先從「自己的備取」扣
  let w = findIndexById(evtObj.waitlist, userId);
  if (w !== -1 && toRemove > 0) {
    const m = evtObj.waitlist[w];
    if (m.count > toRemove) { m.count -= toRemove; toRemove = 0; }
    else { toRemove -= m.count; evtObj.waitlist.splice(w, 1); }
  }

  // ② 再從「自己的正取」扣
  let a = findIndexById(evtObj.attendees, userId);
  if (a !== -1 && toRemove > 0) {
    const m = evtObj.attendees[a];
    if (m.count > toRemove) { m.count -= toRemove; toRemove = 0; }
    else { toRemove -= m.count; evtObj.attendees.splice(a, 1); }
  }

  // ③ 正取若有空缺 -> 從備取 FIFO 遞補
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

// ====== LINE / Express ======
const { CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET, PORT = 10000 } = process.env;
const config = { channelAccessToken: CHANNEL_ACCESS_TOKEN, channelSecret: CHANNEL_SECRET };
const client = new line.Client(config);
const app = express();

// for UptimeRobot
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// 先回 200 再背景處理，避免冷啟 webhook 超時
app.post('/webhook', line.middleware(config), async (req, res) => {
  res.status(200).end();
  for (const e of req.body.events) {
    handleEvent(e).catch(err => console.error('handleEvent error:', err));
  }
});

// ✅ 每週六 23:56 推播
const GROUP_ID = 'C0b50f32fbcc66de32339fe91f5240d7f'; // 你的群組 ID
cron.schedule('56 23 * * 6', async () => {
  try {
    await client.pushMessage(GROUP_ID, {
      type: 'text',
      text:
        '⏰ 記得搶羽球場地！NOW！\n' +
        '大安👉https://reurl.cc/GNNZRp\n' +
        '信義👉https://reurl.cc/ZNNadg'
    });
    console.log('weekly reminder sent');
  } catch (err) {
    console.warn('weekly reminder failed:', err.message);
  }
});

// 啟動 server
app.listen(3000, () => {
  console.log("Server running on port 3000");
});

// 處理事件
function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return Promise.resolve(null);
  }
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: event.message.text
  });
}

// ====== 顯示名稱（快取到 DB.names） ======
async function resolveDisplayName(evt) {
  const db = await loadDB();
  const cache = db.names;
  const userId = evt.source?.userId;
  if (!userId) return '匿名';
  if (cache[userId]) return cache[userId];

  try {
    let profile;
    if (evt.source.type === 'user') {
      profile = await client.getProfile(userId);
    } else if (evt.source.type === 'group') {
      profile = await client.getGroupMemberProfile(evt.source.groupId, userId);
    } else if (evt.source.type === 'room') {
      profile = await client.getRoomMemberProfile(evt.source.roomId, userId);
    }
    if (profile?.displayName) {
      cache[userId] = profile.displayName;
      await saveDB(db);
      return profile.displayName;
    }
  } catch (e) {
    console.warn('get display name failed:', e.message);
  }
  return userId.slice(-6);
}

// ====== /new 解析 ======
function parseNewPayload(text) {
  // /new 9/06 18:00-20:00 大安運動中心 羽10 [max=8]
  // /new 2025-09-06 18:00-20:00 大安運動中心 羽10
  const s = text.replace(/^\/new\s*/i, '').trim();
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;

  const dateRaw = parts[0];
  const timeRange = parts[1];

  let tail = parts.slice(2);
  let max = DEFAULT_MAX;

  // 末尾可能有 max=8
  const mMax = tail[tail.length - 1]?.match(/^max=(\d{1,2})$/i);
  if (mMax) {
    max = Math.max(1, parseInt(mMax[1], 10));
    tail = tail.slice(0, -1);
  }

  let location = '';
  let court = '';
  if (tail.length >= 2) {
    court = tail[tail.length - 1];
    location = tail.slice(0, -1).join(' ');
  } else {
    location = tail[0] || '';
  }

  let ymd = '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) ymd = dateRaw;
  else if (/^\d{1,2}\/\d{1,2}$/.test(dateRaw)) ymd = toYYYYMMDDFromMD(dateRaw);
  else return null;

  if (!parseTimeRange(timeRange)) return null;

  return { date: ymd, timeRange, location: court ? `${location}｜${court}` : location, max };
}

// ====== +N / -N 解析 ======
function parsePlusMinus(text) {
  // +3、-1、+2 @9/06、-1 @2025-09-06
  const m = text.trim().match(/^([+\-])\s*(\d+)(?:\s*@\s*([0-9\/\-]+))?$/);
  if (!m) return null;
  const sign = m[1] === '+' ? 1 : -1;
  let n = Math.max(1, Math.min(parseInt(m[2], 10) || 1, 10));
  let dateStr = m[3] || '';
  if (dateStr) {
    if (/^\d{1,2}\/\d{1,2}$/.test(dateStr)) dateStr = toYYYYMMDDFromMD(dateStr);
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) dateStr = '';
  }
  return { sign, n, dateStr };
}

// ====== 指令處理 ======
async function handleEvent(evt) {
  if (evt.type !== 'message' || evt.message.type !== 'text') return;
  const text = (evt.message.text || '').trim();

  const to = getToFromEvent(evt);
  const sourceType = evt.source?.type || 'user';

  // ---------- 建立新場次 ----------
  if (/^\/new\b/i.test(text)) {
    const p = parseNewPayload(text);
    if (!p) {
      return client.replyMessage(evt.replyToken, {
        type: 'text',
        text: '格式：/new 9/06 18:00-20:00 大安運動中心 羽10（可選 max=8）',
      });
    }
    if (isExpiredEvent({ date: p.date, timeRange: p.timeRange })) {
      return client.replyMessage(evt.replyToken, { type: 'text', text: '時間已過，無法建立~' });
    }

    const db = await loadDB();
    const id = 'evt_' + Date.now();
    db.events[id] = {
      id,
      date: p.date,
      timeRange: p.timeRange,
      location: p.location,
      max: p.max || DEFAULT_MAX,
      attendees: [],
      waitlist: [],
      createdAt: Date.now(),
      to,
      reminded: false,
    };
    await saveDB(db);

    // 背景 log
    (async () => {
      const who = await resolveDisplayName(evt);
      await logToSheet({
        name: who,
        userId: evt.source.userId || '',
        sourceType,
        to,
        action: 'create_event',
        detail: `建立場次 max=${p.max || DEFAULT_MAX}`,
        eventDate: p.date,
        eventTime: p.timeRange,
        location: p.location,
      });
    })();

    const d = new Date(`${p.date}T00:00:00+08:00`);
    const msg = [
      '✨ 羽球報名開始！',
      `📅 ${mdDisp(p.date)}(${weekdayZh(d)})${p.timeRange}`,
      `📍 ${p.location}`,
      '',
      '📝 報名方式：',
      '• +1：自己 (1人)',
      '• +2：自己+朋友 (2人)',
      '• -1：自己取消',
      '',
      '輸入「list」查看報名狀況',
      '輸入「delete」可刪除場次',
    ].join('\n');

    return client.replyMessage(evt.replyToken, [
      { type: 'text', text: msg },
      renderEventCard(db.events[id]),
    ]);
  }

  // ---------- 列出場次 ----------
  if (/^\/?list\b/i.test(text)) {
    const db = await loadDB();
    const openEvts = getOpenEvents(db, to);
    if (!openEvts.length) {
      return client.replyMessage(evt.replyToken, { type: 'text', text: '目前沒有開放中的場次唷~' });
    }
    const msgs = openEvts.slice(0, 5).map(renderEventCard);
    return client.replyMessage(evt.replyToken, msgs);
  }

  // ---------- 刪除場次（刪除場次 / delete） ----------
  if (/^(?:\/?刪除場次|delete)\b/i.test(text)) {
    const db = await loadDB();
    const openEvts = getOpenEvents(db, to);

    if (!openEvts.length) {
      return client.replyMessage(evt.replyToken, { type: 'text', text: '目前沒有開放中的場次可刪除~' });
    }

    // 單場 -> 直接刪
    if (openEvts.length === 1) {
      const e = openEvts[0];
      delete db.events[e.id];
      await saveDB(db);

      await logToSheet({
        name: await resolveDisplayName(evt),
        userId: evt.source.userId || '',
        sourceType,
        to,
        action: 'delete_event',
        detail: '單場直接刪除',
        eventDate: e.date,
        eventTime: e.timeRange,
        location: e.location,
      });

      return client.replyMessage(evt.replyToken, {
        type: 'text',
        text: `已刪除：${mdDisp(e.date)} ${e.timeRange}｜${e.location}`
      });
    }

    // 多場 -> 跳選單
    return client.replyMessage(evt.replyToken, buildDeleteChooseQuickReply(openEvts));
  }

  // ---------- 刪除 @日期 ----------
  const delMatch = text.match(/^刪除\s*@\s*([0-9\/\-]+)$/i);
  if (delMatch) {
    let dateStr = delMatch[1];
    if (/^\d{1,2}\/\d{1,2}$/.test(dateStr)) dateStr = toYYYYMMDDFromMD(dateStr);

    const db = await loadDB();
    const openEvts = getOpenEvents(db, to);
    const target = openEvts.find(e => e.date === dateStr);

    if (!target) {
      return client.replyMessage(evt.replyToken, { type: 'text', text: '找不到該日期的開放場次~' });
    }

    delete db.events[target.id];
    await saveDB(db);

    await logToSheet({
      name: await resolveDisplayName(evt),
      userId: evt.source.userId || '',
      sourceType,
      to,
      action: 'delete_event',
      detail: '選單刪除',
      eventDate: target.date,
      eventTime: target.timeRange,
      location: target.location,
    });

    return client.replyMessage(evt.replyToken, {
      type: 'text',
      text: `已刪除：${mdDisp(target.date)} ${target.timeRange}｜${target.location}`
    });
  }

  // ---------- +N / -N ----------
  const pm = parsePlusMinus(text);
  if (pm) {
    const { sign, n, dateStr } = pm;

    const db = await loadDB();
    const openEvts = getOpenEvents(db, to);
    if (!openEvts.length) {
      return client.replyMessage(evt.replyToken, { type: 'text', text: '目前沒有開放中的場次唷~' });
    }

    let targetEvt = null;
    if (dateStr) {
      targetEvt = openEvts.find(e => e.date === dateStr);
      if (!targetEvt) {
        return client.replyMessage(evt.replyToken, { type: 'text', text: '找不到該日期或已過期~' });
      }
    } else if (openEvts.length === 1) {
      targetEvt = openEvts[0];
    } else {
      const tag = `${sign > 0 ? '+' : '-'}${n}`;
      return client.replyMessage(evt.replyToken, buildChooseDateQuickReply(openEvts, tag));
    }

    // 已完全結束 -> 一律不允許
    if (isExpiredEvent(targetEvt)) {
      return client.replyMessage(evt.replyToken, { type: 'text', text: '本場次已結束，無法操作~' });
    }

    // 開打後 60 分鐘停止「報名 +」，但「取消 -」到結束前仍可
    if (sign > 0 && isSignupClosed(targetEvt)) {
      return client.replyMessage(evt.replyToken, { type: 'text', text: '報名時間已過，下次早點報名ᕕ(ᐛ)ᕗ' });
    }

    const userId = evt.source.userId || 'anon';
    const name = await resolveDisplayName(evt);

    if (sign > 0) {
      const ret = addPeople(targetEvt, userId, name, n);
      await saveDB(db);

      const cur = totalCount(targetEvt.attendees);

      await logToSheet({
        name,
        userId,
        sourceType,
        to,
        action: 'signup',
        detail: `+${n}（status=${ret.status}; main=${ret.addedMain}; wait=${ret.addedWait}; cur=${cur}/${targetEvt.max}）`,
        eventDate: targetEvt.date,
        eventTime: targetEvt.timeRange,
        location: targetEvt.location,
      });

      let msg1 = '';
      if (ret.status === 'main') {
        msg1 = `✅ ${name} 羽球報名 ${ret.addedMain} 人成功 (ﾉ>ω<)ﾉ\n目前：${cur}/${targetEvt.max}`;
      } else if (ret.status === 'wait') {
        msg1 = `🕒 ${name} 進入備取 ${ret.addedWait} 人（正取已滿）`;
      } else {
        msg1 = `✅ ${name} 正取 ${ret.addedMain} 人；🕒 備取 ${ret.addedWait} 人\n目前：${cur}/${targetEvt.max}`;
      }

     return client.replyMessage(evt.replyToken, { type: 'text', text: msg1 });
    } else {
      // 減人（取消）
      removePeople(targetEvt, userId, n);
      await saveDB(db);

      const cur = totalCount(targetEvt.attendees);

      await logToSheet({
        name,
        userId,
        sourceType,
        to,
        action: 'cancel',
        detail: `-${Math.abs(n)}（cur=${cur}/${targetEvt.max}）`,
        eventDate: targetEvt.date,
        eventTime: targetEvt.timeRange,
        location: targetEvt.location,
      });

      const msg1 = `✅ ${name} 羽球取消 ${Math.abs(n)} 人 (╬ﾟдﾟ)\n目前：${cur}/${targetEvt.max}`;
      return client.replyMessage(evt.replyToken, { type: 'text', text: msg1 });
    }
  }

  return;
}

// ====== 自動提醒（每 60 秒掃一次） ======
async function reminderTick() {
  try {
    const db = await loadDB();
    const events = Object.values(db.events || []);
    if (!events.length) return;

    for (const e of events) {
      if (!e || e.reminded) continue; // 已提醒過
      if (!e.to) continue;            // 舊資料可能沒有 to
      if (isExpiredEvent(e)) continue;

      const mins = minutesToStart(e);

      // REMIND_BEFORE_MIN ~ 1 分鐘之間推一次
      if (mins <= REMIND_BEFORE_MIN && mins > 0) {
        let minsText = `${mins} 分鐘`;
        if (mins === 60) minsText = '1小時';

        const title = `⏰ 提醒：${mdDisp(e.date)} ${e.timeRange}（${e.location}）${minsText}後開始！`;
        const messages = [{ type: 'text', text: title }, renderEventCard(e)];

        await client.pushMessage(e.to, messages).catch(err => {
          console.warn('push reminder failed:', err.message);
        });

        e.reminded = true;
        e.remindedAt = Date.now();
        await saveDB(db);

        await logToSheet({
          name: '(system)',
          userId: '',
          sourceType: 'system',
          to: e.to,
          action: 'remind',
          detail: mins === 60 ? '1小時前' : `${mins}分鐘前`,
          eventDate: e.date,
          eventTime: e.timeRange,
          location: e.location,
        });
      }
    }
  } catch (err) {
    console.warn('reminderTick error:', err.message);
  }
}
setInterval(reminderTick, 60 * 1000);

// ====== 啟動 ======
app.listen(PORT, () => console.log('Server on', PORT));
