// index.js  —— Badminton Signup Bot (Final Integrated)
// 時區：台北
process.env.TZ = 'Asia/Taipei';

const express = require('express');
const fs = require('fs');
const path = require('path');
const line = require('@line/bot-sdk');

const app = express();

// ====== LINE SDK config ======
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new line.Client(config);

// ====== 資料檔 ======
const DATA_FILE = path.join(__dirname, 'data.json');
function loadDB() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}
function saveDB(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
}
function ensureDB() {
  const db = loadDB();
  if (!db.events) db.events = {};
  saveDB(db);
  return db;
}
ensureDB();

// ====== 小工具 ======
const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
const fmtMD = (d) => `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
const fmtYMD = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fmtWeek = (d) => ['日','一','二','三','四','五','六'][d.getDay()];
const emoji = {
  pin: '📌', star: '✨', cal: '📅', clock: '⏰', loc: '📍', ok: '✅', no: '❌'
};

// 解析 +N/-N（含 +3 @9/06）
function parsePlusMinus(text) {
  const m = text.trim().match(/^([+\-])\s*(\d+)(?:\s*@\s*(\d{1,2})[\/\-](\d{1,2}))?$/i);
  if (!m) return null;
  const sign = m[1] === '+' ? 1 : -1;
  const n = Math.max(1, Math.min(parseInt(m[2], 10) || 1, 10)); // 一次最多 10
  const md = (m[3] && m[4]) ? `${pad2(parseInt(m[3],10))}/${pad2(parseInt(m[4],10))}` : null;
  return { sign, n, md };
}

// YYYY-MM-DD <-> 8/23 轉換
function toYMDFromMD(md) {
  // md: 8/23
  const [m, d] = md.split('/').map(v => parseInt(v, 10));
  const now = new Date();
  return `${now.getFullYear()}-${pad2(m)}-${pad2(d)}`;
}
function tryParseDateToken(s) {
  // 支援 9/1 或 2025-09-01
  if (/^\d{1,2}\/\d{1,2}$/.test(s)) return toYMDFromMD(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

// 解析 /new 指令（/new 9/1 18:00-20:00 大安運動中心 羽10）
function parseNew(str) {
  const s = str.replace(/^\/new\s*/i, '').trim();
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;
  const dateRaw = parts[0]; // 8/23 or 2025-09-06
  const timeRange = parts[1]; // 18:00-20:00
  const tail = parts.slice(2);
  let court = '', location = '';
  if (tail.length >= 2) {
    court = tail[tail.length - 1];
    location = tail.slice(0, -1).join(' ');
  } else {
    location = tail[0] || '';
  }
  const ymd = tryParseDateToken(dateRaw);
  if (!ymd) return null;
  // 解析時間
  const tm = timeRange.match(/^(\d{1,2}):(\d{2})\-(\d{1,2}):(\d{2})$/);
  if (!tm) return null;
  const sh = parseInt(tm[1],10), sm = parseInt(tm[2],10), eh = parseInt(tm[3],10), em = parseInt(tm[4],10);
  const date = new Date(ymd + 'T00:00:00+08:00');
  const start = new Date(date);
  start.setHours(sh, sm, 0, 0);
  const end = new Date(date);
  end.setHours(eh, em, 0, 0);

  // 最大人數：羽10 → 10
  let max = 10;
  const mCourt = court.match(/(\d+)/);
  if (mCourt) max = parseInt(mCourt[1], 10);

  return { ymd, start: start.toISOString(), end: end.toISOString(), timeRange, location, court, max };
}

// 目前是否開放（現在 < 結束時間）
function isOpen(evt) {
  return new Date() < new Date(evt.end);
}

// 取得 open 事件清單（尚未結束）
function openEvents(db) {
  return Object.values(db.events).filter(isOpen);
}

// 取得指定日期 open 事件
function findEventByYMD(db, ymd) {
  return Object.values(db.events).find(e => e.ymd === ymd && isOpen(e));
}

// 計算總報名人數
function totalCount(evt) {
  return (evt.attendees || []).reduce((a, m) => a + (m.count || 0), 0);
}

// 取得使用者名
function displayName(source, fallback) {
  const name = (source && source.userId && source.userIdName) || fallback || '玩家';
  return name;
}

// 渲染卡片（僅列出有報名的人）
function renderCard(evt) {
  const dStart = new Date(evt.start);
  const lines = [];
  lines.push(`${emoji.star} 週末羽球`);
  lines.push(`${emoji.cal} ${fmtMD(dStart)}(${fmtWeek(dStart)})`);
  lines.push(`${emoji.clock} ${evt.timeRange}`);
  lines.push(`${emoji.loc} ${evt.location}／${evt.court}`);
  lines.push('====================');
  const cur = totalCount(evt);
  lines.push(`${emoji.ok} 正式名單 (${cur}/${evt.max}人)：`);
  const list = (evt.attendees || []).filter(m => m.count > 0);
  if (list.length === 0) {
    lines.push('（目前還沒有人報名～）');
  } else {
    list.forEach((m, i) => {
      const extra = m.count > 1 ? ` (+${m.count - 1})` : '';
      lines.push(`${i + 1}. ${m.name}${extra}`);
    });
  }
  return lines.join('\n');
}

// 簡短回覆
function quickOK(text) {
  return { type: 'text', text };
}

// quick reply 選日期
function quickPickDates(text, events) {
  const items = events.map(e => ({
    type: 'action',
    action: { type: 'message', label: fmtMD(new Date(e.start)), text: `${text} @${fmtMD(new Date(e.start))}` }
  }));
  return {
    type: 'text',
    text: '你想套用在哪一天？',
    quickReply: { items }
  };
}

// 依 userId 找 / 建立報名資料
function addOrUpdateAttendee(evt, userId, name, delta) {
  evt.attendees = evt.attendees || [];
  const idx = evt.attendees.findIndex(m => m.userId === userId);
  if (idx === -1) {
    evt.attendees.push({ userId, name, count: Math.max(0, delta) });
  } else {
    evt.attendees[idx].count = Math.max(0, (evt.attendees[idx].count || 0) + delta);
    if (evt.attendees[idx].count === 0) {
      evt.attendees.splice(idx, 1);
    }
  }
}

// ====== 啟動 ======
app.get('/healthz', (req, res) => res.send('OK'));

app.post('/webhook', line.middleware(config), async (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then(result => res.json(result))
    .catch(e => {
      console.error(e);
      res.status(500).end();
    });
});

async function handleEvent(evt) {
  if (evt.type !== 'message' || evt.message.type !== 'text') return;
  const text = evt.message.text.trim();
  const db = loadDB();

  // ====== /new 建立活動 ======
  if (/^\/new/i.test(text)) {
    const p = parseNew(text);
    if (!p) {
      return client.replyMessage(evt.replyToken, quickOK(
        '格式：\n/new 9/6 18:00-20:00 大安運動中心 羽10\n或 /new 2025-09-06 18:00-20:00 大安運動中心 羽10'
      ));
    }
    const id = 'evt_' + Date.now();
    db.events[id] = {
      id,
      ymd: p.ymd,
      start: p.start,
      end: p.end,
      timeRange: p.timeRange,
      location: p.location,
      court: p.court || '羽10',
      max: p.max || 10,
      attendees: []
    };
    saveDB(db);

    const d = new Date(p.start);
    const title = `${emoji.pin} 週末羽球報名開始！`;
    const msg = [
      title,
      `${emoji.cal} ${fmtMD(d)}(${fmtWeek(d)})`,
      `${emoji.clock} ${p.timeRange}`,
      `${emoji.loc} ${p.location}／${p.court || '羽10'}`,
      '',
      '📝 報名方式：',
      '• +1 ：只有自己 (1人)',
      '• +2 ：自己+朋友 (2人)',
      '• -1 ：自己取消',
      '',
      '輸入 "list" 查看報名狀況'
    ].join('\n');

    return client.replyMessage(evt.replyToken, { type: 'text', text: msg });
  }

  // ====== list ======
  if (/^list(\s+.+)?$/i.test(text)) {
    const m = text.match(/^list\s+(.+)$/i);
    let list = openEvents(db);
    if (m) {
      const ymd = tryParseDateToken(m[1].trim());
      if (ymd) list = list.filter(e => e.ymd === ymd);
    }
    if (list.length === 0) {
      return client.replyMessage(evt.replyToken, quickOK('目前沒有開放中的場次唷～'));
    }
    const messages = list.map(e => ({ type: 'text', text: renderCard(e) }));
    return client.replyMessage(evt.replyToken, messages);
  }

  // ====== +N / -N ======
  const pm = parsePlusMinus(text);
  if (pm) {
    // 如果沒指定日期但有多場，就讓他選
    let targetEvt = null;
    if (pm.md) {
      const ymd = toYMDFromMD(pm.md);
      targetEvt = findEventByYMD(db, ymd);
      if (!targetEvt) {
        return client.replyMessage(evt.replyToken, quickOK(`找不到 ${pm.md} 的開放場次`));
      }
    } else {
      const list = openEvents(db);
      if (list.length === 0) {
        return client.replyMessage(evt.replyToken, quickOK('目前沒有開放中的場次唷～'));
      } else if (list.length >= 2) {
        // 讓他選
        return client.replyMessage(evt.replyToken, quickPickDates(`${pm.sign > 0 ? '+' : '-'}${pm.n}`, list));
      } else {
        targetEvt = list[0];
      }
    }

    // 檢查是否仍開放
    if (!isOpen(targetEvt)) {
      return client.replyMessage(evt.replyToken, quickOK('本場次已結束，無法再異動唷～'));
    }

    const userId = evt.source.userId || ('user_' + (evt.source.groupId || evt.source.roomId || 'x'));
    // 取稱呼（顯示 LINE 暱稱）
    const name = evt.source.userIdName || evt.source.userId || '匿名';

    // 計算容量
    const before = totalCount(targetEvt);
    const delta = pm.sign * pm.n;
    // 若是增加，要先確認是否會超過
    if (delta > 0) {
      const mine = (targetEvt.attendees || []).find(m => m.userId === userId);
      const mineCount = mine ? mine.count : 0;
      // 先暫算
      const will = before + delta;
      if (will > targetEvt.max) {
        return client.replyMessage(evt.replyToken, quickOK(`${emoji.no} 本場次已達上限，下次早點報名(๑•́ ₃ •̀๑)`));
      }
      addOrUpdateAttendee(targetEvt, userId, name, delta);
      saveDB(db);
      const cur = totalCount(targetEvt);
      // 成功訊息 + 名單卡片
      return client.replyMessage(evt.replyToken, [
        quickOK(`${emoji.ok} ${name} 報名 ${pm.n} 人成功 (ﾉ>ω<)ﾉ\n目前：${cur}/${targetEvt.max}`),
        { type: 'text', text: renderCard(targetEvt) }
      ]);
    } else {
      // 減少
      const mine = (targetEvt.attendees || []).find(m => m.userId === userId);
      if (!mine) {
        return client.replyMessage(evt.replyToken, quickOK('你還沒有報名喔～'));
      }
      addOrUpdateAttendee(targetEvt, userId, name, delta);
      saveDB(db);
      const cur = totalCount(targetEvt);
      return client.replyMessage(evt.replyToken, [
        quickOK(`${emoji.ok} ${name} 已取消 ${Math.abs(delta)} 人 (´･ᴗ･ \`) \n目前：${cur}/${targetEvt.max}`),
        { type: 'text', text: renderCard(targetEvt) }
      ]);
    }
  }

  // 其他
  return;
}

// ====== 啟動 Server ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));
