// ==UserScript==
// @name         NAGA Cookie 一键同步
// @namespace    https://github.com/Diving-Fish/auto-naga
// @version      1.0.0
// @description  将当前 NAGA 登录 Cookie 同步到自行设置的 auto-naga 服务，自动保存设置。
// @match        https://naga.dmv.nico/*
// @noframes
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_cookie
// @connect      www.diving-fish.com
// @connect      *
// @homepageURL  https://github.com/Diving-Fish/auto-naga
// @downloadURL  https://raw.githubusercontent.com/Diving-Fish/auto-naga/main/userscripts/naga-cookie-sync.user.js
// @updateURL    https://raw.githubusercontent.com/Diving-Fish/auto-naga/main/userscripts/naga-cookie-sync.user.js
// ==/UserScript==

(() => {
    'use strict';
    const DEFAULT_REMOTE = 'http://www.diving-fish.com:3165/import_cookies/ui';
    const SESSION = 'naga-report-session-id';
    const COOKIE_URL = 'https://naga.dmv.nico/naga_report/';

    function endpoint(remote) {
        let url;
        try { url = new URL(remote.trim()); } catch { throw new Error('Remote 必须是完整的 HTTP 或 HTTPS 地址。'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
            throw new Error('Remote 必须是 HTTP 或 HTTPS 地址，且不能包含用户名或密码。');
        }
        let path = url.pathname.replace(/\/+$/, '');
        if (path.endsWith('/import_cookies/ui')) path = path.slice(0, -3);
        else if (!path.endsWith('/import_cookies')) path += '/import_cookies';
        url.pathname = path;
        url.search = '';
        url.hash = '';
        return url.href;
    }

    async function readCookies() {
        let cookies = [];
        if (typeof GM_cookie !== 'undefined' && typeof GM_cookie.list === 'function') {
            try {
                cookies = await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('Cookie 读取超时')), 10000);
                    GM_cookie.list({ url: COOKIE_URL }, (items, error) => {
                        clearTimeout(timer);
                        if (error) reject(new Error(String(error)));
                        else resolve(items || []);
                    });
                });
            } catch { /* Fall back only for cookies that are visible to the page. */ }
        }
        for (const part of document.cookie.split(';')) {
            const index = part.indexOf('=');
            if (index < 0) continue;
            const name = part.slice(0, index).trim();
            if (!cookies.some(cookie => cookie.name === name)) {
                cookies.push({ name, value: part.slice(index + 1), domain: 'naga.dmv.nico', path: '/' });
            }
        }
        const selected = cookies.filter(cookie => [SESSION, 'csrftoken'].includes(cookie.name) && cookie.value);
        if (!selected.some(cookie => cookie.name === SESSION)) {
            throw new Error('未读到登录 Cookie。请先登录 NAGA；若已登录，请使用支持 HttpOnly Cookie 的 Tampermonkey Beta 并检查脚本权限，或使用原来的手动导入页面。');
        }
        if (!selected.some(cookie => cookie.name === 'csrftoken')) {
            throw new Error('未读到 csrftoken，请打开 NAGA 的解析页面后重试。');
        }
        return selected.map(cookie => ({
            name: cookie.name, value: cookie.value, domain: cookie.domain,
            path: cookie.path || '/', expires: cookie.expirationDate ?? -1
        }));
    }

    function upload(url, secret, cookies) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST', url,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ secret, cookies }),
                anonymous: true,
                timeout: 60000,
                onload(response) {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`导入失败：HTTP ${response.status}`));
                        return;
                    }
                    let body;
                    try { body = JSON.parse(response.responseText); }
                    catch { reject(new Error('服务器未返回 JSON，请检查 Remote 地址。')); return; }
                    if (body?.status !== 200) {
                        const message = body?.message === 'secret error' ? 'Secret 不正确。'
                            : body?.status === 401 ? 'Cookie 无效或已过期，请重新登录 NAGA。'
                            : '服务器拒绝导入，请检查服务端日志。';
                        reject(new Error(message));
                        return;
                    }
                    resolve(body);
                },
                onerror: () => reject(new Error('连接失败，请检查 Remote、网络和油猴的跨域访问授权。')),
                ontimeout: () => reject(new Error('请求超时，请检查服务器状态后重试。')),
                onabort: () => reject(new Error('请求已取消。'))
            });
        });
    }

    function manualCookies() {
        return new Promise(resolve => {
            const dialog = document.createElement('dialog');
            dialog.innerHTML = `
                <form method="dialog">
                    <h3>手动导入 NAGA Cookie</h3>
                    <p>自动读取不可用。请先登录 NAGA，再按 F12 打开开发者工具：</p>
                    <p>Application（应用）→ Cookies → https://naga.dmv.nico。<br>
                    Firefox 可在“存储”→ Cookie 中找到。</p>
                    <p>复制以下两项的 Value（值）。只粘贴值，不需要名称。</p>
                    <label>naga-report-session-id<input name="session" type="password" autocomplete="off" required></label>
                    <label>csrftoken<input name="csrf" type="password" autocomplete="off" required></label>
                    <small>Cookie 仅用于本次提交，不保存到插件设置。</small>
                    <p><button type="submit">导入并验证</button> <button type="button" id="cancel">取消</button></p>
                </form>`;
            root.append(dialog);
            const form = dialog.querySelector('form');
            let result = null;
            form.addEventListener('submit', event => {
                event.preventDefault();
                const session = form.elements.session.value.trim();
                const csrf = form.elements.csrf.value.trim();
                if (!session || !csrf) return;
                result = [
                    { name: SESSION, value: session, domain: 'naga.dmv.nico', path: '/', expires: -1 },
                    { name: 'csrftoken', value: csrf, domain: 'naga.dmv.nico', path: '/', expires: -1 }
                ];
                dialog.close();
            });
            dialog.querySelector('#cancel').addEventListener('click', () => dialog.close());
            dialog.addEventListener('close', () => {
                form.reset();
                dialog.remove();
                resolve(result);
            }, { once: true });
            dialog.showModal();
        });
    }

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
        <style>
            :host { all: initial; }
            section { box-sizing: border-box; width: 310px; max-width: calc(100vw - 32px); padding: 14px;
                border: 1px solid #ccc; border-radius: 12px; background: #fff; color: #222;
                box-shadow: 0 3px 16px #0003; font: 14px/1.5 sans-serif; }
            header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
            button { cursor: pointer; border: 0; border-radius: 6px; padding: 8px 12px; }
            #sync { background: #1769d2; color: white; }
            button:disabled { opacity: .6; cursor: wait; }
            label { display: block; margin-top: 10px; }
            input { box-sizing: border-box; width: 100%; padding: 7px; font: inherit; }
            small { display: block; margin-top: 8px; color: #666; }
            #status { margin-top: 8px; overflow-wrap: anywhere; }
            dialog { width: 460px; max-width: calc(100vw - 48px); border: 1px solid #ccc;
                border-radius: 12px; padding: 20px; color: #222; background: white; font: 14px/1.5 sans-serif; }
            dialog::backdrop { background: #0006; }
            [hidden] { display: none; }
        </style>
        <section aria-label="NAGA Cookie 同步">
            <header><button id="sync" type="button">一键同步 NAGA</button><button id="settings" type="button" aria-expanded="false">设置</button></header>
            <div id="config" hidden>
                <label>Remote<input id="remote" type="url" spellcheck="false"></label>
                <label>Secret<input id="secret" type="password" autocomplete="off" spellcheck="false"></label>
                <small>修改后自动保存到油猴本地存储。仅点击同步时发送登录 Cookie 和 Secret 到 Remote。默认地址使用 HTTP 明文传输。</small>
            </div>
            <div id="status" role="status" aria-live="polite"></div>
        </section>`;
    document.body.append(host);
    const $ = id => root.getElementById(id);
    $('remote').value = GM_getValue('remote', DEFAULT_REMOTE);
    $('secret').value = GM_getValue('secret', '');
    function showSettings(open = $('config').hidden) {
        $('config').hidden = !open;
        $('settings').setAttribute('aria-expanded', String(open));
    }
    function status(message, error = false) {
        $('status').textContent = message;
        $('status').style.color = error ? '#b42318' : '#17613a';
    }
    for (const key of ['remote', 'secret']) {
        $(key).addEventListener('input', () => {
            try { GM_setValue(key, $(key).value); }
            catch { status('设置保存失败，请检查油猴存储权限。', true); }
        });
    }
    $('settings').addEventListener('click', () => showSettings());
    GM_registerMenuCommand('NAGA 同步设置', () => showSettings(true));
    async function sync() {
        if ($('sync').disabled) return;
        $('sync').disabled = true;
        try {
            const url = endpoint($('remote').value);
            const secret = $('secret').value;
            if (!secret.trim()) { showSettings(true); throw new Error('请先填写 Secret，设置会自动保存。'); }
            status('正在读取登录 Cookie…');
            let cookies;
            try { cookies = await readCookies(); }
            catch {
                status('自动读取不可用，请在弹窗中粘贴 Cookie。');
                cookies = await manualCookies();
                if (!cookies) { status('已取消同步。'); return; }
            }
            status('正在同步并验证，请稍候…');
            await upload(url, secret, cookies);
            status(`同步成功 · ${new Date().toLocaleTimeString()}`);
        } catch (error) {
            status(error.message || '同步失败，请重试。', true);
        } finally {
            $('sync').disabled = false;
        }
    }
    $('sync').addEventListener('click', sync);
    GM_registerMenuCommand('一键同步 NAGA Cookie', sync);
    if (!$('secret').value) showSettings(true);
})();
