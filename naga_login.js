import { randomBytes } from "crypto";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

// The niconico login page now carries a Cloudflare Turnstile widget, so the
// login step can no longer run unattended. This module opens the login page in
// the shared browser, fills in the credentials, and then relays screenshots to a
// human who ticks the checkbox and presses the login button themselves. Once the
// session cookie is in hand every other NAGA call keeps running unattended as
// before -- naga.dmv.nico itself is not behind Cloudflare.

const NAGA_LOGIN_URL = 'https://naga.dmv.nico/niconico/niconico_login/';
const VIEWPORT = { width: 900, height: 800 };
const HUMAN_TIMEOUT = 15 * 60 * 1000;

// The login page was rewritten as an SPA; keep the legacy ids as a fallback.
const USERNAME_SELECTORS = ['input[name=mailOrTel]', '#input__mailtel'];
const PASSWORD_SELECTORS = ['input[name=password]', '#input__password'];
const OTP_SELECTORS = ['#oneTimePw', 'input[name=otp]', 'input[name=oneTimePw]'];
const SUBMIT_SELECTORS = ['.loginBtn', 'button[type=submit]'];

export const sessions = new Map();

function delay(time) {
    return new Promise(resolve => setTimeout(resolve, time));
}

async function firstMatch(page, selectors) {
    for (const selector of selectors) {
        // The login SPA re-renders while we poll, which detaches frames; a miss
        // here just means "not on that screen yet".
        const el = await page.$(selector).catch(() => null);
        if (el) return { el, selector };
    }
    return null;
}

class LoginSession {
    constructor(user) {
        this.token = randomBytes(24).toString('hex');
        this.user = user;
        this.state = 'starting';
        this.message = '正在打开登录页…';
        this.page = null;
        this.context = null;
        this.startedAt = Date.now();
    }

    get expired() {
        return Date.now() - this.startedAt > HUMAN_TIMEOUT;
    }

    set(state, message) {
        this.state = state;
        this.message = message;
    }
}

export function getSession(token) {
    return sessions.get(token);
}

export async function screenshot(session) {
    if (!session.page || session.page.isClosed()) return null;
    try {
        // puppeteer 23 hands back a Uint8Array; express would JSON-encode that.
        return Buffer.from(await session.page.screenshot({ type: 'png' }));
    } catch (e) {
        // page/browser went away between the check and the capture
        return null;
    }
}

// Forward a click made by the human in their own browser. Nothing in this file
// clicks the Turnstile widget on its own -- the coordinates always come from a
// real person looking at the relayed screenshot.
export async function relayClick(session, x, y) {
    if (!session.page || session.page.isClosed()) throw new Error("login page is closed");
    await session.page.mouse.move(x, y);
    await session.page.mouse.click(x, y);
}

export async function relayType(session, text) {
    if (!session.page || session.page.isClosed()) throw new Error("login page is closed");
    await session.page.keyboard.type(text, { delay: 40 });
}

export async function relayKey(session, key) {
    if (!session.page || session.page.isClosed()) throw new Error("login page is closed");
    await session.page.keyboard.press(key);
}

async function fetchCodeFromMail(mail_imap, log) {
    await delay(5000); // wait for the mail to arrive
    const client = new ImapFlow(Object.assign({ logger: false }, mail_imap));
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let text;
    try {
        const message = await client.fetchOne('*', { source: true });
        const parsed = await simpleParser(message.source);
        text = parsed.text.replace(/\n/g, '');
    } finally {
        lock.release();
        await client.logout();
    }
    const match = text.match(/あなたのアカウントへログインするには、以下の確認コードを入力してください。(\d+)/);
    if (match && match.length >= 2) {
        log("已从邮箱获取验证码");
        return match[1];
    }
    return null;
}

async function fillCredentials(session, log) {
    const { page, user } = session;
    const username = await firstMatch(page, USERNAME_SELECTORS);
    const password = await firstMatch(page, PASSWORD_SELECTORS);
    if (!username || !password) {
        throw new Error("找不到登录表单输入框，登录页结构可能又改了");
    }
    await username.el.click({ clickCount: 3 });
    await username.el.type(user.username, { delay: 30 });
    await password.el.click({ clickCount: 3 });
    await password.el.type(user.password, { delay: 30 });
    log(`已填入账号 ${user.username}，等待人工完成 Cloudflare 验证`);
}

async function handleTwoStep(session, log, webSocket) {
    const { page, user } = session;
    // Only after the credential screen is behind us, so we never mistake a field
    // on the login form for the one-time-password box.
    if (await firstMatch(page, PASSWORD_SELECTORS)) return false;
    const otp = await firstMatch(page, OTP_SELECTORS);
    if (!otp) return false;

    let code = null;
    if (user.mail_imap) {
        session.set('two_step', '正在从邮箱读取验证码…');
        try {
            code = await fetchCodeFromMail(user.mail_imap, log);
        } catch (e) {
            log("读取邮箱验证码失败:", e.toString());
        }
    }
    if (!code && webSocket) {
        try {
            webSocket.send("request verify2");
            code = await webSocket.awaitForMessage(180);
        } catch (e) {
            log("等待 websocket 验证码超时");
        }
    }
    if (!code) {
        // Leave it to the human on the relay page; they can type the code into
        // the field they can see and press the button themselves.
        session.set('await_code', '需要邮箱验证码：请在下方输入框填入验证码后按发送，再点击登录按钮');
        return true;
    }

    await otp.el.click({ clickCount: 3 });
    await otp.el.type(code, { delay: 30 });
    const submit = await firstMatch(page, SUBMIT_SELECTORS);
    if (submit) await submit.el.click();
    session.set('await_human', '已自动填入验证码，若页面未跳转请手动点击登录按钮');
    return true;
}

async function runLogin(session, browser, opts) {
    const { log, onSaved, webSocket } = opts;
    const user = session.user;
    let context = null;
    try {
        context = await browser.createBrowserContext();
        session.context = context;
        const page = await context.newPage();
        session.page = page;
        await page.setViewport(VIEWPORT);

        for (const cookie of user.cookies || []) {
            try {
                await page.setCookie(cookie);
            } catch (e) { /* stale cookie, ignore */ }
        }

        await page.goto(NAGA_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        // Existing cookies may still be good, in which case no human is needed.
        if (page.url().startsWith('https://naga.dmv.nico/')) {
            log(`NAGA USER ${user.username} 使用已有 cookie 直接登录成功`);
        } else {
            await fillCredentials(session, log);
            session.set('await_human', '请在下方页面中勾选 Cloudflare 的「Verify you are human」，然后点击 ログイン 按钮');

            let twoStepDone = false;
            let landed = false;
            while (!session.expired) {
                await delay(1000);
                if (page.isClosed()) throw new Error("登录页已被关闭");
                try {
                    if (page.url().startsWith('https://naga.dmv.nico/')) { landed = true; break; }
                    if (!twoStepDone) {
                        twoStepDone = await handleTwoStep(session, log, webSocket);
                    }
                } catch (e) {
                    // navigation mid-poll detaches frames; retry on the next tick
                    log(`登录页轮询忽略了一个瞬时错误: ${e.toString()}`);
                }
            }
            if (!landed) {
                throw new Error("等待人工登录超时");
            }
        }

        user.cookies = await page.cookies();
        user.login = true;
        onSaved(user);
        session.set('ok', `登录成功，${user.username} 的 cookie 已保存`);
        log(`NAGA USER ${user.username} 已登录`);
        if (webSocket) {
            webSocket.send("ok");
            webSocket.close();
        }
    } catch (e) {
        session.set('failed', e.toString());
        log(`NAGA USER ${user.username} 登录失败: ${e.toString()}`);
        if (webSocket) {
            webSocket.send("failed");
            webSocket.send(e.toString());
            webSocket.close();
        }
    } finally {
        // Keep the finished page around briefly so the human sees the result.
        setTimeout(async () => {
            try {
                if (session.page && !session.page.isClosed()) await session.page.close();
                if (context) await context.close();
            } catch (e) { /* ignore */ }
            sessions.delete(session.token);
        }, 20000);
    }
}

// Starts a login attempt and returns immediately with the session, so the caller
// can hand the relay URL to a human. Await `session.done` for the outcome.
export function startLogin(browser, user, opts) {
    const session = new LoginSession(user);
    sessions.set(session.token, session);
    session.done = runLogin(session, browser, opts);
    return session;
}

export function relayUrl(baseUrl, token) {
    return `${baseUrl.replace(/\/$/, '')}/naga_login/ui?token=${token}`;
}

// Turnstile grades the browser environment and exit IP, so the login itself has
// to happen in a real browser on a normal connection. This page is how the
// resulting session cookie gets from there to the server.
export function renderImportUi() {
    return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NAGA 导入 Cookie</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; background: #1c1c1e; color: #eee; }
  .box { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 18px; }
  ol { line-height: 1.9; color: #ccc; font-size: 14px; padding-left: 20px; }
  code { background: #2c2c2e; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  label { display: block; margin: 14px 0 6px; font-size: 14px; }
  input, textarea { width: 100%; box-sizing: border-box; background: #2c2c2e; color: #eee;
    border: 1px solid #555; border-radius: 6px; padding: 10px; font-size: 14px; font-family: ui-monospace, monospace; }
  textarea { height: 110px; resize: vertical; }
  button { margin-top: 14px; background: #0a84ff; color: #fff; border: none; border-radius: 6px;
    padding: 10px 18px; font-size: 15px; cursor: pointer; }
  #result { margin-top: 16px; font-size: 14px; white-space: pre-wrap; }
</style>
</head>
<body>
<div class="box">
<h1>NAGA 导入 Cookie</h1>
<ol>
  <li>在<b>你自己电脑的浏览器</b>里打开 <code>https://naga.dmv.nico/</code> 并正常登录（含 Cloudflare 验证）。</li>
  <li>按 F12 打开开发者工具 → <code>Application</code>（应用）→ 左侧 <code>Cookies</code> → <code>https://naga.dmv.nico</code>。</li>
  <li>复制 <code>naga-report-session-id</code> 的值，填到下面；<code>csrftoken</code> 也一并复制（下单接口要用）。</li>
</ol>
<label>Secret</label>
<input id="secret" type="password" placeholder="你的 secret">
<label>naga-report-session-id</label>
<input id="session" placeholder="粘贴 session id">
<label>csrftoken</label>
<input id="csrf" placeholder="粘贴 csrftoken">
<label>或者：直接粘贴整段 cookie / JSON 数组（填了这里就忽略上面两栏）</label>
<textarea id="raw" placeholder="naga-report-session-id=xxx; csrftoken=yyy"></textarea>
<button onclick="submit()">导入并验证</button>
<div id="result"></div>
</div>
<script>
async function submit() {
  const out = document.getElementById('result');
  const raw = document.getElementById('raw').value.trim();
  let cookies;
  if (raw) {
    try { cookies = JSON.parse(raw); } catch (e) { cookies = raw; }
  } else {
    cookies = {
      session_id: document.getElementById('session').value.trim(),
      csrf_token: document.getElementById('csrf').value.trim()
    };
  }
  out.style.color = '#999';
  out.textContent = '正在向 NAGA 验证…';
  try {
    const r = await fetch('/import_cookies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: document.getElementById('secret').value, cookies })
    });
    const j = await r.json();
    out.style.color = j.status === 200 ? '#4ade80' : '#f87171';
    out.textContent = j.status === 200
      ? '导入成功：' + j.username + (j.days_left === null ? '' : '，有效期约 ' + j.days_left.toFixed(1) + ' 天')
      : '失败：' + (j.message || JSON.stringify(j));
  } catch (e) {
    out.style.color = '#f87171';
    out.textContent = '请求失败：' + e;
  }
}
</script>
</body>
</html>`;
}

export function renderUi(token) {
    return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NAGA 人工登录</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: #1c1c1e; color: #eee; }
  h1 { font-size: 16px; margin: 0 0 8px; }
  #status { font-size: 14px; margin-bottom: 12px; color: #ffd479; min-height: 20px; }
  #screen { max-width: 100%; border: 1px solid #444; cursor: crosshair; display: block; background: #fff; }
  .row { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
  input, button { font-size: 15px; padding: 8px 12px; border-radius: 6px; border: 1px solid #555; }
  input { background: #2c2c2e; color: #eee; flex: 1 1 200px; }
  button { background: #0a84ff; color: #fff; border: none; cursor: pointer; }
  .hint { font-size: 13px; color: #999; margin-top: 10px; line-height: 1.6; }
</style>
</head>
<body>
<h1>NAGA 人工登录</h1>
<div id="status">连接中…</div>
<img id="screen" alt="登录页面">
<div class="row">
  <input id="text" placeholder="需要输入文字/验证码时填这里">
  <button onclick="sendText()">发送</button>
  <button onclick="sendKey('Enter')">回车</button>
</div>
<p class="hint">
  账号密码已自动填好。你只需要：<b>点一下 Cloudflare 的复选框</b>，等它变成绿勾，再<b>点击 ログイン 按钮</b>。<br>
  直接点击上面的画面即可，点击会原样转发到服务器上的浏览器。画面每秒刷新一次。
</p>
<script>
const token = ${JSON.stringify(token)};
const img = document.getElementById('screen');
const statusEl = document.getElementById('status');
let busy = false;

async function refresh() {
  if (!busy) {
    busy = true;
    try {
      const r = await fetch('/naga_login/screenshot?token=' + token + '&t=' + Date.now());
      if (r.ok) {
        const blob = await r.blob();
        const old = img.src;
        img.src = URL.createObjectURL(blob);
        if (old.startsWith('blob:')) URL.revokeObjectURL(old);
      }
    } catch (e) { /* keep trying */ }
    busy = false;
  }
  setTimeout(refresh, 1000);
}

async function poll() {
  try {
    const r = await fetch('/naga_login/status?token=' + token);
    const j = await r.json();
    statusEl.textContent = '[' + j.state + '] ' + j.message;
  } catch (e) {
    statusEl.textContent = '会话已结束';
  }
  setTimeout(poll, 2000);
}

img.addEventListener('click', async (e) => {
  const rect = img.getBoundingClientRect();
  const x = Math.round((e.clientX - rect.left) * (img.naturalWidth / rect.width));
  const y = Math.round((e.clientY - rect.top) * (img.naturalHeight / rect.height));
  await fetch('/naga_login/click', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, x, y })
  });
});

async function sendText() {
  const el = document.getElementById('text');
  if (!el.value) return;
  await fetch('/naga_login/type', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, text: el.value })
  });
  el.value = '';
}

async function sendKey(key) {
  await fetch('/naga_login/key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, key })
  });
}

refresh();
poll();
</script>
</body>
</html>`;
}
