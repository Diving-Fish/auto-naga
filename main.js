import puppeteer from "puppeteer";
import {NagaUser, NagaUserGroup} from "./naga_user.js";
import {WebSocket, WebSocketServer} from "ws";
import {exit} from "process";
import moment from "moment-timezone";
import { binaryToUrls } from "./paipu_transfer.js";
import FormData from "form-data";
import md5 from "js-md5";
import axios from "axios";
import express from "express";
import readline from "readline-sync";
import fs from "fs";


function delay(time) {
    return new Promise(function (resolve) {
        setTimeout(resolve, time)
    });
}

var global = {
    majsoul_free: true,
    first_majsoul_haihu: true,
    nagaUsers: new NagaUserGroup(),
    contextIndex: 0,
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
        const axios_body = {
            url: url,
            method: method,
            baseURL: 'https://naga.dmv.nico',
            ...args
        }
        axios_body.headers = axios_body.headers || {};
        axios_body.headers['cookie'] = cookie_str;
        axios(axios_body).then(resp => {
            resolve(resp);
        }).catch(err => {
            nagaUser.login = false;
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
    for (const result of values) {
        if (result.status === "fulfilled") {
            resp.report.push(...result.value.data.report);
            resp.order.push(...result.value.data.order);
        }
    }
    res.send(resp);
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
        }
        formData.append('seat', seat);
        formData.append('reanalysis', 0);
        formData.append('player_type', 2);
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
        res.send({"status": 400 });
    }
})

global.app.listen(3165, () => {

});

async function parse_majsoul_url(url) {
    if (global.browser && global.majsoul_free) {
        const page_majsoul = await global.browser.newPage();
        try {
            global.majsoul_free = false;

            await page_majsoul.goto(url);

            if (!page_majsoul.url().startsWith("https://game.maj-soul.com/1/")) {
                global.majsoul_free = true;
                await page_majsoul.close();
                return {
                    status: 400,
                    message: "URL is not correct"
                }
            }
            var timeout = 0;

            while (timeout < 60 && global.first_majsoul_haihu) {
                await delay(1000);
                timeout++;
                await page_majsoul.mouse.click(520, 210);
                const input = await page_majsoul.$("input")
                if (input) {
                    await delay(500);
                    await input.type(loginContext.majsoul_user)
                    await page_majsoul.mouse.click(520, 255);
                    await delay(500);
                    const input_pw = await page_majsoul.$("input")
                    await delay(500);
                    await input_pw.type(loginContext.majsoul_password)
                    global.first_majsoul_haihu = false;
                    break;
                }
            }
            await page_majsoul.mouse.click(520, 360);

            global.majsoul_data = false;

            while (!global.majsoul_data && timeout < 60) {
                await delay(1000);
                timeout++;
                global.majsoul_data = await page_majsoul.evaluate(async () => {
                    return await new Promise((resolve, reject) => {
                        if (this['GameMgr'] === undefined || GameMgr.Inst.record_uuid === '') {
                            resolve(false);
                            return;
                        }
                        app.NetAgent.sendReq2Lobby(
                            "Lobby",
                            "fetchGameRecord",
                            { game_uuid: GameMgr.Inst.record_uuid, client_version_string: GameMgr.Inst.getClientVersion() },
                            (i, record) => {
                                var mjslog = [];
                                var mjsact = net.MessageWrapper.decodeMessage(record.data).actions;
                                mjsact.forEach(e => {
                                    if (e.result.length !== 0) mjslog.push(net.MessageWrapper.decodeMessage(e.result));
                                    mjslog.forEach(e => { e.cname = e.constructor.name }); // 传回来的 object 没有 prototype 信息
                                    resolve({
                                        record: record,
                                        mjslog: mjslog,
                                        matchmode_map_: cfg.desktop.matchmode.map_,
                                        fan_map_: cfg.fan.fan.map_
                                    });
                                })
                            });
                    })
                })
            }

            global.majsoul_free = true;
            await page_majsoul.close();
            if (timeout === 60) {
                return {
                    status: 400,
                    message: "timeout"
                }
            }
            return {
                status: 200,
                message: binaryToUrls(global.majsoul_data)
            }
        } catch (e) {
            console.log(e)
            global.majsoul_free = true;
            await page_majsoul.close();
            return {
                status: 400,
                message: e
            }
        }
    }
    return {
        status: 400,
        message: "雀魂牌谱解析服务当前正在访问中，请稍后再试"
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
        await page_naga.goto('https://naga.dmv.nico/niconico/login/');

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
            if (webSocket) {
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
    global.browser = await puppeteer.launch();
    for (const user of global.nagaUsers.users) {
        await create_naga_user_context(user, null);
    }
})();