// index.js
const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// ======= 資料儲存（記憶體暫存版，重啟會清空） =======
let eventsData = {}; // key: 日期字串, value: { place, time, type, limit, members: {name: count} }

// ======= Webhook 路由（一定要在 JSON 解析之前） =======
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

// ======= 其他需要 JSON 的路由（在 webhook 之後） =======
app.use(express.json());

// 健康檢查
app.get('/healthz', (req, res) => res.send('OK'));

// ======= 處理 LINE 訊息事件 =======
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text = event.message.text.trim();
  const userName = event.source.userId || 'unknown';

  // /new 建立活動
  if (text.startsWith('/new')) {
    const args = text.replace('/new', '').trim();
    // 範例: "9/1 18:00-20:00 大安運動中心 羽10"
    const match = args.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/);
    if (!match) {
      return replyText(event.replyToken, '格式錯誤，請用: /new 日期 時間 地點 項目人數');
    }
    const [ , date, time, place, typeLimit ] = match;
    eventsData[date] = {
      time,
      place,
      type: typeLimit.replace(/\d+$/, ''),
      limit: parseInt(typeLimit.match(/\d+$/)[0], 10),
      members: {}
    };
    return replyText(event.replyToken, `已建立活動：${date} ${time} ${place} ${typeLimit}`);
  }

  // /list 查看
  if (text === '/list') {
    if (Object.keys(eventsData).length === 0) {
      return replyText(event.replyToken, '目前沒有活動');
    }
    let msg = '活動列表：\n';
    for (const date in eventsData) {
      const ev = eventsData[date];
      const count = Object.values(ev.members).reduce((a, b) => a + b, 0);
      msg += `${date} ${ev.time} ${ev.place} ${ev.type}${ev.limit} (${count}/${ev.limit})\n`;
    }
    return replyText(event.replyToken, msg);
  }

  // +N / -N 報名或取消
  const addMatch = text.match(/^([+\-]\d+)$/);
  if (addMatch) {
    const num = parseInt(addMatch[1], 10);
    // 預設報名到最後建立的活動
    const latestDate = Object.keys(eventsData).sort().slice(-1)[0];
    if (!latestDate) return replyText(event.replyToken, '沒有可報名的活動');

    const ev = eventsData[latestDate];
    ev.members[userName] = (ev.members[userName] || 0) + num;

    if (ev.members[userName] <= 0) delete ev.members[userName];

    const total = Object.values(ev.members).reduce((a, b) => a + b, 0);
    return replyText(event.replyToken, `已更新 ${latestDate} 報名：${total}/${ev.limit}`);
  }

  return; // 不處理其他訊息
}

// ======= 回覆文字 =======
function replyText(replyToken, text) {
  return client.replyMessage(replyToken, { type: 'text', text });
}

// ======= LINE client =======
const client = new line.Client(config);

// ======= 啟動伺服器 =======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
