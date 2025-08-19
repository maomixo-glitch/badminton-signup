const { google } = require("googleapis");

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  return new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
}

async function appendRow(auth, values) {
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: "signup!A:E",
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
  return res.data;
}

// 讀 config!A1（整個 DB 的 JSON）
async function readConfig(auth) {
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "config!A:C",
  });
  const txt = (res.data.values && res.data.values[0] && res.data.values[0][0]) || "";
  return txt ? JSON.parse(txt) : {};
}

// 寫回 config!A:C
async function writeConfig(auth, obj) {
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SHEET_ID,
    range: "config!A:C",
    valueInputOption: "RAW",
    requestBody: { values: [[JSON.stringify(obj)]] },
  });
}

module.exports = { getAuth, appendRow, readConfig, writeConfig };
