const { google } = require("googleapis");

async function appendRow(auth, values) {
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: "signup!A:E", // 這裡換成你表單實際名稱與範圍
    valueInputOption: "RAW",
    requestBody: {
      values: [values],
    },
  });
  return res.data;
}

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return auth;
}

module.exports = { appendRow, getAuth };
