const { google } = require('googleapis');

// 讀 .env：SHEET_ID、GOOGLE_SERVICE_ACCOUNT（JSON）
function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  return new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
}

// 追加一列到 signup 分頁（統一 10 欄：A:J）
async function appendRow(auth, values) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: 'signup!A:J',           // ★ 統一 10 欄
    valueInputOption: 'RAW',
    requestBody: { values: [values] },
  });
  return res.data;
}

// 從 config!A1 讀 JSON（整個 DB）
async function readConfig(auth) {
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: 'config!A1',
  });
  const v = res.data.values?.[0]?.[0];
  if (!v) return {};
  try { return JSON.parse(v); } catch { return {}; }
}

// 寫 JSON 到 config!A1（整個 DB）
async function writeConfig(auth, dbObj) {
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SHEET_ID,
    range: 'config!A1',
    valueInputOption: 'RAW',
    requestBody: { values: [[JSON.stringify(dbObj)]] },
  });
}

module.exports = { getAuth, appendRow, readConfig, writeConfig };
