const puppeteer = require('puppeteer');
const fs = require('fs');
const readline = require('readline-sync');
const express = require('express');
const { default: axios } = require('axios');
const md5 = require('js-md5');
const FormData = require('form-data')

var global = {};

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
    axios(axios_body).then(resp => {resolve(resp)}).catch(err => {reject(err)})
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

global.app.post('/order', async (req, res) => {
  const secret = req.body.secret;
  if (secret == undefined || md5(secret) != loginContext.secret_md5) {
    res.send({"message": "secret error"})
    return;
  }
  const url = new URL(req.body.tenhou_url);
  const log = url.searchParams.get('log')
  const seat = url.searchParams.get('tw')
  const formData = new FormData();
  formData.append('haihu_id', log);
  formData.append('seat', seat);
  formData.append('reanalysis', 0);
  formData.append('player_type', 2);
  for (const cookie of global.cookies) {
    if (cookie.name === "csrftoken") {
      formData.append('csrfmiddlewaretoken', cookie.value)
      break;
    }
  }
  
  try {
    const resp = await naga_request('/naga_report/api/url_analyze/', 'post', {
      data: formData,
      headers: formData.getHeaders()
    })
    res.send(resp.data)
  } catch (err) {
    console.log(err);
    res.send({"status": 400});
  }
})

global.app.listen(3165, () => {
  console.log("已登入 NAGA 解析主站点，服务已启动")
});

(async () => {
  let cookies = [];
  if (fs.existsSync("cookie_cache")) {
    cookies = JSON.parse(fs.readFileSync("cookie_cache"))
  }

  const browser = await puppeteer.launch();
  const page_naga = await browser.newPage();

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
    global.cookies = await page_naga.cookies()
    fs.writeFileSync("cookie_cache", JSON.stringify(global.cookies))
  }

})();