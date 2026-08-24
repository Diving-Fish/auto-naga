# API for Automatically Using Naga to Analyze Maj-soul and Tenhou

## 1. Setup

```shell
npm install
node main.js
```

Then fill the `config.json` file:

```json5
{
    "majsoul_user": "SiMoMo", // majsoul account
    "majsoul_password": "Fakepassw0rd"
}
```

Restart again, and use a websocket to add user:

```js
ws1 = new WebSocket("ws://localhost:3166/new_naga_account")
// request username
ws1.send("naga_account@xxx.com")
// request password
ws1.send("Fakepassword")
// request secret
ws1.send("YourSecret")
// request verify2 (only on new network environment)
ws1.send("114514")
```

Terminal output:

```
> node main.js
已登入 NAGA 解析主站点，服务已启动
```

## 1.5 Login (Cloudflare Turnstile)

The niconico login page is now behind a Cloudflare Turnstile widget.
`naga.dmv.nico` itself is **not** behind Cloudflare, so every API call keeps
working headlessly once a session cookie is stored — only the login step needs a
human.

Turnstile grades the browser environment and the exit IP, not whether a human
clicked. An automated Chrome on a server IP gets refused no matter who clicks,
and a Turnstile token cannot be moved between browsers. So the login has to
happen in a real browser on a normal connection, and only the resulting NAGA
session cookie travels to the server.

### Recommended: import the cookie (nothing to install)

1. Open `http://your-server:3165/import_cookies/ui` in your own browser.
2. In another tab log in to `https://naga.dmv.nico/` as usual.
3. DevTools (F12) → `Application` → `Cookies` → `https://naga.dmv.nico`, copy
   `naga-report-session-id` and `csrftoken` into the form, submit.

The server verifies the cookies against the NAGA API before storing them, so a
bad paste is rejected instead of silently breaking the service. The same thing
over HTTP:

```json5
// POST /import_cookies
{ "secret": "YourSecret", "cookies": "naga-report-session-id=xxx; csrftoken=yyy" }
// cookies may also be a puppeteer/DevTools cookie array, or
// { "session_id": "xxx", "csrf_token": "yyy" }
```

### Alternative: local_login.js

If you have node on your own machine, `node local_login.js http://your-server:3165 YourSecret`
opens a visible browser, waits for you to log in normally, then uploads the
cookies for you. Add `--no-upload` to just print them.

### Screenshot relay (only useful off a server IP)

`POST /naga_login {"secret": "..."}` opens the login page in the server's own
browser and returns a relay URL (`/naga_login/ui?token=...`) that streams
screenshots and forwards your clicks. On a datacenter IP Turnstile fails this
regardless, so prefer cookie import; it is kept for hosts on a residential
connection. Supporting endpoints: `GET /naga_login/{ui,screenshot,status}`,
`POST /naga_login/{click,type,key}`.

### Get `/session_status`

Shows how long each stored session still has. A watchdog runs every 6 hours: it
keeps the session warm, follows the cookie if NAGA rolls its expiry forward, and
warns in the log 3 days before a session runs out. On startup each stored cookie
is checked against the API rather than trusted blindly.

```json5
{
    "status": 200,
    "users": [
        { "username": "xxx@example.com", "login": true, "expires_at": "2026-08-20T06:59:21.553Z", "days_left": 13.6 }
    ]
}
```

Optional `config.json` keys: `public_base_url` (used in the links printed to the
log), `proxy_server` (default `http://localhost:10809`, `null` disables) and
`headless` (default `"new"`).

## 2. API

### Get `/order_report_list`

No Access Need. By default it'll only get data in current month.

Request:

```json5
{
    "status": 200,
    "report": [
        [
            // haihu origin
            "2023042000gm-0029-0000-c301e600", // tenhou
            // or "custom_haihu_2023-04-20T00:44:49_ogz0rtRdWNE1njv0"
            [
                "player_list ..."
            ],
            // naga html link
            "3e1646c12cd6e2b6cc21f09cc78683643be43a8c182084dd87bf234e5928f9edv2_2_2",
            0,
            [
                2,
                2,
                2
            ],
            0
        ]
    ]
}
```



### Post `/order`

Need secret token.

**Caution: It will directly cost NP on NAGA service. Be careful to use it!!!**

Request:

```json5
{
    "secret": "YourSecret",
    "custom": false,
    // if custom is false(tenhou haihu), you need fields below:
    "tenhou_url": "http://tenhou.net/0/?log=2023041916gm-00a9-0000-58c1a6e2&tw=2",
    // else if custom is true(custom haihu), you need fields below:
    "haihus": [
        {East 1 data...},
        {East 2 data...},
        ...
    ]
}
```

Response:

```json5
{
    // there will be a time stamp for indexing custom haihu.
    // time stamp is not precisely equal to `/order_report_list` API.
    "current": "2023-04-20T01:43:59", 
    "status": 200
}
```

### Post `/convert_majsoul`

Request:

```json5
{
    "secret": "YourSecret",
    "majsoul_url": "https://game.maj-soul.com/1/?paipu=************"
}
```

Response:

```json5
{
    "status": 200,
    "message": [
        {East 1 data...},
        {East 2 data...},
        ...
    ]
}
```

**Array at `response.message`** can be used to **haihus** in `/order` request. You could use some elements or all of them to analyze part of custom haihus.
