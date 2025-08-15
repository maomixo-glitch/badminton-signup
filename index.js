// ===============================
//  LINE 羽球報名 Bot（完整版）
//  功能：/new、+N/-N、list、多場選擇、顯示姓名、同聊天室隔離、容量上限、過期自動忽略
// ===============================

const express = require("express");
const line = require("@line/bot-sdk");

// ---- 環境設定 ----
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const PORT = process.env.PORT || 3000;
const DEFAULT_MAX = 10; // 預設人數上限
const MAX_ADD_PER_ONCE = 10; // 一次最多 +N

// ---- 建立應用與 LINE 客戶端 ----
const app = express();
const client = new line.Client(config);

// ---- 記憶體中的資料（可之後換成檔案/資料庫）----
const db = {
  lastId: 0,
  events: {
    // [id]: { id, chatId, date:'YYYY-MM-DD', timeRange:'HH:MM-HH:MM', location, court, max, attendees: [{userId, name, count}], createdAt }
  },
};

// ===============================
// 工具：聊天室 scope（讓不同群組的場次彼此不干擾）
// ===============================
function getScopeKey(source) {
  if (source.type === "group") return `g:${source.groupId}`;
  if (source.type === "room") return `r:${source.roomId}`;
  return `u:${source.userId}`;
}

// ===============================
// 工具：取 LINE 顯示名稱（1:1 / 群組 / 多人聊天室）
// ===============================
async function getDisplayName(client, source) {
  try {
    if (source.type === "group") {
      const p = await client.getGroupMemberProfile(source.groupId, source.userId);
      return p.displayName;
    } else if (source.type === "room") {
      const p = await client.getRoomMemberProfile(source.roomId, source.userId);
      return p.displayName;
    } else {
      const p = await client.getProfile(source.userId);
      return p.displayName;
    }
  } catch (e) {
    return `玩家${(source.userId || "").slice(-4)}`;
  }
}

// ===============================
// 工具：日期字串 & 過期判定
// ===============================
function pad2(n) {
  return n.toString().padStart(2, "0");
}

function toYYYYMMDDFromMD(md) {
  // md: "8/23"
  const [m, d] = md.split("/").map((v) => parseInt(v, 10));
  const now = new Date();
  const y = now.getFullYear();
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function isExpiredEvent(e) {
  // 日期 + 結束時間 前已過
  const [start, end] = e.timeRange.split("-");
  const dtEnd = new Date(`${e.date}T${end}:00+09:00`); // +09:00 只是避免時區誤差，實際上無影響
  return Date.now() > dtEnd.getTime();
}

function activeEventsIn(source) {
  const scope = getScopeKey(source);
  return Object.values(db.events).filter((e) => !isExpiredEvent(e) && e.chatId === scope);
}

// ===============================
// 工具：+N / -N 解析
// ===============================
function parsePlusMinus(text) {
  const m = text.trim().match(/^([+-])\s*(\d+)(?:\s*@\s*(\d{1,2}\/\d{1,2}))?$/i);
  if (!m) return null;
  let n = Math.min(parseInt(m[2], 10), MAX_ADD_PER_ONCE);
  const sign = m[1] === "-" ? -1 : 1;
  const md = m[3] || null; // 可帶 @8/23 指定場次
  return { delta: sign * n, md };
}

function totalCount(e) {
  return e.attendees.reduce((a, m) => a + (m.count || 0), 0);
}

function findMemberIndex(e, userId) {
  return e.attendees.findIndex((m) => m.userId === userId);
}

// ===============================
// 新場次輸入解析（/new M/D HH:MM-HH:MM 地點 [場地(例：羽10)]）
// 也接受：/new YYYY-MM-DD HH:MM-HH:MM 地點 場地
// 場地尾段如果像「羽10」會自動解析出 max=10；若沒數字，max=DEFAULT_MAX。
// ===============================
function parseNewInput(raw) {
  const s = raw.replace(/^\/new\s*/i, "").trim();
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;

  let dateRaw = parts[0];
  let timeRange = parts[1];

  // 地點與場地（最後一段視為場地，沒有就只地點）
  const tail = parts.slice(2);
  let location = "";
  let court = "";
  if (tail.length >= 2) {
    court = tail[tail.length - 1];
    location = tail.slice(0, -1).join(" ");
  } else {
    location = tail[0];
  }

  // 日期轉成 YYYY-MM-DD
  let yyyyMMDD = "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
    yyyyMMDD = dateRaw;
  } else if (/^\d{1,2}\/\d{1,2}$/.test(dateRaw)) {
    yyyyMMDD = toYYYYMMDDFromMD(dateRaw);
  } else {
    return null;
  }

  if (!/^\d{2}:\d{2}\-\d{2}:\d{2}$/.test(timeRange)) return null;

  // 解析上限：從 court 取數字（像「羽10」→ 10），沒有就 10
  let max = DEFAULT_MAX;
  const mMax = court.match(/(\d+)/);
  if (mMax) {
    max = Math.max(1, parseInt(mMax[1], 10));
  }

  return { date: yyyyMMDD, timeRange, location, court, max };
}

// ===============================
// 訊息模板
// ===============================
function formatEventHeader(e) {
  const dt = new Date(e.date);
  const w = "日一二三四五六".charAt(dt.getDay());
  const md = `${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}(${w})`;
  return [
    "📌 週末羽球報名開放！",
    `📅 ${md}`,
    `⏰ ${e.timeRange}`,
    `📍 ${e.location}${e.court ? "／" + e.court : ""}`,
    "====================",
    "📝 報名方式：",
    "• +1：自己 (1人)",
    "• +2：自己+朋友 (2人)",
    "• -1：自己取消",
    "• 多場同時開放時，會讓你挑日期",
    "",
    "輸入「list」查看報名狀況",
  ].join("\n");
}

function renderRosterText(e) {
  const dt = new Date(e.date);
  const w = "日一二三四五六".charAt(dt.getDay());
  const md = `${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}(${w})`;
  const lines = [];
  lines.push("📌 週末羽球");
  lines.push(`📅 ${md}`);
  lines.push(`⏰ ${e.timeRange}`);
  lines.push(`📍 ${e.location}${e.court ? "／" + e.court : ""}`);
  lines.push("====================");
  const cur = totalCount(e);
  lines.push(`✅ 正式名單 (${cur}/${e.max} 人)：`);
  if (e.attendees.length === 0) {
    lines.push("(目前還沒有人報名～)");
  } else {
    e.attendees.forEach((m, i) => {
      const extra = m.count > 1 ? ` (+${m.count - 1})` : "";
      lines.push(`${i + 1}. ${m.name}${extra}`);
    });
  }
  return lines.join("\n");
}

function quickReplyChooseDate(delta, source) {
  const acts = activeEventsIn(source);
  const items = acts.map((e) => {
    const d = new Date(e.date);
    const md = `${d.getMonth() + 1}/${d.getDate()}`;
    return {
      type: "action",
      action: {
        type: "message",
        label: md,
        text: `${delta >= 0 ? "+" : ""}${Math.abs(delta)} @${md}`,
      },
    };
  });
  return { items };
}

// ===============================
// Handlers
// ===============================
async function handleNew(client, event, text) {
  // 任何人都可以建立場次（你說不用限制管理員）
  const info = parseNewInput(text);
  if (!info) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "格式錯誤唷～\n例：/new 8/23 15:00-17:00 大安運動中心 羽10",
    });
  }
  const chatId = getScopeKey(event.source);
  const id = `evt_${++db.lastId}`;

  db.events[id] = {
    id,
    chatId,
    date: info.date,
    timeRange: info.timeRange,
    location: info.location,
    court: info.court,
    max: info.max,
    attendees: [],
    createdAt: Date.now(),
  };

  const header = formatEventHeader(db.events[id]);
  const roster = renderRosterText(db.events[id]);
  return client.replyMessage(event.replyToken, [
    { type: "text", text: `已建立活動：${info.date.replace(/^(\d{4})-/, "")} ${info.timeRange} ${info.location} ${info.court}` },
    { type: "text", text: header },
    { type: "text", text: roster },
  ]);
}

async function handleList(client, event) {
  const acts = activeEventsIn(event.source);
  if (acts.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "目前沒有開放中的場次唷～",
    });
  }
  const msgs = acts.map((e) => ({ type: "text", text: renderRosterText(e) }));
  return client.replyMessage(event.replyToken, msgs);
}

async function handlePlusMinus(client, event, text) {
  const pm = parsePlusMinus(text);
  if (!pm) {
    return client.replyMessage(event.replyToken, { type: "text", text: "格式錯誤，請輸入 +1 或 -1（或 +2, +3...）" });
  }
  let { delta, md } = pm;

  let targets = activeEventsIn(event.source);
  if (targets.length === 0) {
    return client.replyMessage(event.replyToken, { type: "text", text: "目前沒有開放中的場次唷～" });
  }

  // 如果有多場但沒有指定日期，跳出日期 quickReply
  if (targets.length > 1 && !md) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "你想套用到哪一天？",
      quickReply: quickReplyChooseDate(delta, event.source),
    });
  }

  // 有指定日期（+1 @8/23）
  if (md) {
    const ym = toYYYYMMDDFromMD(md);
    targets = targets.filter((e) => e.date === ym);
    if (targets.length === 0) {
      return client.replyMessage(event.replyToken, { type: "text", text: `找不到 ${md} 的場次唷～` });
    }
  }

  const e = targets[0];
  const name = await getDisplayName(client, event.source);
  const userId = event.source.userId;

  // 場次已滿 / 容量檢查
  if (delta > 0) {
    const left = e.max - totalCount(e);
    if (left <= 0) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "❌ 本場次已達上限，下次早點報名(๑•́ ₃ •̀๑)",
      });
    }
    if (delta > left) delta = left; // 超過上限就縮到剩餘名額
  }

  // 加總 / 扣減
  let idx = findMemberIndex(e, userId);
  if (idx === -1) {
    if (delta <= 0) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "你還沒有報名唷～",
      });
    }
    e.attendees.push({ userId, name, count: delta });
  } else {
    e.attendees[idx].name = name; // 更新一下名字（有改暱稱也會更新）
    e.attendees[idx].count += delta;
    if (e.attendees[idx].count <= 0) {
      e.attendees.splice(idx, 1);
    }
  }

  const cur = totalCount(e);
  const okText =
    delta > 0
      ? `✅ ${name} 報名 ${delta} 人成功 (ﾉ>ω<)ﾉ\n目前：${cur}/${e.max}`
      : `✅ ${name} 已取消 ${Math.abs(delta)} 人 ( ˘･з･) \n目前：${cur}/${e.max}`;

  return client.replyMessage(event.replyToken, [
    { type: "text", text: okText },
    { type: "text", text: renderRosterText(e) },
  ]);
}

// ===============================
// Webhook
// ===============================
app.post("/webhook", line.middleware(config), async (req, res) => {
  const results = await Promise.all(
    req.body.events.map(async (event) => {
      if (event.type !== "message" || event.message.type !== "text") return;
      const text = (event.message.text || "").trim();

      // 指令路由
      if (/^\/new\s+/i.test(text)) {
        return handleNew(client, event, text);
      }
      if (/^list$/i.test(text)) {
        return handleList(client, event);
      }
      if (/^[+-]\s*\d+/.test(text)) {
        return handlePlusMinus(client, event, text);
      }

      // 非指令可忽略或回個提示
      return;
    })
  );
  res.json(results);
});

// 健康檢查 & 啟動
app.get("/", (req, res) => res.send("OK"));
app.listen(PORT, () => console.log(`Server on ${PORT}`));
