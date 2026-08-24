import puppeteer from "puppeteer";
import {NagaUser, NagaUserGroup} from "./naga_user.js";
import {WebSocket, WebSocketServer} from "ws";
import {exit} from "process";
import moment from "moment-timezone";
import { binaryToUrls } from "./paipu_transfer.js";
import { loginConnection, fetchPaipuData } from "./majsoul_client.js";
import FormData from "form-data";
import md5 from "js-md5";
import axios from "axios";
import express from "express";
import fs from "fs";
import { timeout } from "puppeteer";
import { randomBytes } from "crypto";
import path from "path";
import * as nagaLogin from "./naga_login.js";


function delay(time) {
    return new Promise(function (resolve) {
        setTimeout(resolve, time)
    });
}

function makeLogger(prefix) {
    return (...args) => {
        const ts = moment().format("YYYY-MM-DD HH:mm:ss");
        console.log(`[${ts}] [${prefix}]`, ...args);
    };
}

// A stray rejection (a closed puppeteer page, a dropped socket) used to take the
// whole service down and with it any in-flight login session.
process.on('unhandledRejection', (reason) => {
    makeLogger('unhandledRejection')(reason);
});

var global = {
    majsoul_free: true,
    first_majsoul_haihu: true,
    majsoulConn: null,
    nagaUsers: new NagaUserGroup(),
    simple_pages: {},
    server: new WebSocketServer({port: 3166})
};

WebSocket.prototype.pushMessage = async function (message) {
    this.messageQueue = this.messageQueue || [];
    this.messageQueue.push(message);
}

WebSocket.prototype.awaitForMessage = async function (timeout = 30) {
    this.messageQueue = this.messageQueue || [];
    let time = 0;
    while (this.messageQueue.length === 0 && time < timeout * 10) {
        await delay(100);
        time++;
    }
    if (this.messageQueue.length > 0) {
        return this.messageQueue.shift();
    }
    this.close();
    throw new Error("await for message timeout");
}

global.server.on('connection', async function connection(ws, request) {
    ws.on('message', function message(data) {
       ws.pushMessage(data.toString());
    });
    if (request.url === '/new_naga_account')
    {
        ws.send("request username")
        const username = await ws.awaitForMessage();
        ws.send("request password")
        const password = await ws.awaitForMessage();
        ws.send("request secret")
        const secret = await ws.awaitForMessage();
        const nagaUser = new NagaUser(username, password, md5(secret));
        await create_naga_user_context(nagaUser, ws).done;
    }
    else if (request.url === '/login')
    {
        ws.send("request username")
        const username = await ws.awaitForMessage();
        const user = global.nagaUsers.getByUsername(username);
        if (user === undefined) {
            ws.send("user not found")
            ws.close();
            return;
        } else if (user.login) {
            ws.send("user is already logon")
            ws.close();
            return;
        }
        await create_naga_user_context(user, ws).done;
    }
    else
    {
        ws.close();
    }
})

if (!fs.existsSync("config.json")) {
    fs.writeFileSync("config.json", JSON.stringify({
        "majsoul_user": "", // user login to majsoul
        "majsoul_password": ""
    }))
    exit(0);
}

const loginContext = JSON.parse(fs.readFileSync("config.json").toString())

const SESSION_COOKIE = "naga-report-session-id";

function base_url() {
    return (loginContext.public_base_url || 'http://localhost:3165').replace(/\/$/, '');
}

function session_expiry(nagaUser) {
    const cookie = (nagaUser.cookies || []).find(c => c.name === SESSION_COOKIE);
    if (!cookie || !(cookie.expires > 0)) return null;
    return new Date(cookie.expires * 1000);
}

function days_until_expiry(nagaUser) {
    const expiry = session_expiry(nagaUser);
    if (expiry === null) return null;
    return (expiry.getTime() - Date.now()) / 86400000;
}

// NAGA rolls the session cookie forward on some responses; keep the stored copy
// in sync so the watchdog sees the real expiry (and so we re-login less often).
function merge_set_cookie(nagaUser, setCookieHeaders) {
    if (!setCookieHeaders || setCookieHeaders.length === 0) return false;
    let changed = false;
    for (const header of setCookieHeaders) {
        const [pair, ...attrs] = header.split(';');
        const index = pair.indexOf('=');
        if (index < 0) continue;
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        const expiresAttr = attrs.map(a => a.trim()).find(a => a.toLowerCase().startsWith('expires='));
        const expires = expiresAttr ? new Date(expiresAttr.slice(8)).getTime() / 1000 : undefined;

        const cookie = (nagaUser.cookies || []).find(c => c.name === name);
        if (cookie) {
            if (cookie.value !== value || (expires && cookie.expires !== expires)) {
                cookie.value = value;
                if (expires) cookie.expires = expires;
                changed = true;
            }
        } else {
            nagaUser.cookies.push({ name, value, domain: 'naga.dmv.nico', path: '/', expires: expires || -1 });
            changed = true;
        }
    }
    if (changed) global.nagaUsers.save();
    return changed;
}

const naga_request = (url, method, args, nagaUser) => {
    return new Promise((resolve, reject) => {
        const log = makeLogger('naga_request');
        let cookie_str = "";
        for (const cookie of nagaUser.cookies) {
            cookie_str += `${cookie.name}=${cookie.value}; `
        }
        cookie_str = cookie_str.slice(0, cookie_str.length - 2);
        log(cookie_str)
        const axios_body = {
            url: url,
            method: method,
            baseURL: 'https://naga.dmv.nico',
            ...args
        }
        axios_body.headers = axios_body.headers || {};
        axios_body.headers['Cookie'] = cookie_str;
        // axios_body.proxy = {
        //     protocol: 'http',
        //     host: '127.0.0.1',
        //     port: '10809'
        // }
        log(axios_body.headers)
        axios(axios_body).then(resp => {
            merge_set_cookie(nagaUser, resp.headers['set-cookie']);
            if (resp.data && resp.data.status === 401) {
                log(`NAGA USER ${nagaUser.username} 会话已失效，需要重新人工登录`);
                nagaUser.login = false;
            }
            resolve(resp);
        }).catch(err => {
            log(err.data)
            // nagaUser.login = false;
            reject(err);
        })
    });
}

global.app = express()

global.app.use(express.json())

global.app.all("*", function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "content-type");
    res.header("Access-Control-Allow-Methods", "DELETE,PUT,POST,GET,OPTIONS");
    if (req.method.toLowerCase() === 'options')
        res.send(200);
    else
        next();
});

global.app.get('/order_report_list', async (req, res) => {
    let promiseArray = [];
    for (const nagaUser of global.nagaUsers.users) {
        if (!nagaUser.login) continue;
        let cookie_str = "";
        for (const cookie of nagaUser.cookies) {
            cookie_str += `${cookie.name}=${cookie.value}; `
        }
        cookie_str = cookie_str.slice(0, cookie_str.length - 2);
        promiseArray.push(naga_request('/naga_report/api/order_report_list/', 'get', {
            params: {
                year: new Date().getFullYear(),
                month: new Date().getMonth() + 1
            }
        }, nagaUser));
    }
    const values = await Promise.allSettled(promiseArray);
    let resp = {
        "status": 200,
        "report": [],
        "order": []
    }
    // console.log(values)
    for (const result of values) {
        if (result.status === "fulfilled") {
            // console.log(result.value.data)
            resp.report.push(...result.value.data.report);
            resp.order.push(...result.value.data.order);
        }
    }
    res.send(resp);
})

global.app.post('/user_info', async (req, res) => {
    const secret = req.body.secret;
    const nagaUser = global.nagaUsers.getBySecret(md5(secret));
    if (nagaUser === undefined) {
        res.send({ "status": 400, "message": "secret error" })
        return;
    }
    res.send({
        "username": nagaUser.username
    });
})

global.app.post('/convert_majsoul', async (req, res) => {
    const secret = req.body.secret;
    const nagaUser = global.nagaUsers.getBySecret(md5(secret));
    if (nagaUser === undefined) {
        res.send({ "status": 400, "message": "secret error" })
        return;
    }
    res.send(await parse_majsoul_url(req.body.majsoul_url));
})

global.app.post('/order', async (req, res) => {
    const logger = makeLogger('/order');
    const secret = req.body.secret;
    const player_types = req.body.player_types;
    const nagaUser = global.nagaUsers.getBySecret(md5(secret));
    if (nagaUser === undefined) {
        res.send({ "status": 400, "message": "secret error" })
        return;
    }
    if (req.body.custom) {
        var haihus = req.body.haihus;
        var seat = 0;
    } else {
        var url = new URL(req.body.tenhou_url);
        var log = url.searchParams.get('log')
        var seat = url.searchParams.get('tw')
    }
    try {
        const formData = new FormData();
        if (req.body.custom) {
            formData.append('json_data', JSON.stringify(haihus));
            formData.append('game_type', 0);
        } else {
            formData.append('haihu_id', log);
            formData.append('reanalysis', 0);
        }
        formData.append('seat', seat);
        formData.append('player_types', player_types);
        for (const cookie of nagaUser.cookies) {
            if (cookie.name === "csrftoken") {
                formData.append('csrfmiddlewaretoken', cookie.value)
                break;
            }
        }
        const resp = await naga_request(req.body.custom ? 'naga_report/api/custom_haihu_analyze/' : '/naga_report/api/url_analyze/', 'post', {
            data: formData,
            headers: formData.getHeaders()
        }, nagaUser)
        res.send({
            "current": moment().tz("Asia/Tokyo").format("YYYY-MM-DDTHH:mm:ss"),
            ...resp.data
        })
    } catch (err) {
        logger(err);
        res.send({"status": 400, "message": err.toString() });
    }
})

global.app.post('/simple_login', async (req, res) => {
    const log = makeLogger('/simple_login');
    const username = req.body.username;
    const password = req.body.password;
    const randomToken = randomBytes(32).toString('hex');
    log(`Simple login, username: ${username}, password: ${password}, token: ${randomToken}`)
    simple_login_majsoul(username, password, randomToken);
    res.send({ "status": 200, "token": randomToken });
})

global.app.get('/simple_login', async (req, res) => {
    const randomToken = req.query.token;
    const log = makeLogger('/simple_login');
    try {
        res.sendFile(`${randomToken}.png`, { root: './screenshots/' });
    } catch (e) {
        log(e);
        res.send({ "status": 404, "message": "error" });
    }
})

// Accepts cookies harvested from a real browser: an array of cookie objects, a
// raw "a=b; c=d" header string, or {session_id, csrf_token}.
function normalize_cookies(input) {
    const mk = (name, value, extra = {}) => ({
        name, value,
        domain: extra.domain || 'naga.dmv.nico',
        path: extra.path || '/',
        expires: extra.expires ?? extra.expirationDate ?? -1
    });
    if (Array.isArray(input)) {
        return input.filter(c => c && c.name).map(c => mk(c.name, c.value, c));
    }
    if (typeof input === 'string') {
        return input.split(';').map(part => {
            const index = part.indexOf('=');
            if (index < 0) return null;
            return mk(part.slice(0, index).trim(), part.slice(index + 1).trim());
        }).filter(Boolean);
    }
    if (input && typeof input === 'object') {
        const cookies = [];
        if (input.session_id) cookies.push(mk(SESSION_COOKIE, input.session_id));
        if (input.csrf_token) cookies.push(mk('csrftoken', input.csrf_token));
        return cookies;
    }
    return [];
}

// Confirms the cookies actually authenticate before we store them.
async function verify_cookies(nagaUser) {
    const resp = await naga_request('/naga_report/api/order_report_list/', 'get', {
        params: { year: new Date().getFullYear(), month: new Date().getMonth() + 1 }
    }, nagaUser);
    return !(resp.data && resp.data.status === 401);
}

global.app.get('/import_cookies/ui', async (req, res) => {
    res.type('html').send(nagaLogin.renderImportUi());
});

global.app.post('/import_cookies', async (req, res) => {
    const log = makeLogger('/import_cookies');
    const nagaUser = global.nagaUsers.getBySecret(md5(req.body.secret || ''));
    if (nagaUser === undefined) {
        res.send({ "status": 400, "message": "secret error" });
        return;
    }
    const cookies = normalize_cookies(req.body.cookies ?? req.body);
    if (!cookies.some(c => c.name === SESSION_COOKIE)) {
        res.send({ "status": 400, "message": `cookies must include ${SESSION_COOKIE}` });
        return;
    }
    const previous = nagaUser.cookies;
    nagaUser.cookies = cookies;
    try {
        if (!await verify_cookies(nagaUser)) {
            nagaUser.cookies = previous;
            res.send({ "status": 401, "message": "cookie 无效或已过期，请在浏览器中重新登录后再导入" });
            return;
        }
    } catch (e) {
        nagaUser.cookies = previous;
        res.send({ "status": 400, "message": e.toString() });
        return;
    }
    nagaUser.login = true;
    global.nagaUsers.save();
    const expiry = session_expiry(nagaUser);
    log(`NAGA USER ${nagaUser.username} 已通过导入 cookie 登录`);
    res.send({
        "status": 200,
        "username": nagaUser.username,
        "expires_at": expiry?.toISOString() || null,
        "days_left": days_until_expiry(nagaUser)
    });
});

// --- human-in-the-loop NAGA login (Cloudflare Turnstile on the niconico page) ---

function resolve_login_session(req, res) {
    const token = req.body?.token || req.query?.token;
    const session = nagaLogin.getSession(token);
    if (session === undefined) {
        res.status(404).send({ "status": 404, "message": "login session not found or expired" });
        return null;
    }
    return session;
}

global.app.post('/naga_login', async (req, res) => {
    const log = makeLogger('/naga_login');
    const nagaUser = global.nagaUsers.getBySecret(md5(req.body.secret || ''));
    if (nagaUser === undefined) {
        res.send({ "status": 400, "message": "secret error" });
        return;
    }
    const session = create_naga_user_context(nagaUser, null);
    log(`已为 ${nagaUser.username} 创建人工登录会话`);
    res.send({
        "status": 200,
        "token": session.token,
        "url": nagaLogin.relayUrl(base_url(), session.token)
    });
});

global.app.get('/naga_login/ui', async (req, res) => {
    const session = nagaLogin.getSession(req.query.token);
    if (session === undefined) {
        // Relay tokens die with the process; send stale links somewhere useful
        // instead of a bare JSON 404.
        res.status(404).type('html').send(`<!doctype html><meta charset="utf-8">
<title>登录会话已失效</title>
<body style="font-family:system-ui,sans-serif;background:#1c1c1e;color:#eee;padding:24px">
<h1 style="font-size:18px">登录会话已失效</h1>
<p style="color:#ccc;font-size:14px;line-height:1.8">中继链接里的 token 在服务重启后就失效了。<br>
服务器 IP 上的 Cloudflare 验证本来也过不了，请改用导入 cookie：</p>
<p><a href="/import_cookies/ui" style="color:#0a84ff;font-size:16px">前往导入 Cookie →</a></p>
</body>`);
        return;
    }
    res.type('html').send(nagaLogin.renderUi(session.token));
});

global.app.get('/naga_login/screenshot', async (req, res) => {
    const session = resolve_login_session(req, res);
    if (!session) return;
    try {
        const buffer = await nagaLogin.screenshot(session);
        if (!buffer) {
            res.status(404).send({ "status": 404, "message": "page is closed" });
            return;
        }
        res.set('Cache-Control', 'no-store').type('png').send(buffer);
    } catch (e) {
        res.status(500).send({ "status": 500, "message": e.toString() });
    }
});

global.app.get('/naga_login/status', async (req, res) => {
    const session = resolve_login_session(req, res);
    if (!session) return;
    res.send({ "status": 200, "state": session.state, "message": session.message });
});

global.app.post('/naga_login/click', async (req, res) => {
    const session = resolve_login_session(req, res);
    if (!session) return;
    try {
        await nagaLogin.relayClick(session, Number(req.body.x), Number(req.body.y));
        res.send({ "status": 200 });
    } catch (e) {
        res.send({ "status": 400, "message": e.toString() });
    }
});

global.app.post('/naga_login/type', async (req, res) => {
    const session = resolve_login_session(req, res);
    if (!session) return;
    try {
        await nagaLogin.relayType(session, String(req.body.text || ''));
        res.send({ "status": 200 });
    } catch (e) {
        res.send({ "status": 400, "message": e.toString() });
    }
});

global.app.post('/naga_login/key', async (req, res) => {
    const session = resolve_login_session(req, res);
    if (!session) return;
    try {
        await nagaLogin.relayKey(session, String(req.body.key || 'Enter'));
        res.send({ "status": 200 });
    } catch (e) {
        res.send({ "status": 400, "message": e.toString() });
    }
});

global.app.get('/session_status', async (req, res) => {
    res.send({
        "status": 200,
        "users": global.nagaUsers.users.map(user => ({
            "username": user.username,
            "login": user.login,
            "expires_at": session_expiry(user)?.toISOString() || null,
            "days_left": days_until_expiry(user)
        }))
    });
});

global.app.get('/shutdown', async (req, res) => {
    if (req.query.token === loginContext.shutdown_token) {
        res.send({ "status": 200, "message": "shutdown" });
        exit(0);
    }
    else {
        res.send({ "status": 400, "message": "error" });
    }
});

global.app.listen(3165, () => {

});

async function save_screenshot(randomToken) {
    const file = `screenshots/${randomToken}.png`;
    if (global.simple_pages[randomToken]) {
        await global.simple_pages[randomToken].screenshot({
            path: file
        });
    }
}

async function simple_login_majsoul(username, password, randomToken)
{
    const log = makeLogger('simple_login_majsoul');
    if (global.browser)
    {
        const page_simple_login = await global.browser.newPage();
        await page_simple_login.evaluateOnNewDocument(() => {
            localStorage.clear();
            sessionStorage.clear();
        });
        await page_simple_login.goto("https://game.maj-soul.com/1/");
        log(`Try to login majsoul with username ${username} and password ${password}`)
        global.simple_pages[randomToken] = page_simple_login;
        await delay(3000);
        const startTime = Date.now();
        const elapsed = () => (Date.now() - startTime) / 1000;
        while (elapsed() < 180) {
            await delay(1000);
            await save_screenshot(randomToken);
            await page_simple_login.mouse.click(520, 210);
            const input = await page_simple_login.$("input")
            if (input) {
                log(`Simple login, inputing username and password`)
                await delay(500);
                await input.type(username)
                let input_pw = null;
                while (input_pw === null && elapsed() < 180) {
                    await page_simple_login.mouse.click(520, 255);
                    await delay(500);
                    input_pw = await page_simple_login.$("input")
                    await delay(500);
                }
                await input_pw.type(password)
                await save_screenshot(randomToken);
                break;
            }
        }
        await page_simple_login.mouse.click(520, 360);

        while (elapsed() < 300)
        {
            await delay(3000);
            await save_screenshot(randomToken);
            await page_simple_login.mouse.click(748, 165);
        }

        // save before close
        await save_screenshot(randomToken); 
        page_simple_login.close();
        log(`Simple login timeout, close this page`)
    }
    delete global.simple_pages[randomToken];
}

// Reuse a single logged-in gateway connection across requests; re-login on demand if it died.
async function getMajsoulConnection() {
    const log = makeLogger('getMajsoulConnection');
    if (global.majsoulConn && global.majsoulConn.ws && global.majsoulConn.ws.readyState === WebSocket.OPEN) {
        return global.majsoulConn;
    }
    if (global.majsoulConn) {
        try { global.majsoulConn.close(); } catch (e) { /* ignore */ }
        global.majsoulConn = null;
    }
    const { conn, account_id } = await loginConnection(loginContext.majsoul_user, loginContext.majsoul_password);
    log(`Logged in to majsoul gateway, account_id: ${account_id}`);
    global.majsoulConn = conn;
    return conn;
}

async function parse_majsoul_url(url) {
    const log = makeLogger('parse_majsoul_url');
    // url is the share string, e.g. ".../?paipu=<uuid>_<token>"; extract the paipu value.
    let paipu;
    try {
        paipu = new URL(url).searchParams.get("paipu");
    } catch (e) {
        paipu = null;
    }
    if (!paipu) {
        // also accept a bare uuid / "uuid_token" passed directly
        const m = String(url).match(/paipu=([^&]+)/);
        paipu = m ? decodeURIComponent(m[1]) : String(url);
    }
    if (!paipu) {
        return { status: 400, message: "URL is not correct" };
    }

    try {
        const conn = await getMajsoulConnection();
        const majsoul_data = await fetchPaipuData(conn, paipu);
        log(`Fetched majsoul data for paipu ${paipu}`);
        return {
            status: 200,
            message: binaryToUrls(majsoul_data)
        };
    } catch (e) {
        log(e);
        // drop the (possibly broken) connection so the next request re-logs-in
        if (global.majsoulConn) {
            try { global.majsoulConn.close(); } catch (err) { /* ignore */ }
            global.majsoulConn = null;
        }
        return {
            status: 400,
            message: e.toString()
        };
    }
}

// The niconico login page is now protected by Cloudflare Turnstile, so this can
// no longer run unattended: it opens the page, fills the credentials, and then
// hands a relay URL to a human who ticks the checkbox and submits the form.
// Returns the login session -- await `session.done` to wait for the outcome.
function create_naga_user_context(nagaUser, webSocket) {
    const log = makeLogger('naga_login');
    const session = nagaLogin.startLogin(global.browser, nagaUser, {
        log,
        webSocket,
        onSaved: (user) => {
            if (global.nagaUsers.getByUsername(user.username) === undefined) {
                global.nagaUsers.users.push(user);
            }
            global.nagaUsers.save();
        }
    });
    log(`NAGA USER ${nagaUser.username} 需要人工完成 Cloudflare 验证，请打开：${nagaLogin.relayUrl(base_url(), session.token)}`);
    if (webSocket) {
        webSocket.send(JSON.stringify({
            action: "human_login_required",
            url: nagaLogin.relayUrl(base_url(), session.token)
        }));
    }
    return session;
}

// Poke the API so a rolling session cookie gets refreshed, and warn well before
// the session expires -- re-logging in needs a human now, so it should never be
// a surprise discovered by a failing /order.
const WARN_DAYS = 3;

async function session_watchdog() {
    const log = makeLogger('session_watchdog');
    for (const user of global.nagaUsers.users) {
        const days = days_until_expiry(user);
        if (!user.login) {
            log(`NAGA USER ${user.username} 未登录，请打开 ${base_url()}/import_cookies/ui 导入浏览器 cookie`);
            continue;
        }
        try {
            await naga_request('/naga_report/api/order_report_list/', 'get', {
                params: { year: new Date().getFullYear(), month: new Date().getMonth() + 1 }
            }, user);
        } catch (e) {
            log(`NAGA USER ${user.username} keepalive 请求失败: ${e.toString()}`);
        }
        const daysAfter = days_until_expiry(user);
        if (daysAfter !== null && days !== null && daysAfter > days + 0.5) {
            log(`NAGA USER ${user.username} 会话有效期已顺延至 ${session_expiry(user).toISOString()}`);
        }
        if (daysAfter !== null && daysAfter < WARN_DAYS) {
            log(`⚠ NAGA USER ${user.username} 的会话将在 ${daysAfter.toFixed(1)} 天后过期，请尽快调用 POST /naga_login 重新登录`);
        }
    }
}

(async () => {
    const log = makeLogger('startup');
    const cachePath = path.join('.', 'puppeteer_cache');
    // A hard crash leaves these behind and every later launch aborts with
    // "Failed to create a ProcessSingleton", which would wedge run_forever.sh.
    for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        try {
            fs.rmSync(path.join(cachePath, lock), { force: true });
        } catch (e) { /* ignore */ }
    }
    const args = ['--no-sandbox', '--disk-cache-size=104857600'];
    // keeps the previous hardcoded proxy as the default; set to null to disable
    const proxy = loginContext.proxy_server === undefined ? 'http://localhost:10809' : loginContext.proxy_server;
    if (proxy) args.push(`--proxy-server=${proxy}`);
    global.browser = await puppeteer.launch({
        headless: loginContext.headless === undefined ? "new" : loginContext.headless,
        args,
        userDataDir: cachePath
    });
    for (const user of global.nagaUsers.users) {
        // Ask NAGA whether the stored cookies still work rather than trusting a
        // stored expiry -- imported cookies may not carry one at all.
        let alive = false;
        if ((user.cookies || []).some(c => c.name === SESSION_COOKIE)) {
            try {
                alive = await verify_cookies(user);
            } catch (e) {
                log(`NAGA USER ${user.username} 会话检查失败: ${e.toString()}`);
            }
        }
        user.login = alive;
        if (alive) {
            const days = days_until_expiry(user);
            log(`NAGA USER ${user.username} 复用已保存的会话${days === null ? '' : `，剩余 ${days.toFixed(1)} 天`}`);
        } else {
            log(`NAGA USER ${user.username} 会话不可用，请在本机浏览器登录 https://naga.dmv.nico/ 后导入 cookie（POST /import_cookies，或运行 node local_login.js）`);
        }
    }
    await session_watchdog();
    setInterval(session_watchdog, 6 * 3600 * 1000);
})();
