// index.js — Badminton Signup Bot (Full Feature Stable)

import express from "express";
import * as line from "@line/bot-sdk";

// ====== LINE Config ======
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// ====== In-Memory Data ======
const eventsData = {
  events: {}, // eventId -> event
};

// quick id
const uid = () => Math.random().toString(36).slice(2, 10);

// ====== Helpers ======
function pad2(n) {
  return String(n).padStart(2, "0");
}

// 8/23 -> 2025-08-23（會用今年）
function toYYYYMMDDFromMD(md) {
  const [m, d] = md.split("/").map((x) => parseInt(x, 10));
  const now = new Date();
  const y = now.getFullYear();
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function nowISODate() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

// 判斷是否過期：日期 < 今日
function isExpiredEvent(evt) {
  const today = nowISODate();
  return evt.date < today;
}

function activeEvents() {
  return Object.values(eventsData.events).filter((e) => !isExpiredEvent(e));
}

function findEventByDateStr(dateMD) {
  const iso = toYYYYMMDDFromMD(dateMD);
  return Object.values(eventsData.events).find((e) => e.date === iso);
}

function findLatestEvent() {
  const arr = activeEvents();
  if (arr.length === 0) return null;
  arr.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return arr[arr.length - 1];
}

// ====== 解析 /new 輸入 ======
/**
 * 支援兩種：
 * /new 8/23 15:00-17:00 大安運動中心 羽10
 * /new 2025-08-23 15:00-17:00 大安運動中心 羽10
 */
function fromNewInputToEventObj(input) {
  const s = input.replace(/^\/new\s*/i, "").trim();
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;

  let dateRaw = parts[0];
  let timeRange = parts[1];

  // 其餘視為地點＋最後一段視為場地（可不填）
  let tail = parts.slice(2);
  let court = "";
  let location = "";
  if (tail.length >= 2) {
    court = tail[tail.length - 1];
    location = tail.slice(0, -1).join(" ");
  } else {
    location = tail[0] || "";
  }

  let yyyyMMDD = "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
    yyyyMMDD = dateRaw;
  } else if (/^\d{1,2}\/\d{1,2}$/.test(dateRaw)) {
    yyyyMMDD = toYYYYMMDDFromMD(dateRaw);
  } else {
    return null;
  }

  if (!/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(timeRange)) return null;

  // 預設名額從場地尾數嘗試抓，例如「羽10」抓 10；抓不到給 10
  let max = 10;
  const mCourt = court.match(/(\d+)$/);
  if (mCourt) {
    max = Math.max(1, parseInt(mCourt[1], 10));
  }

  return {
    date: yyyyMMDD,
    timeRange,
    location,
    court,
    max,
  };
}

// ====== 格式化訊息 ======
function formatEventHeader(e) {
  // 顯示 08-23(五) 等
  const dt = new Date(e.date);
  const weekday = ["日","一","二","三","四","五","六"][dt.getDay()];
  const md = `${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}(${weekday})`;

  return [
    "🏸 週末羽球報名開始！",
    `📅 ${md}`,
    `⏰ ${e.timeRange}`,
    `📍 ${e.location}${e.court ? " ／ " + e.court : ""}`,
    `👥 名額：${e.max} 人`,
    "",
    "📝 報名方式：",
    "• +1 ：只有自己 (1人)",
    "• +2 ：自己+朋友 (2人)",
    "• -1：自己取消",
    "",
    "輸入「list」查看報名狀況",
  ].join("\n");
}

function renderRosterText(e) {
  // 僅顯示有報名的人（不列 1..10 空行）
  const cur = e.attendees.reduce((a, m) => a + m.count, 0);
  const lines = [];

  // 標題
  const dt = new Date(e.date);
  const weekday = ["日","一","二","三","四","五","六"][dt.getDay()];
  const md = `${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}(${weekday})`;
  lines.push("📌 週末羽球");
  lines.push(`📅 ${md}`);
  lines.push(`⏰ ${e.timeRange}`);
  lines.push(`📍 ${e.location}${e.court ? " ／ " + e.court : ""}`);
  lines.push("====================");
  lines.push(`✅ 正式名單 (${cur}/${e.max}人)：`);

  if (e.attendees.length === 0) {
    lines.push("(目前還沒有人報名～)");
  } else {
    e.attendees.forEach((m, i) => {
      lines.push(`${i + 1}. ${m.name} (+${m.count})`);
    });
  }

  return lines.join("\n");
}

function briefEventLine(e) {
  const dt = new Date(e.date);
  const weekday = ["日","一","二","三","四","五","六"][dt.getDay()];
  const md = `${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}(${weekday})`;
  const cur = e.attendees.reduce((a, m) => a + m.count, 0);
  return `• ${md} ${e.timeRange}｜${e.location}${e.court ? "／" + e.court : ""}（${cur}/${e.max}）`;
}

// ====== 報名處理 ======
function totalCount(e) {
  return e.attendees.reduce((a, m) => a + m.count, 0);
}

function addOrDeltaUser(e, userId, name, delta) {
  // 累加（同人多次 + 會疊上去；- 只扣自己的那部分）
  const cur = e.attendees.find((x) => x.userId === userId);
  if (!cur) {
    if (delta > 0) {
      e.attendees.push({ userId, name, count: delta });
    }
  } else {
    cur.count += delta;
  }
  // 移除 count<=0 的人
  e.attendees = e.attendees.filter((x) => x.count > 0);

  // 若超過 max，回退本次變更
  let sum = totalCount(e);
  if (sum > e.max) {
    // 回退
    if (!cur) {
      // 本次剛新增
      e.attendees = e.attendees.filter((x) => x.userId !== userId);
    } else {
      cur.count -= delta;
      if (cur.count <= 0) {
        e.attendees = e.attendees.filter((x) => x.userId !== userId);
      }
    }
    return { ok: false, reason: "full" };
  }

  return { ok: true, sum };
}

// ====== 多場選擇：用 Quick Reply 讓使用者點日期 ======
// 當使用者輸入「+3」但目前有 2 場以上，就丟出日期選擇。
// 按鈕的 text 會是「+3 @8/23」=> 可讀！
function makeDateQuickReply(delta) {
  const items = activeEvents().map((e) => {
    const d = new Date(e.date);
    const md = `${d.getMonth() + 1}/${d.getDate()}`;
    return {
      type: "action",
      action: {
        type: "message",
        label: md,
        text: `${delta >= 0 ? "+" : ""}${delta} @${md}`,
      },
    };
  });
  return items;
}

// 解析「+3 @8/23」或「-2 @9/01」
function parsePlusMinusWithDate(text) {
  const m = text.trim().match(/^([+\-]\d+)\s*@\s*(\d{1,2}\/\d{1,2})$/);
  if (!m) return null;
  const delta = parseInt(m[1], 10);
  const dateMD = m[2];
  return { delta, dateMD };
}

// ====== 指令處理 ======
async function handleNew(client, event, text) {
  const info = fromNewInputToEventObj(text);
  if (!info) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "格式錯誤。\n請用：/new 8/23 15:00-17:00 大安運動中心 羽10",
    });
  }

  const id = uid();
  eventsData.events[id] = {
    id,
    date: info.date,
    timeRange: info.timeRange,
    location: info.location,
    court: info.court,
    max: info.max,
    attendees: [],
    createdAt: Date.now(),
  };

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `已建立活動：${text.replace(/^\/new\s*/i, "").trim()}`,
  });
}

async function handleList(client, event) {
  const acts = activeEvents();
  if (acts.length === 0) {
    return client.replyMessage(event.replyToken, { type: "text", text: "目前沒有開放中的場次唷～" });
  }

  // 每場傳一條（或你要合併成一條也可）
  const msgs = acts.map((e) => ({ type: "text", text: renderRosterText(e) }));
  return client.replyMessage(event.replyToken, msgs);
}

async function handlePlusMinus(client, event, delta) {
  const acts = activeEvents();
  if (acts.length === 0) {
    return client.replyMessage(event.replyToken, { type: "text", text: "目前沒有開放中的場次唷～" });
  }
  // 有多場 → 用 quick reply 讓用戶選日期，文字像「+3 @8/23」
  if (acts.length > 1) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "你想套用到哪一天？",
      quickReply: {
        items: makeDateQuickReply(delta),
      },
    });
  }
  // 只有一場 → 直接套用
  const e = acts[0];
  const name = await getDisplayName(event.source.userId);
  const ret = addOrDeltaUser(e, event.source.userId, name, delta);
  if (!ret.ok && ret.reason === "full") {
    return client.replyMessage(event.replyToken, { type: "text", text: "❌ 本場人數已達上限～" });
  }
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: `✅ ${name} 報名 ${delta > 0 ? delta : -delta} 人${delta > 0 ? "成功" : "已取消部份"}\n目前：${totalCount(e)}/${e.max}`,
  });
}

async function handlePlusMinusWithDateText(client, event, text) {
  const parsed = parsePlusMinusWithDate(text);
  if (!parsed) return false;
  const { delta, dateMD } = parsed;
  const e = findEventByDateStr(dateMD);
  if (!e || isExpiredEvent(e)) {
    await client.replyMessage(event.replyToken, { type: "text", text: "找不到對應的場次或該場次已過期～" });
    return true;
  }
  const name = await getDisplayName(event.source.userId);
  const ret = addOrDeltaUser(e, event.source.userId, name, delta);
  if (!ret.ok && ret.reason === "full") {
    await client.replyMessage(event.replyToken, { type: "text", text: "❌ 本場人數已達上限～" });
    return true;
  }
  await client.replyMessage(event.replyToken, {
    type: "text",
    text: `✅ ${name} 已套用到 ${dateMD}：${delta > 0 ? "+" : ""}${delta}\n目前：${totalCount(e)}/${e.max}`,
  });
  return true;
}

async function getDisplayName(userId) {
  // LINE 官方帳號必須將 bot 加入群組或好友才能拿到名字；拿不到就用 userId 末4碼
  try {
    // 你若用 group，這裡可改用 getGroupMemberProfile(event.source.groupId, userId)
    return `玩家${userId.slice(-4)}`;
  } catch (e) {
    return `玩家${userId.slice(-4)}`;
  }
}

// ====== Express + LINE webhook ======
const app = express();

app.post("/webhook", line.middleware(config), async (req, res) => {
  const client = new line.Client(config);
  const results = await Promise.all(
    req.body.events.map(async (ev) => {
      if (ev.type !== "message" || ev.message.type !== "text") return;
      const text = ev.message.text.trim();

      // 先試：+N @8/23 這種形式（使用者點 quick reply）
      const handled = await handlePlusMinusWithDateText(client, ev, text);
      if (handled) return;

      // /new
      if (/^\/new\s+/i.test(text)) {
        return handleNew(client, ev, text);
      }

      // list
      if (/^list$/i.test(text)) {
        return handleList(client, ev);
      }

      // +N / -N
      const m = text.match(/^([+\-]\d+)$/);
      if (m) {
        const delta = parseInt(m[1], 10);
        // 限制單次 ±10，避免誤觸
        if (Math.abs(delta) > 10) {
          return client.replyMessage(ev.replyToken, { type: "text", text: "單次變更請在 ±10 人以內唷～" });
        }
        return handlePlusMinus(client, ev, delta);
      }

      // /help
      if (/^\/help$/i.test(text) || /^\/\?$/.test(text)) {
        return client.replyMessage(ev.replyToken, {
          type: "text",
          text:
            "指令：\n" +
            "• /new 8/23 15:00-17:00 大安運動中心 羽10\n" +
            "• +1 / +2 / -1（多場會跳出日期選擇）\n" +
            "• list（查看各場名單）",
        });
      }
    })
  );
  res.json(results);
});

app.get("/", (_, res) => res.send("OK"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server on", PORT));
