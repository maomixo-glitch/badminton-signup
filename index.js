/* eslint-disable no-console */
process.env.TZ = 'Asia/Taipei';

const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const { getAuth, appendRow, readConfig, writeConfig } = require('./gsheet');

// ===================== 基本設定 =====================
const { CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET, PORT = 10000 } = process.env;
const config = { channelAccessToken: CHANNEL_ACCESS_TOKEN, channelSecret: CHANNEL_SECRET };
const client = new line.Client(config);
const app = express();

// ===================== ADMIN 設定（⬅ 新增這一段） =====================
const ADMINS = (process.env.ADMINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function isAdmin(userId) {
  return ADMINS.includes(userId);
}

// 你的群組 ID（沿用你原本那個）
const GROUP_ID = 'C0b50f32fbcc66de32339fe91f5240d7f';

// ===================== Google Sheet auth 快取 =====================
let SHEET_AUTH = null;
async function getSheetAuth() {
  if (!SHEET_AUTH) SHEET_AUTH = getAuth();
  return SHEET_AUTH;
}

// ===================== Sheet log (signup!A:J) =====================
async function logToSheetRow(row) {
  try {
    const auth = await getSheetAuth();
    await appendRow(auth, row);
  } catch (e) {
    console.warn('logToSheet failed:', e.message);
  }
}

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

// ===================== DB in memory + Google Sheet 持久化 =====================
const HARD_CAP_MAX = 8;    // ✅ NEW：全系統硬上限（正取最多 8）
const DEFAULT_MAX = 8;
const WAITLIST_MAX_DEFAULT = 6;

const NORMAL_TYPE = 'N';
const SEASON_TYPE = 'R';

const SEASON_RANGE_START = '2026-01-01';
const SEASON_RANGE_END = '2026-03-31';

// ✅ 新增這一行（最後一場實際打球日）
const SEASON_LAST_GAME_DATE = '2026-03-28';

const SEASON_LOCATION = '大安運動中心｜羽3';
const SEASON_TIME_RANGE = '12:00-14:00';

function ensureDBShape(db) {
  if (!db) db = {};
  if (!db.config) db.config = { defaultMax: DEFAULT_MAX };
  if (!db.events) db.events = {};
  if (!db.names) db.names = {};
  if (!db.coreMembers) db.coreMembers = {};

  // ✅ 這段：矯正舊資料（避免 max=10 的歷史遺毒）
  for (const e of Object.values(db.events)) {
  if (!e) continue;
  if (!Number.isFinite(e.max)) e.max = DEFAULT_MAX;

  // ✅ 不管季租/單場，一律最多 8（硬上限）
  e.max = Math.max(1, Math.min(e.max, HARD_CAP_MAX));

  if (!Number.isFinite(e.waitMax)) e.waitMax = WAITLIST_MAX_DEFAULT;
  if (!e.attendees) e.attendees = [];
  if (!e.waitlist) e.waitlist = [];
}

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

function isCore(db, userId) {
  return !!(db.coreMembers && db.coreMembers[userId]);
}

// ===================== 小工具 =====================
const SIGNUP_DEADLINE_MINUTES = 60; // 開打後 60 分鐘停止「報名 +」
const REMIND_BEFORE_MIN = 60;       // 開打前 60 分提醒

const pad2 = (n) => String(n).padStart(2, '0');
const weekdayZh = (d) => ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
const mdDisp = (ymd) => {
  const [, m, d] = ymd.split('-');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
};

// 取得固定班底 userId list（只包含有設定過 固定班底+ 的人）
function getCoreIds(db) {
  if (!db?.coreMembers) return [];
  if (Array.isArray(db.coreMembers)) return db.coreMembers; // 如果你哪天改成 array 也兼容
  return Object.keys(db.coreMembers).filter(uid => db.coreMembers[uid]);
}

function nameFromCache(db, userId) {
  return db?.names?.[userId] || userId.slice(-6);
}

// ✅ 建立季租場時：把「固定班底」自動 +1（人數不補齊、有幾個加幾個）
function seedCoreMembersToSeasonEvent(db, evtObj) {
  const coreIds = getCoreIds(db);

  const waitMax = Number.isFinite(evtObj.waitMax) ? evtObj.waitMax : WAITLIST_MAX_DEFAULT;

  evtObj.attendees = [];
  evtObj.waitlist = [];

  for (const uid of coreIds) {
    const name = nameFromCache(db, uid);

    // 先塞正取到 max（例如 8）
    if (totalCount(evtObj.attendees) < evtObj.max) {
      evtObj.attendees.push({ userId: uid, name, count: 1, isCore: true });
      continue;
    }

    // 超過 max 的進備取（最多 waitMax）
    if (totalCount(evtObj.waitlist) < waitMax) {
      evtObj.waitlist.push({ userId: uid, name, count: 1, isCore: true });
    }
  }
}

// ⭐ 重要：支援跨年（9/06 這種）
// - 先用今年年份組日期
// - 若該日期 < 今天 (00:00) → 自動視為明年
const toYYYYMMDDFromMD = (md) => {
  const [m, d] = md.split('/').map(v => parseInt(v, 10));
  const now = new Date();
  let year = now.getFullYear();

  const todayYMD = new Date(year, now.getMonth(), now.getDate());
  const candidate = new Date(year, m - 1, d);

  if (candidate < todayYMD) year += 1;
  return `${year}-${pad2(m)}-${pad2(d)}`;
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

function startDateObj(e) {
  const t = parseTimeRange(e.timeRange);
  if (!t) return new Date(`${e.date}T00:00:00+08:00`);
  const hh = String(t.sh).padStart(2, '0');
  const mm = String(t.sm).padStart(2, '0');
  return new Date(`${e.date}T${hh}:${mm}:00+08:00`);
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
  const start = startDateObj(e);
  const deadline = new Date(start.getTime() + SIGNUP_DEADLINE_MINUTES * 60000);
  return new Date() >= deadline;
}

function getToFromEvent(evt) {
  return evt?.source?.groupId || evt?.source?.roomId || evt?.source?.userId;
}

function getOpenEvents(db, to) {
  return Object.values(db.events)
    .filter(e => e.to === to)
    .filter(e => !isExpiredEvent(e))
    .sort((a, b) => (a.date + a.timeRange).localeCompare(b.date + b.timeRange));
}

const totalCount = (list) => list.reduce((a, m) => a + (m.count || 0), 0);
const findIndexById = (list, id) => list.findIndex(m => m.userId === id);

// 距離開始還有幾分鐘（負值代表已開始）
function minutesToStart(e) {
  return Math.round((startDateObj(e) - new Date()) / 60000);
}

// ⭐ 季租場固定班底優先截止：週三 12:00
// 做法：週六 12:00 往前推 3 天 = 週三 12:00
function seasonCoreDeadline(e) {
  if (e.type !== SEASON_TYPE) return null;
  const d = new Date(`${e.date}T12:00:00+08:00`);
  d.setDate(d.getDate() - 3);
  return d;
}

function withinSeasonRange(ymd) {
  return ymd >= SEASON_RANGE_START && ymd <= SEASON_RANGE_END;
}

// ===================== Quick Reply =====================
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

// ===================== 卡片 =====================
function renderEventCard(e) {
  const d = new Date(`${e.date}T00:00:00+08:00`);
  const cur = totalCount(e.attendees);

  // ⭐ 顯示用的正取上限
 const displayMax = HARD_CAP_MAX;   // ✅ NEW：永遠顯示 /8
  
  const mainLines = e.attendees.length
    ? e.attendees.map((m, i) => {
        const star = m.isCore ? '*' : '';
        return `${i + 1}. ${star}${m.name} (+${m.count})`;
      })
    : ['(目前還沒有人報名ಠ_ಠ)'];

  const waitLines = e.waitlist.length
    ? e.waitlist.map((m, i) => {
        const star = m.isCore ? '*' : '';
        return `${i + 1}. ${star}${m.name} (+${m.count})`;
      })
    : [];

  const title =
    e.type === SEASON_TYPE
      ? '🏸【季租場】羽球報名'
      : '🏸 羽球報名';

  let lines = [
    title,
    `📅 ${mdDisp(e.date)}(${weekdayZh(d)})${e.timeRange}`,
    `📍 ${e.location}`,
    '====================',
    `✅ 正式名單 (${cur}/${displayMax}人)：`,
    ...mainLines,
  ];

  // ⭐ 備取顯示規則
if (waitLines.length) {
  lines = lines.concat([
    '',
    '🕒 備取名單：',
    ...waitLines,
  ]);
}

if (e.type === SEASON_TYPE) {
  lines = lines.concat([
    '',
    '*固定班底當週不能來再自行 -1',
  ]);
}
  
  return { type: 'text', text: lines.join('\n').slice(0, 4900) };
}

// ===================== 正取/備取邏輯（含備取上限） =====================
function addPeople(evtObj, userId, name, n) {
  let cur = totalCount(evtObj.attendees);
  const waitMax = Number.isFinite(evtObj.waitMax) ? evtObj.waitMax : WAITLIST_MAX_DEFAULT;
  let waitCur = totalCount(evtObj.waitlist);

  let addedMain = 0;
  let addedWait = 0;
  let rejected = 0;

  // helper: try add to waitlist with cap
  function addToWait(count) {
    if (count <= 0) return 0;
    const canWait = Math.max(0, waitMax - waitCur);
    const toWait = Math.min(count, canWait);
    if (toWait <= 0) return 0;

    const w = findIndexById(evtObj.waitlist, userId);
    if (w !== -1) evtObj.waitlist[w].count += toWait;
    else evtObj.waitlist.push({ userId, name, count: toWait });

    waitCur += toWait;
    return toWait;
  }

  // 1) 先補正取（若已在名單則加count，否則新增）
  const idx = findIndexById(evtObj.attendees, userId);
  if (idx !== -1) {
    const canAdd = Math.max(0, evtObj.max - cur);
    const toMain = Math.min(n, canAdd);
    if (toMain > 0) {
      evtObj.attendees[idx].count += toMain;
      n -= toMain;
      cur += toMain;
      addedMain += toMain;
    }
    // 剩下進備取（但要吃備取上限）
    if (n > 0) {
      const toWait = addToWait(n);
      addedWait += toWait;
      rejected += (n - toWait);
      return {
        status: (addedMain > 0 && addedWait > 0) ? 'mixed' : (addedWait > 0 ? 'wait' : 'reject'),
        addedMain,
        addedWait,
        rejected
      };
    }
    return { status: 'main', addedMain, addedWait: 0, rejected: 0 };
  }

  // 還沒在正取名單
  const canAdd = Math.max(0, evtObj.max - cur);
  const toMain = Math.min(n, canAdd);
  if (toMain > 0) {
    evtObj.attendees.push({ userId, name, count: toMain });
    n -= toMain;
    cur += toMain;
    addedMain += toMain;
  }

  // 剩下進備取
  if (n > 0) {
    const toWait = addToWait(n);
    addedWait += toWait;
    rejected += (n - toWait);
    return {
      status: (addedMain > 0 && addedWait > 0) ? 'mixed' : (addedWait > 0 ? 'wait' : 'reject'),
      addedMain,
      addedWait,
      rejected
    };
  }

  return { status: 'main', addedMain, addedWait: 0, rejected: 0 };
}

function removePeople(evtObj, userId, nAbs) {
  let toRemove = Math.abs(nAbs);

  // ① 先從自己的備取扣
  let w = findIndexById(evtObj.waitlist, userId);
  if (w !== -1 && toRemove > 0) {
    const m = evtObj.waitlist[w];
    if (m.count > toRemove) { m.count -= toRemove; toRemove = 0; }
    else { toRemove -= m.count; evtObj.waitlist.splice(w, 1); }
  }

  // ② 再從自己的正取扣
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

// ===================== 顯示名稱快取 =====================
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

// ===================== /new 解析（支援 /newN /newR） =====================
function parseNewPayload(text) {
  // /newR 2026-01-10 12:00-14:00 大安運動中心 羽3 max=8
  const mType = text.match(/^\/new([NR])\s*/i);
  const type = mType && mType[1] ? mType[1].toUpperCase() : NORMAL_TYPE;

  const s = text.replace(/^\/new[NR]?\s*/i, '').trim();
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;

  const dateRaw = parts[0];
  const timeRange = parts[1];

  let tail = parts.slice(2);
  let max = DEFAULT_MAX;

  // 末尾可能有 max=8
  const mMax = tail[tail.length - 1]?.match(/^max=(\d{1,2})$/i);
if (mMax) {
  const parsed = parseInt(mMax[1], 10);
  max = Math.max(1, Math.min(parsed, HARD_CAP_MAX));  // ✅ 最多 8
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

  return {
    type,
    date: ymd,
    timeRange,
    location: court ? `${location}｜${court}` : location,
    max,
  };
}

// ===================== +N / -N 解析 =====================
function parsePlusMinus(text) {
  // +3、-1、+2 @9/06、-1 @2026-01-10
  const m = text.trim().match(/^([+\-])\s*(\d+)(?:\s*@\s*([0-9\/\-]+))?$/);
  if (!m) return null;
  const sign = m[1] === '+' ? 1 : -1;
  let n = Math.max(1, Math.min(parseInt(m[2], 10) || 1, 8));
  let dateStr = m[3] || '';
  if (dateStr) {
    if (/^\d{1,2}\/\d{1,2}$/.test(dateStr)) dateStr = toYYYYMMDDFromMD(dateStr);
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) dateStr = '';
  }
  return { sign, n, dateStr };
}

// ===================== 季租：找本週六日期 =====================
function getNextSaturdayYMD() {
  const now = new Date();
  const day = now.getDay(); // 0 Sun ... 6 Sat
  const diffToThisSat = (6 - day + 7) % 7;

  const sat = new Date(now);
  sat.setDate(now.getDate() + diffToThisSat + 7); // ✅ 直接加 7 天 = 下週六

  const y = sat.getFullYear();
  const m = pad2(sat.getMonth() + 1);
  const d = pad2(sat.getDate());
  return `${y}-${m}-${d}`;
}

function findEventByDateAndType(db, to, ymd, type) {
  return Object.values(db.events).find(e => e.to === to && e.date === ymd && e.type === type && !isExpiredEvent(e));
}

async function ensureSeasonEventForThisWeek(db, to) {
  const ymd = getUpcomingSaturdayYMD();
  if (ymd > SEASON_LAST_GAME_DATE) return null;

  const existing = findEventByDateAndType(db, to, ymd, SEASON_TYPE);
  if (existing) return existing;

  const id = 'evt_' + Date.now();
  db.events[id] = {
    id,
    date: ymd,
    timeRange: SEASON_TIME_RANGE,
    location: SEASON_LOCATION,
    max: 8,
    waitMax: 6,
    attendees: [],
    waitlist: [],
    createdAt: Date.now(),
    to,
    reminded: false,
    type: SEASON_TYPE,
  };
  
    // ✅ 關鍵就在這一行：自動把「已設定固定班底+」的人塞進來
  seedCoreMembersToSeasonEvent(db, db.events[id]);
  
  await saveDB(db);
  return db.events[id];
}

// ===================== LINE Webhook =====================
app.get('/healthz', (req, res) => res.status(200).send('OK'));

app.post('/webhook', line.middleware(config), async (req, res) => {
  res.status(200).end();
  for (const e of req.body.events) {
    handleEvent(e).catch(err => console.error('handleEvent error:', err));
  }
});

// ===================== 週六搶場提醒（保留你原本的） =====================
const ENABLE_COURT_REMINDER = process.env.ENABLE_COURT_REMINDER === 'true';

if (ENABLE_COURT_REMINDER) {
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
}

// ===================== 季租：週六 15:00 建立下週季租場 =====================
cron.schedule('0 15 * * 6', async () => {
  try {
    const db = await loadDB();

    const ymd = getNextSaturdayYMD();
    console.log('[cron] sat 15:00 fired, next ymd =', ymd);

    if (ymd > SEASON_LAST_GAME_DATE) return;

    const exist = findEventByDateAndType(db, GROUP_ID, ymd, SEASON_TYPE);
    if (exist) {
      console.log('[cron] already exists, skip', ymd);
      return;
    }

    const id = 'evt_' + Date.now();
    db.events[id] = {
      id,
      date: ymd,
      timeRange: SEASON_TIME_RANGE,
      location: SEASON_LOCATION,
      max: 8,       // ✅ 你季租正取要 8，就別用 10
      waitMax: 6,
      attendees: [],
      waitlist: [],
      createdAt: Date.now(),
      to: GROUP_ID,
      reminded: false,
      type: SEASON_TYPE,
    };

seedCoreMembersToSeasonEvent(db, db.events[id]);
await saveDB(db);

console.log('[cron] created season event', ymd);

// ✅ 建立成功就通知（保留這行）
await client.pushMessage(GROUP_ID, renderEventCard(db.events[id]));

  } catch (err) {
    console.warn('saturday auto create failed:', err.message);
  }
});

// ===================== 季租：週三 12:00 開放零打（未滿 8 才通知） =====================
cron.schedule('0 12 * * 3', async () => {
  try {
    const db = await loadDB();
    const evt = findEventByDateAndType(
      db,
      GROUP_ID,
      getUpcomingSaturdayYMD(),
      SEASON_TYPE
    );
    if (!evt) return;

    // ⭐ 正取人數
    const cur = totalCount(evt.attendees);

    // ✅ 已滿 8 人就安靜，不推播
    if (cur >= 8) return;

    // ✅ 未滿 8 才通知
    const msg = [
      '【季租場】📣 本週六還有空位！',
      `📅 ${mdDisp(evt.date)}(六) ${evt.timeRange}`,
      `📍 ${evt.location}`,
    ].join('\n');

    await client.pushMessage(GROUP_ID, [
      { type: 'text', text: msg },
      renderEventCard(evt),
    ]);
  } catch (err) {
    console.warn('wednesday open guest failed:', err.message);
  }
});

// ===================== 指令處理 =====================
async function handleEvent(evt) {
  if (evt.type !== 'message' || evt.message.type !== 'text') return;
  const text = (evt.message.text || '').trim();
  const to = getToFromEvent(evt);
  const sourceType = evt.source?.type || 'user';

  const db = await loadDB();
  const userId = evt.source.userId || 'anon';
  const name = await resolveDisplayName(evt);

// ====== Admin: 名簿/改名 ======

// 找 userId 後6碼對應的 userId（在已知資料裡找）
function findUserIdBySuffix(db, suffix6) {
  const s = (suffix6 || '').replace(/^@/, '').trim();
  if (!s) return null;

  // 來源1：db.names（曾經互動過的人）
  const fromNames = Object.keys(db.names || {}).find(uid => uid.slice(-6) === s);
  if (fromNames) return fromNames;

  // 來源2：coreMembers（固定班底）
  const fromCore = Object.keys(db.coreMembers || {}).find(uid => uid.slice(-6) === s);
  if (fromCore) return fromCore;

  return null;
}

// ---------- 查詢我的名字（全員可用）----------
if (text === '我的名字') {
  const current = db.names?.[userId] || '(尚未設定，會用 LINE 顯示名或後6碼)';
  return client.replyMessage(evt.replyToken, {
    type: 'text',
    text: `你目前在機器人卡片的名字：${current}`
  });
}

// ---------- 名簿（管理員）----------
if (text === '名簿') {
  if (!isAdmin(userId)) {
    return client.replyMessage(evt.replyToken, { type: 'text', text: '名簿只有管理員可以看～' });
  }

  // 收集「機器人目前認得的人」：names + coreMembers
  const set = new Set([
    ...Object.keys(db.names || {}),
    ...Object.keys(db.coreMembers || {})
  ]);
  const ids = Array.from(set);

  if (!ids.length) {
    return client.replyMessage(evt.replyToken, { type: 'text', text: '目前名簿是空的（還沒記住任何人）。' });
  }

  // 只列前 30 個避免洗版
  const lines = ids.slice(0, 30).map((uid, idx) => {
    const nm = db.names?.[uid] || uid.slice(-6);
    const star = db.coreMembers?.[uid] ? '*' : '';
    return `${idx + 1}. ${star}${nm}  (@${uid.slice(-6)})`;
  });

  let msg = '📒 名簿（* 固定班底）：\n' + lines.join('\n');
  if (ids.length > 30) msg += `\n…其餘 ${ids.length - 30} 位先不列（避免訊息爆炸）`;

  return client.replyMessage(evt.replyToken, { type: 'text', text: msg });
}

// ---------- 改名（管理員：改自己 or 改他人）----------
// 支援：改名 小智
// 支援：改名 @a1b2c3 小明
const mRename = text.match(/^改名\s+(.+)$/);
if (mRename) {
  if (!isAdmin(userId)) {
    return client.replyMessage(evt.replyToken, { type: 'text', text: '改名只有管理員可以用喔～' });
  }

  const payload = (mRename[1] || '').trim();
  if (!payload) {
    return client.replyMessage(evt.replyToken, { type: 'text', text: '格式：改名 小智\n或：改名 @後6碼 小明' });
  }

  // 解析：若第一段是 @xxxxxx 就當作改別人
  const parts = payload.split(/\s+/);
  let targetUserId = userId; // 預設改自己
  let newName = payload;

  const first = parts[0];
  if (/^@\w{6}$/.test(first) && parts.length >= 2) {
    const found = findUserIdBySuffix(db, first);
    if (!found) {
      return client.replyMessage(evt.replyToken, {
        type: 'text',
        text: `找不到 @${first.replace('@','')} 這個人。\n先打「名簿」查後6碼，或請對方至少跟機器人互動一次（例如打 list / +1），我才抓得到。`
      });
    }
    targetUserId = found;
    newName = parts.slice(1).join(' ').trim();
  }

  if (!newName) {
    return client.replyMessage(evt.replyToken, { type: 'text', text: '名字不能空白啦～' });
  }
  if (newName.length > 20) {
    return client.replyMessage(evt.replyToken, { type: 'text', text: '名字太長了（建議 20 字內）。' });
  }

  db.names = db.names || {};
  db.names[targetUserId] = newName;
  await saveDB(db);

  const whoSuffix = targetUserId.slice(-6);
  const coreTag = db.coreMembers?.[targetUserId] ? '（固定班底）' : '';

  return client.replyMessage(evt.replyToken, {
    type: 'text',
    text: `✅ 已更新卡片名字：${newName} (@${whoSuffix})${coreTag}`
  });
}

  // ---------- 固定班底：加入 ----------
if (/^(固定班底\+\s*\d*|我是固定班底)$/i.test(text)) {

  // 已經是固定班底
  if (db.coreMembers[userId]) {
    return client.replyMessage(evt.replyToken, {
      type: 'text',
      text: `😼 ${name}，你本來就是固定班底了啦`
    });
  }

  // 還不是 → 加入
  db.coreMembers[userId] = true;
  await saveDB(db);

  return client.replyMessage(evt.replyToken, {
    type: 'text',
    text: `✅ 已將「${name}」設為固定班底`
  });
}

  // ---------- 固定班底：移除 ----------
  if (/^(固定班底\-|取消固定班底)$/i.test(text)) {
    if (db.coreMembers[userId]) {
      delete db.coreMembers[userId];
      await saveDB(db);
      return client.replyMessage(evt.replyToken, { type: 'text', text: `✅ 已將「${name}」從固定班底移除` });
    }
    return client.replyMessage(evt.replyToken, { type: 'text', text: '你本來就不是固定班底啦～' });
  }

  // ---------- 固定班底名單 ----------
  if (/^(固定班底名單|\/core_list)$/i.test(text)) {
    const ids = Object.keys(db.coreMembers || {});
    if (!ids.length) return client.replyMessage(evt.replyToken, { type: 'text', text: '目前還沒有設定固定班底唷～' });

    const lines = ids.map((id, idx) => {
      const n = db.names[id] || id.slice(-6);
      return `${idx + 1}. *${n}`;
    });

    return client.replyMessage(evt.replyToken, { type: 'text', text: '固定班底名單：\n' + lines.join('\n') });
  }

// ---------- 建立新場次 ----------
const mNew = text.match(/^\/new([NR])?\b/i);
if (mNew) {
  const mode = (mNew[1] || 'N').toUpperCase();

  // ✅ 直接用原文字解析（parseNewPayload 已支援 /newN /newR）
  const p = parseNewPayload(text);
  if (!p) {
    return client.replyMessage(evt.replyToken, {
      type: 'text',
      text:
        '格式：\n' +
        '/newN 2026-01-10 18:00-20:00 大安運動中心 羽3 max=8\n' +
        '/newR 2026-01-10 12:00-14:00 大安運動中心 羽3 max=8\n' +
        '也可用：/newR 1/10 12:00-14:00 大安運動中心 羽3',
    });
  }

  if (isExpiredEvent({ date: p.date, timeRange: p.timeRange })) {
    return client.replyMessage(evt.replyToken, { type: 'text', text: '時間已過，無法建立~' });
  }

  const id = 'evt_' + Date.now();
  db.events[id] = {
    id,
    type: p.type || NORMAL_TYPE,
    date: p.date,
    timeRange: p.timeRange,
    location: p.location,
    max: p.max || DEFAULT_MAX,
    waitMax: WAITLIST_MAX_DEFAULT,
    attendees: [],
    waitlist: [],
    createdAt: Date.now(),
    to,
    reminded: false,
  };

  // ✅ 只在季租場（/newR）建立時：自動把固定班底塞入 (+1)
  if (mode === 'R') {
    seedCoreMembersToSeasonEvent(db, db.events[id]);
  }

  await saveDB(db);

  // 背景 log
  (async () => {
    await logToSheet({
      name,
      userId,
      sourceType,
      to,
      action: 'create_event',
      detail: `建立場次 type=${db.events[id].type} max=${db.events[id].max}`,
      eventDate: p.date,
      eventTime: p.timeRange,
      location: p.location,
    });
  })();

  const d = new Date(`${p.date}T00:00:00+08:00`);
  const typeText = (db.events[id].type === SEASON_TYPE) ? '【季租場】' : '【一般場】';

  const msg = [
    `✨ ${typeText}羽球報名建立成功！`,
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
    '（* 代表固定班底）',
  ].join('\n');

  return client.replyMessage(evt.replyToken, 
  renderEventCard(db.events[id], db.coreMembers)
);
}

  // ---------- 列出場次 ----------
  if (/^\/?list\b/i.test(text)) {
    const openEvts = getOpenEvents(db, to);
    if (!openEvts.length) return client.replyMessage(evt.replyToken, { type: 'text', text: '目前沒有開放中的場次唷~' });

    const msgs = openEvts.slice(0, 5).map(e => renderEventCard(e, db.coreMembers));
    return client.replyMessage(evt.replyToken, msgs);
  }

  // ---------- 刪除場次（刪除場次 / delete） ----------
  if (/^(?:\/?刪除場次|delete)\b/i.test(text)) {
    const openEvts = getOpenEvents(db, to);
    if (!openEvts.length) {
      return client.replyMessage(evt.replyToken, { type: 'text', text: '目前沒有開放中的場次可刪除~' });
    }

    if (openEvts.length === 1) {
      const e = openEvts[0];
      delete db.events[e.id];
      await saveDB(db);

      await logToSheet({
        name,
        userId,
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

    return client.replyMessage(evt.replyToken, buildDeleteChooseQuickReply(openEvts));
  }

  // ---------- 刪除 @日期 ----------
  const delMatch = text.match(/^刪除\s*@\s*([0-9\/\-]+)$/i);
  if (delMatch) {
    let dateStr = delMatch[1];
    if (/^\d{1,2}\/\d{1,2}$/.test(dateStr)) dateStr = toYYYYMMDDFromMD(dateStr);

    const openEvts = getOpenEvents(db, to);
    const target = openEvts.find(e => e.date === dateStr);

    if (!target) return client.replyMessage(evt.replyToken, { type: 'text', text: '找不到該日期的開放場次~' });

    delete db.events[target.id];
    await saveDB(db);

    await logToSheet({
      name,
      userId,
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

    const openEvts = getOpenEvents(db, to);
    if (!openEvts.length) return client.replyMessage(evt.replyToken, { type: 'text', text: '目前沒有開放中的場次唷~' });

    let targetEvt = null;
    if (dateStr) {
      targetEvt = openEvts.find(e => e.date === dateStr);
      if (!targetEvt) return client.replyMessage(evt.replyToken, { type: 'text', text: '找不到該日期或已過期~' });
    } else if (openEvts.length === 1) {
      targetEvt = openEvts[0];
    } else {
      const tag = `${sign > 0 ? '+' : '-'}${n}`;
      return client.replyMessage(evt.replyToken, buildChooseDateQuickReply(openEvts, tag));
    }

    // 完全結束 -> 不允許
    if (isExpiredEvent(targetEvt)) {
      return client.replyMessage(evt.replyToken, { type: 'text', text: '本場次已結束，無法操作~' });
    }

    // 開打後 60 分鐘停止「報名 +」
    if (sign > 0 && isSignupClosed(targetEvt)) {
      return client.replyMessage(evt.replyToken, { type: 'text', text: '報名時間已過，下次早點報名ᕕ(ᐛ)ᕗ' });
    }

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
        detail: `+${n}（status=${ret.status}; main=${ret.addedMain}; wait=${ret.addedWait}; rejected=${ret.rejected}; cur=${cur}/${targetEvt.max}）`,
        eventDate: targetEvt.date,
        eventTime: targetEvt.timeRange,
        location: targetEvt.location,
      });

      if (ret.status === 'reject') {
        return client.replyMessage(evt.replyToken, {
          type: 'text',
          text: `🧱 ${name} 這場正取滿了、備取也滿了（備取上限 ${targetEvt.waitMax ?? WAITLIST_MAX_DEFAULT} 人）`
        });
      }

      let msg1 = '';
      if (ret.status === 'main') {
        msg1 = `✅ ${name} 報名 ${ret.addedMain} 人成功\n目前：${cur}/${targetEvt.max}`;
      } else if (ret.status === 'wait') {
        msg1 = `🕒 ${name} 進入備取 ${ret.addedWait} 人（正取已滿）`;
      } else {
        msg1 = `✅ ${name} 正取 ${ret.addedMain} 人；🕒 備取 ${ret.addedWait} 人\n目前：${cur}/${targetEvt.max}`;
      }

      if (ret.rejected > 0) {
        msg1 += `\n⚠️ 另外有 ${ret.rejected} 人因備取已滿未加入。`;
      }

      return client.replyMessage(evt.replyToken, { type: 'text', text: msg1 });
    } else {
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

      return client.replyMessage(evt.replyToken, {
        type: 'text',
        text: `✅ ${name} 取消 ${Math.abs(n)} 人\n目前：${cur}/${targetEvt.max}`
      });
    }
  }

  return;
}

// ===================== 自動提醒（每 60 秒掃一次） =====================
async function reminderTick() {
  try {
    const db = await loadDB();
    const events = Object.values(db.events || {});
    if (!events.length) return;

    for (const e of events) {
      if (!e || e.reminded) continue;
      if (!e.to) continue;
      if (isExpiredEvent(e)) continue;

      const mins = minutesToStart(e);
      if (mins <= REMIND_BEFORE_MIN && mins > 0) {
        const minsText = (mins === 60) ? '1小時' : `${mins} 分鐘`;
        const title = `⏰ 提醒：${mdDisp(e.date)} ${e.timeRange}（${e.location}）${minsText}後開始！`;
        const messages = [{ type: 'text', text: title }, renderEventCard(e, db.coreMembers)];

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

// ===================== 啟動 server =====================
app.listen(PORT, () => console.log('Server on', PORT));
