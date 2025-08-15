// === LINE + Express 基礎 ===
const fs = require('fs');
const path = require('path');
const express = require('express');
const line = require('@line/bot-sdk');

const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;

const config = {
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();

// Render 健康檢查
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// Webhook
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

// 啟動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server on', PORT));

/* ======================
 *    檔案儲存 / 資料模型
 * ====================== */

const DB_FILE = path.join(__dirname, 'data.json');

function loadDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const o = JSON.parse(raw);
    if (!o.config) o.config = {};
    if (!o.events) o.events = {};
    return o;
  } catch {
    return { config: {}, events: {} };
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

/* ======================
 *     工具 / 共用函式
 * ====================== */

// +N / -N 解析：+1、+2、-1，+N 視為「總人數 = N」，不是增量
const MAX_ADD_PER_ONCE = 10;
function parsePlusMinus(text) {
  const m = text.trim().match(/^([+-])\s*(\d+)?(?:\s+(evt_[0-9a-zA-Z]+))?$/);
  if (!m) return null;
  const sign = m[1] === '+' ? +1 : -1;
  const n = Math.max(1, Math.min(parseInt(m[2] || '1', 10), MAX_ADD_PER_ONCE));
  const evtId = m[3] || ''; // 可能存在 quick reply 帶入的 id
  return { sign, n, evtId };
}

// 允許兩種：
// /new 8/23 15:00-17:00 大安運動中心 羽10
// /new 2025-08-23 15:00-17:00 大安運動中心 羽10
function fromNewInputToEventObj(input) {
  const s = input.replace(/^\/new\s*/i, '').trim();
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;

  let dateRaw = parts[0];
  let timeRange = parts[1];

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

  const max = parseMaxFromCourt(court) || 10; // 如果 court 末尾有數字，視為 max

  const loc = court ? `${location}／${court}` : location;

  return {
    date: yyyyMMDD,
    timeRange,
    location: loc,
    max,
  };
}

// 從「羽10」或「桌8」取數字 10 / 8
function parseMaxFromCourt(court) {
  if (!court) return 0;
  const m = court.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function toYYYYMMDDFromMD(md) {
  // md like 8/23 -> yyyy-08-23
  const now = new Date();
  const [m, d] = md.split('/').map(v => parseInt(v, 10));
  const y = now.getFullYear();
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function toMDWithWeek(yyyyMMDD) {
  const d = new Date(yyyyMMDD);
  const md = `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const w = '日一二三四五六'.charAt(d.getDay());
  return `${md}(${w})`;
}

function total(list) {
  return (list || []).reduce((a, x) => a + (x.count || 0), 0);
}

// 取得使用者顯示名稱
async function getDisplayName(event) {
  try {
    if (event.source.type === 'group') {
      const prof = await client.getGroupMemberProfile(event.source.groupId, event.source.userId);
      return prof.displayName || '路人';
    } else if (event.source.type === 'room') {
      const prof = await client.getRoomMemberProfile(event.source.roomId, event.source.userId);
      return prof.displayName || '路人';
    } else {
      const prof = await client.getProfile(event.source.userId);
      return prof.displayName || '路人';
    }
  } catch {
    return '路人';
  }
}

/* ======================
 *    場次選取 / 目前場次
 * ====================== */

// 取得 open 場次（未來或今天）
function getOpenEvents(db) {
  const today = (new Date()).toISOString().slice(0, 10);
  const list = Object.values(db.events || {}).filter(e => e.status === 'open' && e.date >= today);
  list.sort((a, b) => (a.date + a.timeRange).localeCompare(b.date + b.timeRange));
  return list;
}

// 根據 config.current_event_id 或 open 場次取得一場
function getActiveEvent(db) {
  const id = db.config.current_event_id;
  if (id && db.events[id]) return db.events[id];
  const list = getOpenEvents(db);
  if (list.length === 0) return null;
  db.config.current_event_id = list[0].id;
  return list[0];
}

// 有多場 open 時，讓使用者選擇（quick reply）
// op: 'plus' | 'minus' | 'list'
// n: number（plus 用）
function chooseEventQuickReply(event, op, n, db) {
  const list = getOpenEvents(db);
  if (list.length <= 1) return null;

  const actions = list.map(e => {
    let text = '';
    if (op === 'plus') text = `+${n} ${e.id}`;
    else if (op === 'minus') text = `-1 ${e.id}`;
    else text = `list ${e.id}`;
    return {
      type: 'action',
      action: {
        type: 'message',
        label: toMDWithWeek(e.date),
        text,
      }
    };
  });

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: '你想套用到哪一場？',
    quickReply: {
      items: actions
    }
  });
}

/* ======================
 *        Flex 卡片
 * ====================== */

function renderOpenCard(e) {
  return {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: '🏸 週末羽球報名開始！', weight: 'bold', size: 'lg' },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: `📅 ${toMDWithWeek(e.date)}`, margin: 'md' },
        { type: 'text', text: `⏰ ${e.timeRange}` },
        { type: 'text', text: `📍 ${e.location}` },
        { type: 'text', text: `👥 名額：${e.max} 人` },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '📝 報名方式：' },
        { type: 'text', text: '• +1 ：只有自己 (1人)' },
        { type: 'text', text: '• +2 ：自己+朋友 (2人)' },
        { type: 'text', text: '• -1：自己取消' },
        { type: 'text', text: '輸入 "list" 查看報名狀況', margin: 'md', color: '#888888' }
      ]
    }
  };
}

function renderListFlex(e) {
  const used = total(e.attendees);
  const lines = [
    { type: 'text', text: '📌 週末羽球報名', weight: 'bold', size: 'lg' },
    { type: 'text', text: `📅 ${toMDWithWeek(e.date)}` },
    { type: 'text', text: `⏰ ${e.timeRange}` },
    { type: 'text', text: `📍：${e.location}` },
    { type: 'separator', margin: 'md' },
    { type: 'text', text: `✅ 正式名單 (${used}/${e.max}人)：` }
  ];

  (e.attendees || []).forEach((m, i) => {
    const extra = m.count > 1 ? ` (+${m.count - 1})` : '';
    lines.push({ type: 'text', text: `${i+1}. ${m.name}${extra}`, wrap: true });
  });
  if (!e.attendees || e.attendees.length === 0) {
    lines.push({ type: 'text', text: '（尚無報名）', color: '#888888' });
  }

  return {
    type: 'flex',
    altText: '目前報名狀況',
    contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: lines } }
  };
}

/* ======================
 *       Handlers
 * ====================== */

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text = (event.message.text || '').trim();

  // /new
  if (/^\/new\s+/i.test(text)) {
    const payload = text.replace(/^\/new\s+/i, '');
    return handleNew(event, payload);
  }

  // list 或 list evt_xxx
  if (/^list(\s+evt_[0-9a-zA-Z]+)?$/i.test(text)) {
    const m = text.match(/^list(?:\s+(evt_[0-9a-zA-Z]+))?$/i);
    const evtId = m && m[1] ? m[1] : '';
    return handleList(event, evtId);
  }

  // +N / -N（可含 evt_xxx）
  const pm = parsePlusMinus(text);
  if (pm) {
    return handlePlusMinus(event, pm);
  }

  // 其他指令
  if (/^\/new$/i.test(text)) {
    return client.replyMessage(event.replyToken, { type: 'text', text: '請輸入：/new 8/23 15:00-17:00 地點 場地' });
  }

  // 幫助
  if (/^\/help$/i.test(text) || /^help$/i.test(text)) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text:
        '指令：\n' +
        '• /new YYYY-MM-DD | HH:MM-HH:MM | 地點 | (可選場地)\n' +
        '• +1 / +2（自己+朋友）\n' +
        '• -1（取消）\n' +
        '• list（顯示名單）'
    });
  }

  // 無匹配就不回
}

// 建立新場次
async function handleNew(event, payload) {
  const e = fromNewInputToEventObj(payload);
  if (!e) {
    return client.replyMessage(event.replyToken, { type: 'text', text: '格式錯誤：/new 8/23 15:00-17:00 地點 場地' });
  }

  const db = loadDB();
  const id = `evt_${Date.now()}`;
  db.events[id] = {
    id,
    date: e.date,
    timeRange: e.timeRange,
    location: e.location,
    max: Number(e.max || 10),
    status: 'open',
    attendees: []
  };
  db.config.current_event_id = id;
  saveDB(db);

  return client.replyMessage(event.replyToken, {
    type: 'flex',
    altText: '週末羽球報名開始！',
    contents: renderOpenCard(db.events[id])
  });
}

// +N / -N
async function handlePlusMinus(event, pm) {
  const db = loadDB();
  let target = null;

  // 如果訊息有帶 evt_xxx，就用它；否則看 open 場次數量
  if (pm.evtId && db.events[pm.evtId]) {
    target = db.events[pm.evtId];
  } else {
    const opens = getOpenEvents(db);
    if (opens.length === 0) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '目前沒有開放中的場次唷～' });
    }
    if (opens.length > 1) {
      // 跳出選擇（quick reply），按鈕會送出「+N evt_xxx / -1 evt_xxx」
      const op = pm.sign === +1 ? 'plus' : 'minus';
      return chooseEventQuickReply(event, op, pm.n, db);
    }
    target = opens[0];
  }

  const userId = event.source.userId || '';
  const who = await getDisplayName(event);
  const { sign, n } = pm;

  let m = target.attendees.find(x => x.userId === userId);

  if (sign === +1) {
    const newTotal = n;
    if (!m) {
      const used = total(target.attendees);
      if (used + newTotal > target.max) {
        return client.replyMessage(event.replyToken, { type: 'text', text: '❌ 本週人數已達上限，下次早點報名 ㄎㄎ，或洽管理員' });
      }
      m = { userId, name: who, count: newTotal };
      target.attendees.push(m);
    } else {
      const usedWithoutMe = total(target.attendees) - m.count;
      if (usedWithoutMe + newTotal > target.max) {
        return client.replyMessage(event.replyToken, { type: 'text', text: '❌ 本週人數已達上限，下次早點報名 ㄎㄎ，或洽管理員' });
      }
      m.count = newTotal;
      m.name = who;
    }
    saveDB(db);

    const rank = target.attendees.findIndex(x => x.userId === userId) + 1;
    return client.replyMessage(event.replyToken, [
      { type: 'text', text: `✅ ${who} 報名 ${n} 人成功 (ﾉ>ω<)ﾉ\n順位：${rank}` },
      renderListFlex(target)
    ]);
  } else {
    if (m) {
      target.attendees = target.attendees.filter(x => x.userId !== userId);
      saveDB(db);
      return client.replyMessage(event.replyToken, { type: 'text', text: `✅ ${who} 已取消 ${m.count} 人報名(๑•́ ₃ •̀๑)` });
    } else {
      return client.replyMessage(event.replyToken, { type: 'text', text: '你目前沒有在名單中唷～' });
    }
  }
}

// list（可帶 evt_xxx）
async function handleList(event, evtId) {
  const db = loadDB();
  let cur = null;

  if (evtId && db.events[evtId]) cur = db.events[evtId];
  else {
    const opens = getOpenEvents(db);
    if (opens.length === 0) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '目前沒有開放中的場次唷～' });
    }
    if (opens.length > 1) {
      // 跳選單（quick reply），按鈕會送出「list evt_xxx」
      return chooseEventQuickReply(event, 'list', 0, db);
    }
    cur = opens[0];
  }
  return client.replyMessage(event.replyToken, renderListFlex(cur));
}
