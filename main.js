const puppeteer = require('puppeteer');
const fs = require('fs');
const readline = require('readline-sync');
const express = require('express');
const { default: axios } = require('axios');
const md5 = require('js-md5');
const FormData = require('form-data')
const paipu_transfer = require('./paipu_transfer.js')
const moment = require('moment-timezone');
const { exit } = require('process');

function delay(time) {
  return new Promise(function (resolve) {
    setTimeout(resolve, time)
  });
}

var global = {
  majsoul_free: true,
  first_majsoul_haihu: true
};

if (!fs.existsSync("config.json")) {
  fs.writeFileSync("config.json", JSON.stringify({
    "username": "", // user login to naga
    "password": "",
    "secret_md5": "", // you need secret token to access your services
    "majsoul_user": "", // user login to majsoul
    "majsoul_password": ""
  }))
  exit(0);
}
const loginContext = JSON.parse(fs.readFileSync("config.json"))

const naga_request = (url, method, args) => {
  return new Promise((resolve, reject) => {
    let cookie_str = "";
    for (const cookie of global.cookies) {
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
    axios(axios_body).then(resp => { resolve(resp) }).catch(err => { reject(err) })
  });
}

global.app = express()

global.app.use(express.json())

global.app.all("*", function (req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "content-type");
  res.header("Access-Control-Allow-Methods", "DELETE,PUT,POST,GET,OPTIONS");
  if (req.method.toLowerCase() == 'options')
    res.send(200);
  else
    next();
});

global.app.get('/order_report_list', async (req, res) => {
  const resp = await naga_request('/naga_report/api/order_report_list/', 'get', {
    params: {
      year: new Date().getFullYear(),
      month: new Date().getMonth() + 1
    }
  });
  res.send(resp.data);
})

global.app.post('/convert_majsoul', async (req, res) => {
  const secret = req.body.secret;
  if (secret == undefined || md5(secret) != loginContext.secret_md5) {
    res.send({ "status": 400, "message": "secret error" })
    return;
  }
  res.send(await parse_majsoul_url(req.body.majsoul_url));
})

global.app.post('/order', async (req, res) => {
  const secret = req.body.secret;
  if (secret == undefined || md5(secret) != loginContext.secret_md5) {
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
    for (const cookie of global.cookies) {
      if (cookie.name === "csrftoken") {
        formData.append('csrfmiddlewaretoken', cookie.value)
        break;
      }
    }
    const resp = await naga_request(req.body.custom ? 'naga_report/api/custom_haihu_analyze/' : '/naga_report/api/url_analyze/', 'post', {
      data: formData,
      headers: formData.getHeaders()
    })
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
        page_majsoul.close();
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
      page_majsoul.close();
      if (timeout == 60) {
        return {
          status: 400,
          message: "timeout"
        }
      }
      return {
        status: 200,
        message: paipu_transfer.binaryToUrls(global.majsoul_data)
      }
    } catch (e) {
      console.log(e)
      global.majsoul_free = true;
      page_majsoul.close();
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
};

(async () => {
  let cookies = [];
  if (fs.existsSync("cookie_cache")) {
    cookies = JSON.parse(fs.readFileSync("cookie_cache"))
  }

  global.browser = await puppeteer.launch();

  const page_naga = await global.browser.newPage();

  for (const cookie of cookies) {
    await page_naga.setCookie(cookie);
  }

  await page_naga.goto('https://naga.dmv.nico/niconico/login/');

  if (page_naga.url().startsWith("https://account.nicovideo.jp/login")) {
    await page_naga.type('#input__mailtel', loginContext.username)
    await page_naga.type('#input__password', loginContext.password)
    await Promise.all([page_naga.click('#login__submit'), page_naga.waitForNavigation()])
  }

  // 2-step verfication
  if (!page_naga.url().startsWith("https://naga.dmv.nico/")) {
    let code = readline.question("请查收您邮箱中的验证码，并输入：")
    console.log("waiting for 2-step verfication...")
    await page_naga.type('#oneTimePw', code)
    const btn = await page_naga.$(".loginBtn")
    await Promise.all([btn.click(), page_naga.waitForNavigation()])
  }

  if (page_naga.url().startsWith("https://naga.dmv.nico/")) {
    console.log("已登入 NAGA 解析主站点，服务已启动")
    global.cookies = await page_naga.cookies()
    fs.writeFileSync("cookie_cache", JSON.stringify(global.cookies))
  }

})();