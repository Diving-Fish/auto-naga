# API for Automatically Using Naga to Analyze Maj-soul and Tenhou

## 1. Setup

```shell
npm install
node main.js
```

Then fill the `config.json` file:

```json
{
    "username": "example@naga.com", // nico nico account
    "password": "Fakepassw0rd",
    "secret_md5": "", // use your favorite token and use md5 to hash it.
    "majsoul_user": "SiMoMo", // majsoul account
    "majsoul_password": "Fakepassw1rd"
}
```

Restart again:

```
> node main.js
已登入 NAGA 解析主站点，服务已启动
```

## 2. API

### Get `/order_report_list`

No Access Need. By default it'll only get data in current month.

Request:

```json
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

```json
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

```json
{
    // there will be a time stamp for indexing custom haihu.
    // time stamp is not precisely equal to `/order_report_list` API.
    "current": "2023-04-20T01:43:59", 
    "status": 200
}
```

### Post `/transfer_majsoul`

Request:

```json
{
    "secret": "YourSecret",
    "majsoul_url": "https://game.maj-soul.com/1/?paipu=************"
}
```

Response:

```json
{
    "status": 200,
    "message": [
        {East 1 data...},
        {East 2 data...},
        ...
    ]
}
```

**array at `response.message`** can be used to **haihus** in `/order` request. You could use some elements of them to analyze part of custom haihus.
