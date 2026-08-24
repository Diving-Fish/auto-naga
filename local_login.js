// Run this on YOUR OWN machine, not on the server.
//
// The niconico login page is behind Cloudflare Turnstile, which judges the
// browser environment and exit IP -- an automated Chrome on a datacenter IP gets
// refused no matter who does the clicking, and a Turnstile token cannot be moved
// between browsers. So the login happens here, in a normal visible browser on
// your own connection, and only the resulting NAGA session cookie is shipped to
// the server.
//
//   node local_login.js http://your-server:3165 YourSecret
//
// Add --no-upload to just print the cookies (paste them yourself).

import puppeteer from "puppeteer";

const [, , serverArg, secretArg, ...rest] = process.argv;
const noUpload = rest.includes('--no-upload') || process.argv.includes('--no-upload');

if (!serverArg && !noUpload) {
    console.error("用法: node local_login.js <服务器地址> <secret> [--no-upload]");
    console.error("例如: node local_login.js http://192.0.2.10:3165 YourSecret");
    process.exit(1);
}

const NAGA_URL = 'https://naga.dmv.nico/niconico/niconico_login/';
const TIMEOUT = 15 * 60 * 1000;

const delay = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--window-size=1000,900']
});
const page = (await browser.pages())[0] || await browser.newPage();

console.log("正在打开 NAGA 登录页，请在弹出的浏览器窗口里正常登录（含 Cloudflare 验证）…");
await page.goto(NAGA_URL, { waitUntil: 'networkidle2', timeout: 60000 });

const started = Date.now();
while (Date.now() - started < TIMEOUT) {
    await delay(1000);
    if (page.isClosed()) {
        console.error("浏览器窗口被关闭，已取消");
        process.exit(1);
    }
    try {
        if (page.url().startsWith('https://naga.dmv.nico/')) break;
    } catch (e) { /* navigating, retry */ }
}

if (!page.url().startsWith('https://naga.dmv.nico/')) {
    console.error("等待登录超时");
    await browser.close();
    process.exit(1);
}

const cookies = (await page.cookies()).filter(c => c.domain.includes('naga.dmv.nico'));
await browser.close();

if (!cookies.some(c => c.name === 'naga-report-session-id')) {
    console.error("没有拿到 naga-report-session-id，登录可能没有真正完成");
    process.exit(1);
}
console.log(`已获取 ${cookies.length} 个 cookie`);

if (noUpload || !serverArg) {
    console.log(JSON.stringify(cookies, null, 2));
    process.exit(0);
}

const resp = await fetch(`${serverArg.replace(/\/$/, '')}/import_cookies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: secretArg, cookies })
});
const result = await resp.json();
console.log("服务器返回:", JSON.stringify(result));
process.exit(result.status === 200 ? 0 : 1);
