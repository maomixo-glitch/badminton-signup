// gsheet.js
const { google } = require('googleapis');
const fs = require('fs');

const SHEET_ID = process.env.SHEET_ID;
if (!SHEET_ID) throw new Error('Missing env SHEET_ID');

function getServiceAccount() {
  // 方式 A：Render Secret File
  const p = '/etc/secrets/gservice.json';
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  // 方式 B：如果你用 base64 環境變數存 JSON
  if (process.env.GOOGLE_CREDENTIALS_BASE64) {
    return JSON.parse(Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf8'));
  }
  throw new Error('Service account credentials not found.');
}

const credentials = getServiceAccount();

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

/** 取得工作表（ tab ）的所有資料（含標題） */
async function getAll(range = 'signup!A1:Z9999') {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return data.values || [];
}

/** 追加一列資料 */
async function appendRow(values, range = 'signup!A1') {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] },
  });
}

/** 覆寫範圍資料（更新） */
async function writeRange(range, values2D) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: values2D },
  });
}

/** 確保存在 signup 分頁與標題列 */
async function ensureSignupHeader() {
  const all = await getAll('signup!A1:B1').catch(() => null);
  if (!all || all.length === 0) {
    // 分頁不存在或空白 → 建立標題
    await writeRange('signup!A1:B1', [['key', 'value']]);
  }
}

module.exports = {
  getAll,
  appendRow,
  writeRange,
  ensureSignupHeader,
};
