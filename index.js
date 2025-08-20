/* eslint-disable no-console */
process.env.TZ = 'Asia/Taipei';

const express = require('express');
const line = require('@line/bot-sdk');
const {
  getAuth, appendRow, readConfig, writeConfig,
} = require('./gsheet');

// ====== Google Sheet auth 快取 ======
let SHEET_AUTH = null;
async function getSheetAuth() {
  if (!SHEET_AUTH) SHEET_AUTH = getAuth();
  return SHEET_AUTH;
}

// ====== 寫入 signup 分頁（非同步 fire-and-forget） ======
async function logToSheet(values) {
  try {
    const auth = await getSheetAuth();
    await appendRow(auth, values);
  } catch (e) {
    console.warn('logToSheet failed:', e.message);
  }
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

let MEM_DB = null; // 記憶體快取

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
function getOpenEvents(db) {
  return Object.values(db.events)
    .filter(e => !isExpiredEvent(e))
    .sort((a, b) => (a.date + a.timeRange).localeCompare(b.date + b.timeRange));
}
const totalCount = (list) => list.reduce((a, m) => a + (m.count || 0), 0);
const findIndexById = (list, id) => list.findIndex(m => m.userId === id);

// 取得某場次的「開始時間」Date 物件（+08:00）
function startDateObj(e) {
  const t = parseTimeRange(e.timeRange);
  if (!t) return new Date(`${e.date}T00:00:00+08:00`);
  const hh = String(t.sh).padStart(2, '0');
  const mm = String(t.sm).padStart(2, '0');
  return new Date(`${e.date}T${hh}:${mm}:00+08:00`);
}

// 距離開始還有幾分鐘（過了會是負值）
function minutesToStart(e) {
  return Math.round((startDateObj(e) - new Date()) / 60000);
}

// Quick Reply：選日期（+ / - 時用）
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
        action: {
          type: 'message',
          label: mdDisp(e.date),
          text: `刪除 @${mdDisp(e.date)}`
        }
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
    : ['(目前還沒有人報名～)'];
  const waitLines = e.waitlist.length
    ? e.waitlist.map((m, i) => `${i + 1}. ${m.name} (+${m.count})`)
    : [];
  let lines = [
    '✨ 羽球報名',
    `🗓 ${mdDisp(e.date)}(${weekdayZh(d)})`,
    `⏰ ${e.timeRange}`,
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
  let idx = findIndexById(evtObj.attendees, userId);
  if (idx !== -1) {
    const m = evtObj.attendees[idx];
    if (m.count > toRemove) { m.count -= toRemove; toRemove = 0; }
    else { toRemove -= m.count; evtObj.attendees.splice(idx, 1); }
  }
  if (toRemove > 0) {
    let w = findIndexById(evtObj.waitlist, userId);
    if (w !== -1) {
      const m = evtObj.waitlist[w];
      if (m.count > toRemove) { m.count -= toRemove; toRemove = 0; }
      else { toRemove -= m.count; evtObj.waitlist.splice(w, 1); }
    }
  }
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
  // 支援：
  // /new 9/06 18:00-20:00 大安運動中心 羽10 [max=8]
  // /new 2025-09-06 18:00-20:00 大安運動中心 羽10
  const s = text.replace(/^\/new\s*/i, '').trim();
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;

  const dateRaw = parts[0];
  const timeRange = parts[1];

  let tail = parts.slice(2);
  let max = DEFAULT_MAX;

  // 尾段可能有 max=8
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
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
    ymd = dateRaw;
  } else if (/^\d{1,2}\/\d{1,2}$/.test(dateRaw)) {
    ymd = toYYYYMMDDFromMD(dateRaw);
  } else {
    return null;
  }

  if (!parseTimeRange(timeRange)) return null;

  // 如果場地尾碼有數字（如「羽10」），用它覆蓋人數上限
  const cNum = court.match(/(\d+)/);
  if (cNum) max = Math.max(1, parseInt(cNum[1], 10));

  return { date: ymd, timeRange, location: court ? `${location}／${court}` : location, max };
}

// ====== +N / -N 解析 ======
function parsePlusMinus(text) {
  // 支援：+3、-1、+2 @9/06、-1 @2025-09-06
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
      return client.replyMessage(evt.replyToken, { type: 'text', text: '時間已過，無法建立～' });
    }

    const db = await loadDB();
    const id = 'evt_' + Date.now();
    const to = evt.source.groupId || evt.source.roomId || evt.source.userId;
    db.events[id] = {
  id,
  date: p.date,
  timeRange: p.timeRange,
  location: p.location,
  max: p.max || DEFAULT_MAX,
  attendees: [],
  waitlist: [],
  createdAt: Date.now(),

  // 新增這兩個
  to,              // 之後 pushMessage 會用這個對話 ID 來推提醒
  reminded: false, // 還沒提醒過
  // remindedAt: undefined
};
    await saveDB(db);

    // 背景寫 log
    (async () => {
      const who = await resolveDisplayName(evt);
      logToSheet([
        new Date().toISOString(), who, evt.source.userId || '',
        'new', `${p.date} ${p.timeRange} ${p.location} max=${p.max || DEFAULT_MAX}`
      ]);
    })();

    const d = new Date(`${p.date}T00:00:00+08:00`);
    const msg = [
      '📌 羽球報名開始！',
      `📅 ${mdDisp(p.date)}(${weekdayZh(d)})`,
      `⏰ ${p.timeRange}`,
      `📍 ${p.location}`,
      `👥 名額：${p.max || DEFAULT_MAX} 人`,
      '',
      '📝 報名方式：',
      '• +1：自己 (1人)',
      '• +2：自己+朋友 (2人)',
      '• -1：自己取消',
      '',
      '輸入「list」查看報名狀況',
      '輸入「delet」刪除場次',
    ].join('\n');

    return client.replyMessage(evt.replyToken, [
      { type: 'text', text: msg },
      renderEventCard(db.events[id]),
    ]);
  }

  // ---------- 列出場次 ----------
  if (/^\/?list\b/i.test(text)) {
    const db = await loadDB();
    const openEvts = getOpenEvents(db);
    if (!openEvts.length) {
      return client.replyMessage(evt.replyToken, { type: 'text', text: '目前沒有開放中的場次唷～' });
    }
    const msgs = openEvts.slice(0, 5).map(renderEventCard);
    return client.replyMessage(evt.replyToken, msgs);
  }

  // ---------- 刪除場次（關鍵字：刪除場次 / delet） ----------
  if (/^(?:\/?刪除場次|delet)\b/i.test(text)) {
    const db = await loadDB();
    const openEvts = getOpenEvents(db);

    if (!openEvts.length) {
      return client.replyMessage(evt.replyToken, {
        type: 'text',
        text: '目前沒有開放中的場次可刪除～'
      });
    }

    // 只有一場 -> 直接刪
    if (openEvts.length === 1) {
      const e = openEvts[0];
      delete db.events[e.id];
      await saveDB(db);

      logToSheet([
        new Date().toISOString(),
        await resolveDisplayName(evt),
        evt.source.userId || '',
        'delete',
        `${e.date} ${e.timeRange} ${e.location}`
      ]).catch(() => {});

      return client.replyMessage(evt.replyToken, {
        type: 'text',
        text: `已刪除：${mdDisp(e.date)} ${e.timeRange}／${e.location}`
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
    const openEvts = getOpenEvents(db);
    const target = openEvts.find(e => e.date === dateStr);

    if (!target) {
      return client.replyMessage(evt.replyToken, {
        type: 'text',
        text: '找不到該日期的開放場次～'
      });
    }

    delete db.events[target.id];
    await saveDB(db);

    logToSheet([
      new Date().toISOString(),
      await resolveDisplayName(evt),
      evt.source.userId || '',
      'delete',
      `${target.date} ${target.timeRange} ${target.location}`
    ]).catch(() => {});

    return client.replyMessage(evt.replyToken, {
      type: 'text',
      text: `已刪除：${mdDisp(target.date)} ${target.timeRange}／${target.location}`
    });
  }

  // ---------- +N / -N ----------
  const pm = parsePlusMinus(text);
  if (pm) {
    const { sign, n, dateStr } = pm;

    const db = await loadDB();
    const openEvts = getOpenEvents(db);
    if (!openEvts.length) {
      return client.replyMessage(evt.replyToken, { type: 'text', text: '目前沒有開放中的場次唷～' });
    }

    let targetEvt = null;
    if (dateStr) {
      targetEvt = openEvts.find(e => e.date === dateStr);
      if (!targetEvt) {
        return client.replyMessage(evt.replyToken, { type: 'text', text: '找不到該日期或已過期～' });
      }
    } else if (openEvts.length === 1) {
      targetEvt = openEvts[0];
    } else {
      const tag = `${sign > 0 ? '+' : '-'}${n}`;
      return client.replyMessage(evt.replyToken, buildChooseDateQuickReply(openEvts, tag));
    }

    // 已完全結束 -> 一律不允許
    if (isExpiredEvent(targetEvt)) {
      return client.replyMessage(evt.replyToken, { type: 'text', text: '本場次已結束，無法操作～' });
    }

    // 開打後 60 分鐘停止「報名 +」，但「取消 -」到結束前仍可
    if (sign > 0 && isSignupClosed(targetEvt)) {
      return client.replyMessage(evt.replyToken, { type: 'text', text: '報名時間已過，下次早點報名唷～' });
    }

    const userId = evt.source.userId || 'anon';
    const name = await resolveDisplayName(evt);

    if (sign > 0) {
      const ret = addPeople(targetEvt, userId, name, n);
      await saveDB(db);

      const cur = totalCount(targetEvt.attendees);

      // 背景寫入：報名
      logToSheet([
        new Date().toISOString(),
        name,
        userId,
        'add',
        `+${n}@${targetEvt.date}`,
        `status=${ret.status}; main=${ret.addedMain}; wait=${ret.addedWait}; cur=${cur}/${targetEvt.max}`
      ]).catch(() => {});

      let msg1 = '';
      if (ret.status === 'main') {
        msg1 = `✅ ${name} 報名 ${ret.addedMain} 人成功 (ﾉ>ω<)ﾉ\n目前：${cur}/${targetEvt.max}`;
      } else if (ret.status === 'wait') {
        msg1 = `🕒 ${name} 進入備取 ${ret.addedWait} 人（正取已滿）`;
      } else {
        msg1 = `✅ ${name} 正取 ${ret.addedMain} 人；🕒 備取 ${ret.addedWait} 人\n目前：${cur}/${targetEvt.max}`;
      }

      return client.replyMessage(evt.replyToken, [
        { type: 'text', text: msg1 },
        renderEventCard(targetEvt),
      ]);
    } else {
      // 減人（取消）
      removePeople(targetEvt, userId, n);
      await saveDB(db);

      const cur = totalCount(targetEvt.attendees);

      // 背景寫入：取消
      logToSheet([
        new Date().toISOString(),
        name,
        userId,
        'remove',
        `-${Math.abs(n)}@${targetEvt.date}`,
        `cur=${cur}/${targetEvt.max}`
      ]).catch(() => {});

      const msg1 = `✅ ${name} 已取消 ${Math.abs(n)} 人 (T_T)\n目前：${cur}/${targetEvt.max}`;
      return client.replyMessage(evt.replyToken, [
        { type: 'text', text: msg1 },
        renderEventCard(targetEvt),
      ]);
    }
  }

  return;
}

const REMIND_BEFORE_MIN = 60; // 開打前幾分鐘提醒（你要 60 分）

async function reminderTick() {
  try {
    const db = await loadDB();
    const events = Object.values(db.events || []);
    if (!events.length) return;

    for (const e of events) {
      if (!e || e.reminded) continue;      // 已提醒過就跳過
      if (!e.to) continue;                  // 舊資料可能沒有 to
      if (isExpiredEvent(e)) continue;      // 已過結束時間

      const mins = minutesToStart(e);

      // 開打前 REMIND_BEFORE_MIN ~ 1 分鐘之間，推一次提醒
      if (mins <= REMIND_BEFORE_MIN && mins > 0) {
        let minsText = `${mins} 分鐘`;
      if (mins === 60) minsText = '1小時';

      const title = `⏰ 提醒：${mdDisp(e.date)} ${e.timeRange}（${e.location}）再 ${minsText}後開始！`;

        const messages = [
          { type: 'text', text: title },
          renderEventCard(e), // 附目前名單
        ];

        await client.pushMessage(e.to, messages).catch(err => {
          console.warn('push reminder failed:', err.message);
        });

        // 標記已提醒
        e.reminded = true;
        e.remindedAt = Date.now();
        await saveDB(db);

        // 寫一筆 log（非阻塞）
        logToSheet([
  new Date().toISOString(),
  '(system)',
  e.to,
  'remind',
  `${e.date} ${e.timeRange} ${e.location} - ${mins === 60 ? '1小時前' : mins + '分鐘前'}`
]).catch(() => {});
      }
    }
  } catch (err) {
    console.warn('reminderTick error:', err.message);
  }
}

// 每 60 秒掃一次（你已用 UptimeRobot 叫醒 Render，就會持續運作）
setInterval(reminderTick, 60 * 1000);

// ====== 啟動 ======
app.listen(PORT, () => console.log('Server on', PORT));
