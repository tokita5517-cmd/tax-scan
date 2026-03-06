/*********************************************************
 * Excel / OneDrive 同期モジュール
 * - スマホ単体機能は維持
 * - 未同期分だけまとめて送信
 * - Microsoft Graph Excel rows/add を使用
 *********************************************************/

// ====== 設定 ======
const GRAPH_SCOPES = ["Files.ReadWrite", "User.Read"];
const MSAL_CONFIG = {
  auth: {
    clientId: "YOUR_CLIENT_ID_HERE", // ← Microsoft Entra のアプリ登録で取得
    authority: "https://login.microsoftonline.com/common",
    redirectUri: window.location.origin + window.location.pathname
  },
  cache: {
    cacheLocation: "localStorage",
    storeAuthStateInCookie: false
  }
};

const SYNC_STORAGE_KEY = "invoice-sync-settings-v1";

// ====== 状態追加 ======
state.sync = {
  account: null,
  fileId: "",
  tableName: "InvoiceTable",
  lastSyncAt: null,
  syncing: false
};

// ====== MSAL ======
const msalInstance = new msal.PublicClientApplication(MSAL_CONFIG);

async function initMsalAccount() {
  try {
    const result = await msalInstance.handleRedirectPromise();
    if (result && result.account) {
      msalInstance.setActiveAccount(result.account);
      state.sync.account = result.account;
    } else {
      const accounts = msalInstance.getAllAccounts();
      if (accounts.length > 0) {
        msalInstance.setActiveAccount(accounts[0]);
        state.sync.account = accounts[0];
      }
    }
  } catch (e) {
    console.error("MSAL init error", e);
    setScanStatus("Microsoft認証初期化エラー", "err");
  }
}

async function signInMicrosoft() {
  try {
    const loginResult = await msalInstance.loginPopup({
      scopes: GRAPH_SCOPES,
      prompt: "select_account"
    });
    msalInstance.setActiveAccount(loginResult.account);
    state.sync.account = loginResult.account;
    saveSyncSettings();
    setDupStatus(`ログイン: ${loginResult.account.username}`, "ok");
  } catch (e) {
    console.error("login error", e);
    setDupStatus("Microsoftログイン失敗", "err");
  }
}

async function getGraphAccessToken() {
  const account = msalInstance.getActiveAccount();
  if (!account) {
    throw new Error("Microsoft未ログイン");
  }

  try {
    const tokenResult = await msalInstance.acquireTokenSilent({
      account,
      scopes: GRAPH_SCOPES
    });
    return tokenResult.accessToken;
  } catch (e) {
    const tokenResult = await msalInstance.acquireTokenPopup({
      account,
      scopes: GRAPH_SCOPES
    });
    return tokenResult.accessToken;
  }
}

// ====== 同期設定 ======
function saveSyncSettings() {
  localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify({
    fileId: state.sync.fileId,
    tableName: state.sync.tableName,
    lastSyncAt: state.sync.lastSyncAt,
    accountUsername: state.sync.account?.username || ""
  }));
}

function loadSyncSettings() {
  const raw = localStorage.getItem(SYNC_STORAGE_KEY);
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    state.sync.fileId = data.fileId || "";
    state.sync.tableName = data.tableName || "InvoiceTable";
    state.sync.lastSyncAt = data.lastSyncAt || null;
  } catch (e) {
    console.error("loadSyncSettings error", e);
  }
}

function openSyncSettingPrompt() {
  const fileId = prompt("OneDrive上のExcel fileIdを入力", state.sync.fileId || "");
  if (
