// index.js — badminton signup bot (Render/LINE)
//
// 必填 ENV:
//   CHANNEL_ACCESS_TOKEN, CHANNEL_SECRET
// 可選 ENV:
//   ADMINS = Uxxx,Uyyy (管理員 userId, 逗號分隔)
//
// 依賴：express, @line/bot-sdk

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// ====== 設定 ======
const CONFIG = {
  DEFAULT_MAX: 10,
  MAX_ADD_PER_ONCE: 10,
  DATA_FILE: path.join(__dirname, 'data.json'),
  TZ_OFFSET: '+08:00',
};

// ====== LINE SDK ======
const lineConfig = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(lineConfig);

// ====== Express ======
const app = express();
app.use(express.json());

// ====== 簡單健康檢查 ======
app.use(express.json());

app.get('/healthz', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server on', PORT));

// ====== DB 存取 ======
async function loadDB() {
  try {
    const txt = await fsp.readFile(CONFIG.DATA_FILE, 'utf8');
    const db = JSON.parse(txt || '{}');
    db.config = db.config || {};
    db.events = db.events || {};
    db.roster = db.roster || [];
    return db;
  } catch (e) {
    return { config: {}, events: {}, roster: [] };
  }
}
async function saveDB(db) {
  await fsp.writeFile(CONFIG.DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// ====== 工具 ======
function pad2(n) { return String(n).padStart(2, '0'); }
function toYYYYMMDDFromMD(md) {
  // md: 8/23 -> 2025-08-23 (以現在年)
  const now = new Date();
  const [m, d] = md.split('/').map(v => parseInt(v, 10));
  const y = now.getFullYear();
  return `${y}-${pad2(m)}-${pad2(d)}`;
}
function isExpired(e) {
  // e.date 'YYYY-MM-DD', e.timeRange 'HH:MM-HH:MM'
  if (!e || !e.date || !e.timeRange) return true;
  const m = e.timeRange.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!m) return true;
  const [, sH, sM, eH, eM] = m;
  const end = new Date(`${e.date}T${sH}:${sM}:00${CONFIG.TZ_OFFSET}`);
  // end 改用結束時間
  end.setHours(parseInt(eH, 10), parseInt(eM, 10), 0, 0);
  return Date.now() > end.getTime();
}
function cleanupExpired(db) {
  for (const [id, ev] of Object.entries(db.events || {})) {
    if (isExpired(ev)) delete db.events[id];
  }
}
function getOpenEvents(db) {
  return Object.values(db.events || {}).filter(e => !isExpired(e));
}
function total(att) {
  return (att || []).reduce((a, x) => a + (x.count || 0), 0);
}
function mdLabel(e) {
  // 'YYYY-MM-DD' -> '8/30'
  const d = new Date(e.date + 'T00:00:00' + CONFIG.TZ_OFFSET);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function isAdmin(userId) {
  const admins = (process.env.ADMINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return admins.length ? admins.includes(userId) : true; // 若未設定 ADMINS => everyone is admin
}
function getNameFromEvent(event) {
  // 取得 LINE 顯示名稱用
  const name = (event.source?.userId === undefined) ? '使用者' : (event.source?.userId || '使用者');
  return name;
}

// ====== 場次資料操作 ======
function upsertAttendee(e, userId, name, delta) {
  if (!Array.isArray(e.attendees)) e.attendees = [];
  const i = e.attendees.findIndex(a => a.userId === userId);
  if (i === -1) {
    if (delta > 0) e.attendees.push({ userId, name, count: delta });
  } else {
    e.attendees[i].count = Math.max(0, (e.attendees[i].count || 0) + delta);
    if (e.attendees[i].count === 0) e.attendees.splice(i, 1);
  }
}
function remain(e) {
  return (e.max || CONFIG.DEFAULT_MAX) - total(e.attendees);
}

// ====== 清單文字 ======
function renderListText(e) {
  const lines = [];
  lines.push('📌 週末羽球報名');
  lines.push(`📅 ${mdLabel(e)}`);
  lines.push(`⏰ ${e.timeRange}`);
  lines.push(`📍 ${e.location}${e.court ? '／' + e.court : ''}`);
  lines.push('====================');

  const cur = total(e.attendees);
  lines.push(`✅ 正式名單 (${cur}/${e.max}人)：`);
  const arr = (e.attendees || []).slice();
  // 只列有報名的人
  arr
    .filter(m => m.count > 0)
    .forEach((m, i) => {
      const extra = m.count > 1 ? ` (+${m.count})` : '';
      lines.push(`${i + 1}. ${m.name}${extra}`);
    });
  return lines.join('\n');
}

// ====== 開場訊息（建立新場次後） ======
function renderOpenText(e) {
  const lines = [];
  lines.push('🏸 週末羽球報名開始！');
  lines.push(`📅 ${mdLabel(e)}`);
  lines.push(`⏰ ${e.timeRange}`);
  lines.push(`👥 名額：${e.max} 人`);
  lines.push('');
  lines.push('📝 報名方式：');
  lines.push('• +1 ：只有自己 (1人)');
  lines.push('• +2 ：自己+朋友 (2人)');
  lines.push('• -1：自己取消');
  lines.push('');
  lines.push('輸入 "list" 查看報名狀況');
  return { type: 'text', text: lines.join('\n') };
}

// ====== 快速選擇場次（兩場同時開放時） ======
function buildChooseEventQuickReply(openEvents, delta) {
  return {
    type: 'text',
    text: '你想報名(取消)哪一天場次？',
    quickReply: {
      items: openEvents.map(ev => ({
        type: 'action',
        action: {
          type: 'postback',
          label: mdLabel(ev),
          displayText: mdLabel(ev), // ✅ 顯示日期
          data: `action=apply&evt=${ev.id}&delta=${delta}` // 後端使用
        }
      }))
    }
  };
}

// ====== 解析 /new (簡化格式) ======
function fromNewInputToEventObj(input) {
  // 支援：
  // 1) /new 8/23 15:00-17:00 大安運動中心 羽10
  // 2) /new 2025-08-23 15:00-17:00 大安運動中心 羽10
  const s = input.replace(/^\/new\s*/i, '').trim();
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;

  let dateRaw = parts[0];
  let timeRange = parts[1];

  // 剩下為地點與場地
  let tail = parts.slice(2);
  let court = '';
  let location = '';

  if (tail.length >= 2) {
    court = tail[tail.length - 1];          // 最後一段視為場地
    location = tail.slice(0, -1).join(' '); // 其餘合為地點
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

  // 時間格式檢查
  if (!/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(timeRange)) return null;

  // 場地可能像 "羽10" -> max 取數字
  let max = CONFIG.DEFAULT_MAX;
  const m = court.match(/\d+/);
  if (m) max = parseInt(m[0], 10) || CONFIG.DEFAULT_MAX;

  return {
    date: yyyyMMDD,
    timeRange,
    location,
    court,
    max,
    attendees: [],
    id: 'evt_' + Math.random().toString(36).slice(2, 10)
  };
}

// ====== 報名/取消 handler ======
async function applyDeltaToEvent(db, eventId, userId, name, delta) {
  const e = db.events[eventId];
  if (!e) return { type: 'text', text: '查無此場次。' };
  if (isExpired(e)) return { type: 'text', text: '此場次已結束。' };

  const current = total(e.attendees);
  if (delta > 0 && current + delta > e.max) {
    return { type: 'text', text: '❌ 本週人數已達上限，下次早點報名(*´▽`*)' };
  }
  upsertAttendee(e, userId, name, delta);
  const nowTotal = total(e.attendees);
  const sign = delta > 0 ? '報名' : '已取消';
  const countAbs = Math.abs(delta);

  await saveDB(db);

  return {
    type: 'text',
    text: `✅ ${name} ${sign} ${countAbs} 人成功！\n目前：${nowTotal}/${e.max}`
  };
}

// ====== Webhook ======
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type === 'message' && event.message?.type === 'text') {
    const text = (event.message.text || '').trim();
    const userId = event.source?.userId || '';
    const displayName = await getDisplayNameSafe(userId) || '朋友';
    const db = await loadDB();
    cleanupExpired(db);

    // /new 只有管理員可以建
    if (/^\/new/i.test(text)) {
      if (!isAdmin(userId)) {
        return client.replyMessage(event.replyToken, { type: 'text', text: '只有管理員可以建立場次喔～' });
      }
      const obj = fromNewInputToEventObj(text);
      if (!obj) {
        return client.replyMessage(event.replyToken, { type: 'text', text: '格式錯誤～ 範例：/new 8/23 15:00-17:00 大安運動中心 羽10' });
      }
      // 同日期重複避免
      const exists = Object.values(db.events).some(e => e.date === obj.date);
      if (exists) {
        return client.replyMessage(event.replyToken, { type: 'text', text: '這一天的場次已存在囉～' });
      }
      db.events[obj.id] = obj;
      await saveDB(db);

      return client.replyMessage(event.replyToken, [
        renderOpenText(obj),
        { type: 'text', text: renderListText(obj) }
      ]);
    }

    // list：看開放場次 或 指定日期 list 8/30
    if (/^list(\s+.+)?$/i.test(text)) {
      const m = text.match(/^list\s+(.+)$/i);
      const open = getOpenEvents(db);
      if (open.length === 0) {
        return client.replyMessage(event.replyToken, { type: 'text', text: '目前沒有開放中的場次唷～' });
      }
      if (m && m[1]) {
        // 指定日期
        const query = m[1].trim();
        const target = open.find(e => mdLabel(e) === query || e.date === query);
        if (!target) {
          return client.replyMessage(event.replyToken, { type: 'text', text: '找不到該日期的場次。' });
        }
        return client.replyMessage(event.replyToken, { type: 'text', text: renderListText(target) });
      } else {
        // 若只有一場，直接顯示
        if (open.length === 1) {
          return client.replyMessage(event.replyToken, { type: 'text', text: renderListText(open[0]) });
        }
        // 多場：列日期
        const labels = open.map(e => mdLabel(e)).join(' / ');
        return client.replyMessage(event.replyToken, { type: 'text', text: `目前開放：${labels}\n可輸入：list 8/30` });
      }
    }

    // +N / -N
    const pm = parsePlusMinus(text);
    if (pm) {
      const delta = pm.sign * pm.n;
      const open = getOpenEvents(db);
      if (open.length === 0) {
        return client.replyMessage(event.replyToken, { type: 'text', text: '目前沒有開放中的場次唷～' });
      }
      if (open.length === 1) {
        const e = open[0];
        const resp = await applyDeltaToEvent(db, e.id, userId, displayName, delta);
        // 成功後回覆當前清單
        if (resp.type === 'text' && resp.text.startsWith('✅')) {
          return client.replyMessage(event.replyToken, [
            resp,
            { type: 'text', text: renderListText(db.events[e.id]) }
          ]);
        }
        return client.replyMessage(event.replyToken, resp);
      }
      // 多場：讓使用者選
      return client.replyMessage(event.replyToken, buildChooseEventQuickReply(open, delta));
    }

    // 其他回覆
    return client.replyMessage(event.replyToken, { type: 'text', text: '指令：\n/new 8/23 15:00-17:00 大安運動中心 羽10\n+1 / +2 / -1\nlist / list 8/30' });
  }

  // postback: action=apply&evt=xxx&delta=+1
  if (event.type === 'postback') {
    const data = event.postback?.data || '';
    const params = Object.fromEntries(new URLSearchParams(data));
    if (params.action === 'apply') {
      const evt = params.evt;
      const delta = parseInt(params.delta || '0', 10) || 0;
      const userId = event.source?.userId || '';
      const db = await loadDB();
      cleanupExpired(db);
      const displayName = await getDisplayNameSafe(userId) || '朋友';
      const resp = await applyDeltaToEvent(db, evt, userId, displayName, delta);
      if (db.events[evt]) {
        return client.replyMessage(event.replyToken, [
          resp,
          { type: 'text', text: renderListText(db.events[evt]) }
        ]);
      }
      return client.replyMessage(event.replyToken, resp);
    }
  }

  return Promise.resolve(null);
}

// 解析 +N / -N
function parsePlusMinus(text) {
  const m = text.trim().match(/^([+\-])\s*(\d+)?$/);
  if (!m) return null;
  const sign = m[1] === '+' ? +1 : -1;
  const n = Math.min(parseInt(m[2] || '1', 10), CONFIG.MAX_ADD_PER_ONCE);
  return { sign, n };
}

// 取得顯示名稱
async function getDisplayNameSafe(userId) {
  try {
    if (!userId) return '';
    const prof = await client.getProfile(userId);
    return prof?.displayName || '';
  } catch (e) {
    return '';
  }
}

// ====== 啟動 ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server on', PORT));
