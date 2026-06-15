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
import readline from "readline-sync";
import fs from "fs";
import { timeout } from "puppeteer";
import { randomBytes } from "crypto";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import path from "path";


function delay(time) {
    return new Promise(function (resolve) {
        setTimeout(resolve, time)
    });
}

var global = {
    majsoul_free: true,
    first_majsoul_haihu: true,
    majsoulConn: null,
    nagaUsers: new NagaUserGroup(),
    contextIndex: 0,
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
        await create_naga_user_context(nagaUser, ws);
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
        await create_naga_user_context(user, ws);
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

const naga_request = (url, method, args, nagaUser) => {
    return new Promise((resolve, reject) => {
        let cookie_str = "";
        for (const cookie of nagaUser.cookies) {
            cookie_str += `${cookie.name}=${cookie.value}; `
        }
        cookie_str = cookie_str.slice(0, cookie_str.length - 2);
        console.log(cookie_str)
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
        console.log(axios_body.headers)
        axios(axios_body).then(resp => {
            resolve(resp);
        }).catch(err => {
            console.log(err.data)
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
        console.log(err);
        res.send({"status": 400, "message": err.toString() });
    }
})

global.app.post('/simple_login', async (req, res) => {
    const username = req.body.username;
    const password = req.body.password;
    const randomToken = randomBytes(32).toString('hex');
    console.log(`Simple login, username: ${username}, password: ${password}, token: ${randomToken}`)
    simple_login_majsoul(username, password, randomToken);
    res.send({ "status": 200, "token": randomToken });
})

global.app.get('/simple_login', async (req, res) => {
    const randomToken = req.query.token;
    try {
        await save_screenshot(randomToken);
        res.sendFile(`${randomToken}.png`, { root: './screenshots/' });
    } catch (e) {
        res.send({ "status": 404, "message": "error" });
    }
})

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
    if (global.browser)
    {
        const page_simple_login = await global.browser.newPage();
        await page_simple_login.evaluateOnNewDocument(() => {
            localStorage.clear();
            sessionStorage.clear();
        });
        await page_simple_login.goto("https://game.maj-soul.com/1/");
        console.log(`Try to login majsoul with username ${username} and password ${password}`)
        global.simple_pages[randomToken] = page_simple_login;
        await delay(3000);
        let timeout = 0;
        while (timeout < 180) {
            await delay(1000);
            timeout++;
            await page_simple_login.mouse.click(520, 210);
            const input = await page_simple_login.$("input")
            if (input) {
                console.log(`Simple login, inputing username and password`)
                await delay(500);
                await input.type(username)
                await page_simple_login.mouse.click(520, 255);
                await delay(500);
                const input_pw = await page_simple_login.$("input")
                await delay(500);
                await input_pw.type(password)

                const file = `${new Date().getTime()}.png`;
                await page_simple_login.screenshot({
                    path: file
                });
                break;
            }
        }
        await page_simple_login.mouse.click(520, 360);

        while (timeout < 300)
        {
            await delay(1000);
            timeout++;
            await page_simple_login.mouse.click(748, 165);
        }

        page_simple_login.close();
        console.log(`Simple login timeout, close this page`)
    }
    delete global.simple_pages[randomToken];
}

// Reuse a single logged-in gateway connection across requests; re-login on demand if it died.
async function getMajsoulConnection() {
    if (global.majsoulConn && global.majsoulConn.ws && global.majsoulConn.ws.readyState === WebSocket.OPEN) {
        return global.majsoulConn;
    }
    if (global.majsoulConn) {
        try { global.majsoulConn.close(); } catch (e) { /* ignore */ }
        global.majsoulConn = null;
    }
    const { conn, account_id } = await loginConnection(loginContext.majsoul_user, loginContext.majsoul_password);
    console.log(`Logged in to majsoul gateway, account_id: ${account_id}`);
    global.majsoulConn = conn;
    return conn;
}

async function parse_majsoul_url(url) {
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
        return {
            status: 200,
            message: binaryToUrls(majsoul_data)
        };
    } catch (e) {
        console.log(e);
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

async function create_naga_user_context(nagaUser, webSocket) {
    let newContext = global.browser.defaultBrowserContext();
    if (global.contextIndex > 0) {
        newContext = await global.browser.createIncognitoBrowserContext();
    }

    global.contextIndex++;

    const page_naga = await newContext.newPage();
    if (nagaUser.cookies) {
        for (const cookie of nagaUser.cookies) {
            await page_naga.setCookie(cookie);
        }
    }

    nagaUser.webPage = page_naga;

    try {
        await page_naga.goto('https://naga.dmv.nico/niconico/niconico_login/');

        if (page_naga.url().startsWith("https://account.nicovideo.jp/login")) {
            await page_naga.type('#input__mailtel', nagaUser.username)
            await page_naga.type('#input__password', nagaUser.password)
            await Promise.all([page_naga.click('#login__submit'), page_naga.waitForNavigation()])
        }

        // 2-step verification
        if (!page_naga.url().startsWith("https://naga.dmv.nico/")) {
            console.log("waiting for 2-step verification...")
            let code = "";
            try {
                await page_naga.type('#oneTimePw', code)
            } catch (e) {
                throw new Error("Incorrect username or password");
            }
            if (nagaUser.mail_imap != null) {
                await delay(5000); // wait for email to arrive
                const client = new ImapFlow(Object.assign({logger: false}, nagaUser.mail_imap));
                await client.connect()
                let lock = await client.getMailboxLock('INBOX');
                let message = await client.fetchOne('*', { source: true });
                let parsed = await simpleParser(message.source);
                const text = parsed.text.replace(/\n/g, '');
                lock.release();
                await client.logout();
                const regex = /あなたのアカウントへログインするには、以下の確認コードを入力してください。(\d+)/
                const match = text.match(regex);
                if (match && match.length >= 2) {
                    console.log("已从邮箱获取验证码，正在登录...")
                    code = match[1];
                } else {
                    code = readline.question("请查收您邮箱中的验证码，并输入：")
                }
            } else if (webSocket) {
                webSocket.send("request verify2")
                code = await webSocket.awaitForMessage(180);
            } else {
                code = readline.question("请查收您邮箱中的验证码，并输入：")
            }
            await page_naga.type('#oneTimePw', code)
            const btn = await page_naga.$(".loginBtn")
            await Promise.all([btn.click(), page_naga.waitForNavigation()])
        }

        if (page_naga.url().startsWith("https://naga.dmv.nico/")) {
            console.log(`NAGA USER ${nagaUser.username} 已登录`)
            nagaUser.cookies = await page_naga.cookies()
            nagaUser.login = true;
            if (global.nagaUsers.getByUsername(nagaUser.username) === undefined) {
                global.nagaUsers.users.push(nagaUser)
            }
            global.nagaUsers.save()
        } else {
            throw new Error("NAGA login failed");
        }
        if (webSocket) {
            webSocket.send("ok")
            webSocket.close()
        }
    } catch (e) {
        console.log(`NAGA USER ${nagaUser.username} 登录失败`)
        console.log(e)
        if (webSocket) {
            webSocket.send("failed")
            webSocket.send(e.toString())
            webSocket.close()
        }
    } finally {
        await page_naga.close();
        if (newContext !== global.browser.defaultBrowserContext()) await newContext.close();
    }
}

(async () => {
    const cachePath = path.join('.', 'puppeteer_cache');
    global.browser = await puppeteer.launch({headless: "new", args: ['--no-sandbox', '--proxy-server=http://localhost:10809', '--disk-cache-size=104857600'], userDataDir: cachePath});
    for (const user of global.nagaUsers.users) {
        await create_naga_user_context(user, null);
    }
})();
