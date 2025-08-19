const { google } = require("googleapis");

async function appendRow(auth, values) {
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,   // ← 你在 Render 設的變數
    range: "signup!A:E",                   // ← 你的表單分頁與欄位範圍
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
  return res.data;
}

function getAuthFromEnv() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return auth;
}

module.exports = { appendRow, getAuthFromEnv };
