// ==UserScript==
// @name         Bilibili隐藏短视频
// @namespace    http://tampermonkey.net/
// @version      6.8
// @description  视频检测设置面板，支持黑名单订阅、订阅 UID 自动拉黑、全局例外、低质账号检测与隐藏模式
// @match        *://www.bilibili.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      *
// @license      GPL 2.0
// @homepageURL  https://github.com/Felix3322/BiliBili-BlockList
// @downloadURL  https://raw.githubusercontent.com/Felix3322/BiliBili-BlockList/main/Bilibili%E9%9A%90%E8%97%8F%E7%9F%AD%E8%A7%86%E9%A2%91.user.js
// @updateURL    https://raw.githubusercontent.com/Felix3322/BiliBili-BlockList/main/Bilibili%E9%9A%90%E8%97%8F%E7%9F%AD%E8%A7%86%E9%A2%91.user.js
// ==/UserScript==

(function () {
    'use strict';

    const DEFAULT_BLOCKLIST_URL = 'https://raw.githubusercontent.com/Felix3322/BiliBili-BlockList/main/blocklist.json';
    const RELATION_MODIFY_URL = 'https://api.bilibili.com/x/relation/modify';
    const AUTO_BLOCK_WARNING = '根据官方规定，粉丝量<1万，黑名单上限为1000；粉丝量≥1万，黑名单上限为10000。此功能可能撑满你的黑名单。';
    const AUTO_BLOCK_DELAY_MS = 180;

    const KEY = {
        minDuration: 'minDuration',
        debounceDelay: 'debounceDelay',
        isActive: 'isActive',
        isPanelVisible: 'isPanelVisible',
        styleChoice: 'styleChoice',
        customRules: 'customRules',
        globalExceptions: 'globalExceptions',
        lowQualityDbUrls: 'lowQualityDbUrls',
        lowQualityAccounts: 'lowQualityAccounts',
        lowQualityDbLastUpdate: 'lowQualityDbLastUpdate',
        followedAccountExceptions: 'followedAccountExceptions',
        warnMarketingAccount: 'warnMarketingAccount',
        warnLowQualityName: 'warnLowQualityName',
        warnClickbaitTitle: 'warnClickbaitTitle',
        warnFakeHacker: 'warnFakeHacker',
        warnPseudoScience: 'warnPseudoScience',
        warnSubscribedLowQualityAccount: 'warnSubscribedLowQualityAccount',
        globalFollowException: 'globalFollowException',
    };

    function loadBool(key, fallback) {
        const raw = localStorage.getItem(key);
        if (raw === null) return fallback;
        return raw === 'true';
    }

    function loadInt(key, fallback) {
        const value = parseInt(localStorage.getItem(key), 10);
        return Number.isFinite(value) ? value : fallback;
    }

    function loadJson(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (_) {
            return fallback;
        }
    }

    function saveJson(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
    }

    function escapeHtml(text) {
        return String(text ?? '').replace(/[&<>'"]/g, (char) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;',
        }[char]));
    }

    function normalizeText(text) {
        return String(text ?? '').replace(/\s+/g, '').trim();
    }

    let minDuration = loadInt(KEY.minDuration, 300);
    let debounceDelay = loadInt(KEY.debounceDelay, 500);
    let isActive = loadBool(KEY.isActive, true);
    let isPanelVisible = loadBool(KEY.isPanelVisible, false);
    let styleChoice = localStorage.getItem(KEY.styleChoice) || '半透明';
    let detectedElements = [];
    let customRules = loadJson(KEY.customRules, []);
    let globalExceptions = loadJson(KEY.globalExceptions, []);
    let lowQualityDbUrls = loadJson(KEY.lowQualityDbUrls, []);
    let lowQualityAccounts = loadJson(KEY.lowQualityAccounts, []);
    let followedAccountExceptions = loadJson(KEY.followedAccountExceptions, []);
    let lowQualityDbLastUpdate = localStorage.getItem(KEY.lowQualityDbLastUpdate) || '从未更新';
    let autoBlockState = {
        running: false,
        cancelled: false,
        processed: 0,
        total: 0,
        success: 0,
        failed: 0,
        lastMessage: '尚未运行',
    };

    let settings = {
        warnMarketingAccount: loadBool(KEY.warnMarketingAccount, true),
        warnLowQualityName: loadBool(KEY.warnLowQualityName, true),
        warnClickbaitTitle: loadBool(KEY.warnClickbaitTitle, true),
        warnFakeHacker: loadBool(KEY.warnFakeHacker, true),
        warnPseudoScience: loadBool(KEY.warnPseudoScience, true),
        warnSubscribedLowQualityAccount: loadBool(KEY.warnSubscribedLowQualityAccount, true),
        globalFollowException: loadBool(KEY.globalFollowException, true),
    };

    function initControlPanel() {
        if (document.getElementById('controlPanel')) return;

        const panel = document.createElement('div');
        panel.id = 'controlPanel';
        panel.style.position = 'fixed';
        panel.style.top = '10px';
        panel.style.right = '10px';
        panel.style.width = '360px';
        panel.style.maxHeight = '88vh';
        panel.style.overflowY = 'auto';
        panel.style.padding = '10px';
        panel.style.backgroundColor = '#f9f9f9';
        panel.style.border = '1px solid #ccc';
        panel.style.borderRadius = '8px';
        panel.style.boxShadow = '0px 0px 10px rgba(0, 0, 0, 0.1)';
        panel.style.zIndex = '999999';
        panel.style.fontSize = '13px';
        panel.style.color = '#222';
        panel.style.display = isPanelVisible ? 'block' : 'none';

        panel.innerHTML = `
            <h3 style="margin:0 0 8px 0;">检测设置 <span id="closePanel" style="cursor:pointer;float:right;">×</span></h3>
            <label>分界时间 (秒): <input type="number" id="minDuration" value="${minDuration}" style="width:80px;"></label><br>
            <label>防抖延迟 (毫秒): <input type="number" id="debounceDelay" value="${debounceDelay}" style="width:80px;"></label><br>
            <label>样式选择:
                <select id="styleChoice">
                    <option value="半透明" ${styleChoice === '半透明' ? 'selected' : ''}>半透明</option>
                    <option value="边框高亮" ${styleChoice === '边框高亮' ? 'selected' : ''}>边框高亮</option>
                    <option value="背景高亮" ${styleChoice === '背景高亮' ? 'selected' : ''}>背景高亮</option>
                    <option value="隐藏" ${styleChoice === '隐藏' ? 'selected' : ''}>隐藏</option>
                </select>
            </label><br>
            <label><input type="checkbox" id="warnMarketingAccount" ${settings.warnMarketingAccount ? 'checked' : ''}> 警惕营销号</label><br>
            <label><input type="checkbox" id="warnLowQualityName" ${settings.warnLowQualityName ? 'checked' : ''}> 小心科技区小学生低质视频</label><br>
            <label><input type="checkbox" id="warnClickbaitTitle" ${settings.warnClickbaitTitle ? 'checked' : ''}> 小心标题党</label><br>
            <label><input type="checkbox" id="warnFakeHacker" ${settings.warnFakeHacker ? 'checked' : ''}> 警惕假黑客</label><br>
            <label><input type="checkbox" id="warnPseudoScience" ${settings.warnPseudoScience ? 'checked' : ''}> 小心伪科普</label><br>
            <label><input type="checkbox" id="warnSubscribedLowQualityAccount" ${settings.warnSubscribedLowQualityAccount ? 'checked' : ''}> 启用订阅低质账号库</label><br>
            <label><input type="checkbox" id="globalFollowException" ${settings.globalFollowException ? 'checked' : ''}> 已关注 UP 全局例外</label><br>
            <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">
                <button id="toggleDetection">${isActive ? '禁用检测' : '启用检测'}</button>
                <button id="addCustomRule">添加自定义规则</button>
                <button id="clearLogs">清空日志</button>
            </div>

            <h4 style="margin:12px 0 6px 0;">全局例外</h4>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
                <button id="addManualException">手动添加例外</button>
                <button id="clearExceptions">清空例外</button>
            </div>
            <div id="exceptionList" style="max-height:120px;overflow-y:auto;background:#eee;padding:6px;border-radius:4px;"></div>

            <h4 style="margin:12px 0 6px 0;">已关注 UP 全局例外</h4>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
                <button id="clearFollowedExceptions">清空已关注缓存</button>
            </div>
            <div id="followedExceptionInfo" style="max-height:80px;overflow-y:auto;background:#eee;padding:6px;border-radius:4px;color:#555;"></div>

            <h4 style="margin:12px 0 6px 0;">黑名单 / 低质账号库订阅</h4>
            <div style="display:flex;gap:6px;">
                <input id="lowQualityDbUrlInput" placeholder="https://example.com/bili-bad-accounts.json" style="flex:1;min-width:0;">
                <button id="addDbUrl">添加</button>
            </div>
            <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
                <button id="subscribeDefaultBlocklist">订阅本仓库黑名单</button>
                <button id="refreshLowQualityDb">立即更新账号库</button>
                <button id="clearLowQualityDb">清空本地账号库</button>
            </div>
            <div id="lowQualityDbInfo" style="margin-top:6px;font-size:12px;color:#555;"></div>
            <div id="lowQualityDbUrlList" style="max-height:100px;overflow-y:auto;background:#eee;padding:6px;border-radius:4px;margin-top:6px;"></div>

            <h4 style="margin:12px 0 6px 0;">订阅黑名单自动拉黑</h4>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <button id="autoBlockSubscribedAccounts">根据订阅名单自动拉黑</button>
                <button id="stopAutoBlock" disabled>停止</button>
            </div>
            <div id="autoBlockStatus" style="margin-top:6px;font-size:12px;color:#555;background:#eee;padding:6px;border-radius:4px;"></div>

            <h4 style="margin:12px 0 6px 0;">检测日志</h4>
            <div id="logInfo" style="height:90px; overflow-y:auto; background:#e9e9e9; padding:5px; border-radius:4px;"></div>
            <div style="font-size:12px;color:#777;margin-top:8px;line-height:1.45;">
                UID 会从 space.bilibili.com/数字 解析；解析不到就用 UP 主名兜底。订阅支持 JSON 数组、{uids:[...]}、{accounts:[...]} 或纯文本每行一个账号。自动拉黑只处理 UID 项。
            </div>
        `;

        document.body.appendChild(panel);

        document.getElementById('toggleDetection').onclick = toggleDetection;
        document.getElementById('closePanel').onclick = closePanel;
        document.getElementById('minDuration').onchange = updateSettings;
        document.getElementById('debounceDelay').onchange = updateSettings;
        document.getElementById('styleChoice').onchange = updateSettings;
        document.getElementById('warnMarketingAccount').onchange = updateSettings;
        document.getElementById('warnLowQualityName').onchange = updateSettings;
        document.getElementById('warnClickbaitTitle').onchange = updateSettings;
        document.getElementById('warnFakeHacker').onchange = updateSettings;
        document.getElementById('warnPseudoScience').onchange = updateSettings;
        document.getElementById('warnSubscribedLowQualityAccount').onchange = updateSettings;
        document.getElementById('globalFollowException').onchange = updateSettings;
        document.getElementById('addCustomRule').onclick = addCustomRule;
        document.getElementById('clearLogs').onclick = clearLogs;
        document.getElementById('addManualException').onclick = addManualException;
        document.getElementById('clearExceptions').onclick = clearExceptions;
        document.getElementById('clearFollowedExceptions').onclick = clearFollowedExceptions;
        document.getElementById('addDbUrl').onclick = addDbUrl;
        document.getElementById('subscribeDefaultBlocklist').onclick = subscribeDefaultBlocklist;
        document.getElementById('refreshLowQualityDb').onclick = () => refreshLowQualityDb(true);
        document.getElementById('clearLowQualityDb').onclick = clearLowQualityDb;
        document.getElementById('autoBlockSubscribedAccounts').onclick = autoBlockSubscribedAccounts;
        document.getElementById('stopAutoBlock').onclick = stopAutoBlock;

        refreshPanelLists();
        updateLogInfo();
    }

    function toggleDetection() {
        isActive = !isActive;
        localStorage.setItem(KEY.isActive, isActive);
        document.getElementById('toggleDetection').textContent = isActive ? '禁用检测' : '启用检测';
        if (!isActive) {
            clearMarkers();
        } else {
            runDetection();
        }
    }

    function closePanel() {
        isPanelVisible = false;
        localStorage.setItem(KEY.isPanelVisible, isPanelVisible);
        document.getElementById('controlPanel').style.display = 'none';
    }

    function updateSettings() {
        minDuration = loadNumberFromInput('minDuration', 300);
        debounceDelay = loadNumberFromInput('debounceDelay', 500);
        styleChoice = document.getElementById('styleChoice').value;
        settings.warnMarketingAccount = document.getElementById('warnMarketingAccount').checked;
        settings.warnLowQualityName = document.getElementById('warnLowQualityName').checked;
        settings.warnClickbaitTitle = document.getElementById('warnClickbaitTitle').checked;
        settings.warnFakeHacker = document.getElementById('warnFakeHacker').checked;
        settings.warnPseudoScience = document.getElementById('warnPseudoScience').checked;
        settings.warnSubscribedLowQualityAccount = document.getElementById('warnSubscribedLowQualityAccount').checked;
        settings.globalFollowException = document.getElementById('globalFollowException').checked;

        localStorage.setItem(KEY.minDuration, minDuration);
        localStorage.setItem(KEY.debounceDelay, debounceDelay);
        localStorage.setItem(KEY.styleChoice, styleChoice);
        localStorage.setItem(KEY.warnMarketingAccount, settings.warnMarketingAccount);
        localStorage.setItem(KEY.warnLowQualityName, settings.warnLowQualityName);
        localStorage.setItem(KEY.warnClickbaitTitle, settings.warnClickbaitTitle);
        localStorage.setItem(KEY.warnFakeHacker, settings.warnFakeHacker);
        localStorage.setItem(KEY.warnPseudoScience, settings.warnPseudoScience);
        localStorage.setItem(KEY.warnSubscribedLowQualityAccount, settings.warnSubscribedLowQualityAccount);
        localStorage.setItem(KEY.globalFollowException, settings.globalFollowException);

        runDetection();
    }

    function loadNumberFromInput(id, fallback) {
        const value = parseInt(document.getElementById(id).value, 10);
        return Number.isFinite(value) ? value : fallback;
    }

    function addCustomRule() {
        const rule = prompt('请输入自定义规则（格式：关键词:提示）');
        if (!rule) return;

        const [keyword, ...tipParts] = rule.split(':');
        const tip = tipParts.join(':');
        if (keyword && tip) {
            customRules.push({ keyword: keyword.trim(), tip: tip.trim() });
            saveJson(KEY.customRules, customRules);
            runDetection();
        } else {
            alert('规则格式不正确，请使用“关键词:提示”的格式！');
        }
    }

    function addManualException() {
        const raw = prompt('请输入例外，格式：video:BV号 / uid:UID / upName:UP主名 / keyword:关键词');
        if (!raw) return;

        const parsed = parseTypedValue(raw);
        if (!parsed) {
            alert('格式不正确。例子：video:BV1xx、uid:123456、upName:某UP主、keyword:某关键词');
            return;
        }

        addGlobalException(parsed.type, parsed.value, '手动添加');
    }

    function addExceptionFromCard(info) {
        if (info.bvid) {
            addGlobalException('video', info.bvid, info.title || '视频例外', info.upName);
        } else if (info.uid) {
            addGlobalException('uid', info.uid, info.upName || 'UP主例外', info.upName);
        } else if (info.upName) {
            addGlobalException('upName', info.upName, info.title || 'UP主名例外', info.upName);
        } else {
            alert('这个卡片没有拿到 BV 号或 UP 主信息，无法添加稳定例外。');
        }
    }

    function addGlobalException(type, value, title = '', upName = '') {
        const cleanValue = String(value ?? '').trim();
        if (!cleanValue) return;

        const exists = globalExceptions.some((item) => item.type === type && String(item.value) === cleanValue);
        if (!exists) {
            globalExceptions.push({
                type,
                value: cleanValue,
                title: String(title ?? '').slice(0, 80),
                upName: String(upName ?? '').slice(0, 80),
                addedAt: new Date().toLocaleString(),
            });
            saveJson(KEY.globalExceptions, globalExceptions);
        }

        refreshPanelLists();
        runDetection();
    }

    function clearExceptions() {
        if (!confirm('确定清空所有全局例外吗？')) return;
        globalExceptions = [];
        saveJson(KEY.globalExceptions, globalExceptions);
        refreshPanelLists();
        runDetection();
    }

    function removeException(index) {
        globalExceptions.splice(index, 1);
        saveJson(KEY.globalExceptions, globalExceptions);
        refreshPanelLists();
        runDetection();
    }

    function rememberFollowedAccount(info) {
        if (!settings.globalFollowException || (!info.uid && !info.upName)) return;

        const normalizedUpName = normalizeText(info.upName);
        const exists = followedAccountExceptions.some((item) => {
            if (info.uid && item.uid && String(item.uid) === String(info.uid)) return true;
            return !info.uid && normalizedUpName && normalizeText(item.upName) === normalizedUpName;
        });

        if (!exists) {
            followedAccountExceptions.push({
                uid: info.uid || '',
                upName: info.upName || '',
                addedAt: new Date().toLocaleString(),
            });
            saveJson(KEY.followedAccountExceptions, followedAccountExceptions);
            renderFollowedExceptionInfo();
        }
    }

    function clearFollowedExceptions() {
        if (!confirm('确定清空已关注 UP 的全局例外缓存吗？这不会取消你的 B 站关注，只会清掉脚本本地记录。')) return;
        followedAccountExceptions = [];
        saveJson(KEY.followedAccountExceptions, followedAccountExceptions);
        refreshPanelLists();
        runDetection();
    }

    function addDbUrl() {
        const input = document.getElementById('lowQualityDbUrlInput');
        const url = input.value.trim();
        if (!/^https?:\/\//i.test(url)) {
            alert('请输入 http:// 或 https:// 开头的订阅地址。');
            return;
        }
        if (!lowQualityDbUrls.includes(url)) {
            lowQualityDbUrls.push(url);
            saveJson(KEY.lowQualityDbUrls, lowQualityDbUrls);
        }
        input.value = '';
        refreshPanelLists();
        refreshLowQualityDb(true);
    }

    async function subscribeDefaultBlocklist() {
        if (!lowQualityDbUrls.includes(DEFAULT_BLOCKLIST_URL)) {
            lowQualityDbUrls.push(DEFAULT_BLOCKLIST_URL);
            saveJson(KEY.lowQualityDbUrls, lowQualityDbUrls);
        }
        refreshPanelLists();
        await refreshLowQualityDb(true);
    }

    function removeDbUrl(index) {
        lowQualityDbUrls.splice(index, 1);
        saveJson(KEY.lowQualityDbUrls, lowQualityDbUrls);
        refreshPanelLists();
    }

    function clearLowQualityDb() {
        if (!confirm('确定清空本地已下载的低质账号库吗？订阅 URL 不会删除。')) return;
        lowQualityAccounts = [];
        saveJson(KEY.lowQualityAccounts, lowQualityAccounts);
        localStorage.setItem(KEY.lowQualityDbLastUpdate, '已清空');
        lowQualityDbLastUpdate = '已清空';
        refreshPanelLists();
        runDetection();
    }

    async function refreshLowQualityDb(showAlert) {
        if (!lowQualityDbUrls.length) {
            if (showAlert) alert('还没有添加订阅 URL。');
            return { count: 0, errors: ['还没有添加订阅 URL'] };
        }

        const allAccounts = [];
        const errors = [];

        for (const url of lowQualityDbUrls) {
            try {
                const text = await fetchTextByUserscript(url);
                const parsed = parseLowQualityDb(text, url);
                allAccounts.push(...parsed);
            } catch (err) {
                errors.push(`${url}: ${err && err.message ? err.message : String(err)}`);
            }
        }

        const dedup = new Map();
        for (const item of allAccounts) {
            if (!item || !item.type || !item.value) continue;
            const key = `${item.type}:${item.value}`;
            if (!dedup.has(key)) dedup.set(key, item);
        }

        lowQualityAccounts = Array.from(dedup.values());
        saveJson(KEY.lowQualityAccounts, lowQualityAccounts);
        lowQualityDbLastUpdate = new Date().toLocaleString();
        localStorage.setItem(KEY.lowQualityDbLastUpdate, lowQualityDbLastUpdate);
        refreshPanelLists();
        runDetection();

        if (showAlert) {
            const msg = errors.length
                ? `更新完成，但有 ${errors.length} 个订阅失败。成功载入 ${lowQualityAccounts.length} 条账号规则。\n\n${errors.join('\n')}`
                : `更新完成，载入 ${lowQualityAccounts.length} 条账号规则。`;
            alert(msg);
        }

        return { count: lowQualityAccounts.length, errors };
    }

    function fetchTextByUserscript(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    timeout: 15000,
                    onload: (response) => {
                        if (response.status >= 200 && response.status < 300) {
                            resolve(response.responseText);
                        } else {
                            reject(new Error(`HTTP ${response.status}`));
                        }
                    },
                    onerror: () => reject(new Error('网络错误')),
                    ontimeout: () => reject(new Error('请求超时')),
                });
            } else {
                fetch(url, { cache: 'no-store' })
                    .then((res) => res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`)))
                    .then(resolve)
                    .catch(reject);
            }
        });
    }

    function parseLowQualityDb(text, sourceUrl) {
        const trimmed = String(text ?? '').trim();
        if (!trimmed) return [];

        try {
            const json = JSON.parse(trimmed);
            const list = Array.isArray(json)
                ? json
                : (Array.isArray(json.accounts) ? json.accounts : (Array.isArray(json.uids) ? json.uids : []));
            return list.map((item) => normalizeDbItem(item, sourceUrl)).filter(Boolean);
        } catch (_) {
            return trimmed
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter((line) => line && !line.startsWith('#') && !line.startsWith('//'))
                .map((line) => normalizeDbItem(line, sourceUrl))
                .filter(Boolean);
        }
    }

    function normalizeDbItem(item, sourceUrl) {
        if (typeof item === 'string' || typeof item === 'number') {
            const line = String(item).trim();
            const [mainPart, ...tipParts] = line.split('|');
            const tip = tipParts.join('|').trim() || '订阅低质账号';
            const parsed = parseTypedValue(mainPart.trim());
            if (!parsed) return null;
            return { type: parsed.type, value: parsed.value, tip, source: sourceUrl };
        }

        if (item && typeof item === 'object') {
            const tip = String(item.tip || item.reason || '订阅低质账号');
            if (item.uid !== undefined) return { type: 'uid', value: String(item.uid).trim(), tip, source: sourceUrl };
            if (item.mid !== undefined) return { type: 'uid', value: String(item.mid).trim(), tip, source: sourceUrl };
            if (item.name !== undefined) return { type: 'upName', value: String(item.name).trim(), tip, source: sourceUrl };
            if (item.upName !== undefined) return { type: 'upName', value: String(item.upName).trim(), tip, source: sourceUrl };
            if (item.account !== undefined) return { type: 'upName', value: String(item.account).trim(), tip, source: sourceUrl };
            if (item.keyword !== undefined) return { type: 'keyword', value: String(item.keyword).trim(), tip, source: sourceUrl };
        }

        return null;
    }

    function parseTypedValue(raw) {
        const text = String(raw ?? '').trim();
        if (!text) return null;

        const spaceMatch = text.match(/space\.bilibili\.com\/(\d+)/i);
        if (spaceMatch) return { type: 'uid', value: spaceMatch[1] };

        const videoMatch = text.match(/\b(BV[0-9A-Za-z]+)\b/);
        if (videoMatch && /^video\s*:/i.test(text)) return { type: 'video', value: videoMatch[1] };

        const match = text.match(/^(video|bvid|bv|uid|mid|name|upName|account|keyword)\s*[:：]\s*(.+)$/i);
        if (match) {
            let type = match[1].toLowerCase();
            const value = match[2].trim();
            if (!value) return null;
            if (type === 'bvid' || type === 'bv') type = 'video';
            if (type === 'mid') type = 'uid';
            if (type === 'name' || type === 'account') type = 'upName';
            return { type, value };
        }

        if (/^\d{3,}$/.test(text)) return { type: 'uid', value: text };
        if (/^BV[0-9A-Za-z]+$/.test(text)) return { type: 'video', value: text };
        return { type: 'upName', value: text };
    }

    function refreshPanelLists() {
        renderExceptionList();
        renderFollowedExceptionInfo();
        renderDbInfo();
        renderDbUrlList();
        renderAutoBlockStatus();
    }

    function renderExceptionList() {
        const list = document.getElementById('exceptionList');
        if (!list) return;

        if (!globalExceptions.length) {
            list.innerHTML = '<span style="color:#777;">暂无例外。灰掉的视频上会出现“加例外”按钮。</span>';
            return;
        }

        list.innerHTML = globalExceptions.map((item, index) => `
            <div style="display:flex;gap:6px;align-items:center;justify-content:space-between;border-bottom:1px solid #ddd;padding:3px 0;">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px;" title="${escapeHtml(item.title || item.upName || item.value)}">
                    [${escapeHtml(item.type)}] ${escapeHtml(item.value)}${item.upName ? ` / ${escapeHtml(item.upName)}` : ''}
                </span>
                <button data-remove-exception="${index}">删除</button>
            </div>
        `).join('');

        list.querySelectorAll('[data-remove-exception]').forEach((button) => {
            button.onclick = () => removeException(parseInt(button.dataset.removeException, 10));
        });
    }

    function renderFollowedExceptionInfo() {
        const info = document.getElementById('followedExceptionInfo');
        if (!info) return;

        if (!followedAccountExceptions.length) {
            info.innerHTML = '<span style="color:#777;">暂无缓存。脚本看到“已关注”标记后，会记录这个 UP 的 UID/名称，并全局跳过。</span>';
            return;
        }

        const recent = followedAccountExceptions.slice(-8).reverse();
        info.innerHTML = `已缓存 ${followedAccountExceptions.length} 个已关注 UP：` + recent.map((item) => {
            const label = item.uid ? `uid:${escapeHtml(item.uid)}` : `upName:${escapeHtml(item.upName || '')}`;
            const name = item.upName ? ` / ${escapeHtml(item.upName)}` : '';
            return `<div style="border-top:1px solid #ddd;padding:2px 0;">${label}${name}</div>`;
        }).join('');
    }

    function renderDbInfo() {
        const info = document.getElementById('lowQualityDbInfo');
        if (!info) return;
        const uidCount = getSubscribedUids().length;
        info.textContent = `订阅 ${lowQualityDbUrls.length} 个 URL，本地账号规则 ${lowQualityAccounts.length} 条（UID ${uidCount} 条）；上次更新：${lowQualityDbLastUpdate}`;
    }

    function renderAutoBlockStatus() {
        const status = document.getElementById('autoBlockStatus');
        const startButton = document.getElementById('autoBlockSubscribedAccounts');
        const stopButton = document.getElementById('stopAutoBlock');
        if (!status) return;

        status.textContent = autoBlockState.running
            ? `处理中 ${autoBlockState.processed}/${autoBlockState.total}；成功 ${autoBlockState.success}，失败 ${autoBlockState.failed}。${autoBlockState.lastMessage}`
            : `${autoBlockState.lastMessage}；成功 ${autoBlockState.success}，失败 ${autoBlockState.failed}。`;

        if (startButton) startButton.disabled = autoBlockState.running;
        if (stopButton) stopButton.disabled = !autoBlockState.running;
    }

    function getSubscribedUids() {
        const uids = lowQualityAccounts
            .filter((item) => item && item.type === 'uid' && /^\d{3,}$/.test(String(item.value || '')))
            .map((item) => String(item.value));
        return Array.from(new Set(uids));
    }

    function getCookieValue(name) {
        const prefix = `${encodeURIComponent(name)}=`;
        const item = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
        return item ? decodeURIComponent(item.slice(prefix.length)) : '';
    }

    function wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function blockBilibiliUid(uid, csrf) {
        const body = new URLSearchParams({
            fid: uid,
            act: '5',
            re_src: '11',
            gaia_source: 'web_main',
            spmid: '333.1387.0.0',
            extend_content: JSON.stringify({ entity: 'user', entity_id: uid }),
            csrf,
        });
        const statistics = encodeURIComponent(JSON.stringify({ appId: 100, platform: 5 }));
        const response = await fetch(`${RELATION_MODIFY_URL}?statistics=${statistics}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        const result = await response.json();
        return {
            ok: response.ok && result.code === 0,
            httpStatus: response.status,
            code: result.code,
            message: result.message || result.msg || '',
        };
    }

    function stopAutoBlock() {
        if (!autoBlockState.running) return;
        autoBlockState.cancelled = true;
        autoBlockState.lastMessage = '正在停止，将在当前请求完成后退出';
        renderAutoBlockStatus();
    }

    async function autoBlockSubscribedAccounts() {
        if (autoBlockState.running) return;
        if (!lowQualityAccounts.length && lowQualityDbUrls.length) {
            await refreshLowQualityDb(false);
        }

        const uids = getSubscribedUids();
        if (!uids.length) {
            alert('订阅账号库中没有可用于自动拉黑的 UID。请先订阅并更新黑名单。');
            return;
        }

        const accepted = confirm(`${AUTO_BLOCK_WARNING}\n\n本次将尝试拉黑订阅中的 ${uids.length} 个 UID。是否继续？`);
        if (!accepted) return;

        const csrf = getCookieValue('bili_jct');
        if (!csrf) {
            alert('未找到 Bilibili 登录会话，请先登录后再执行自动拉黑。');
            return;
        }

        autoBlockState = {
            running: true,
            cancelled: false,
            processed: 0,
            total: uids.length,
            success: 0,
            failed: 0,
            lastMessage: '已开始',
        };
        renderAutoBlockStatus();

        const fatalCodes = new Set([-101, -111, -412, -509]);
        for (const uid of uids) {
            if (autoBlockState.cancelled) break;
            try {
                const result = await blockBilibiliUid(uid, csrf);
                autoBlockState.processed += 1;
                if (result.ok) {
                    autoBlockState.success += 1;
                    autoBlockState.lastMessage = `UID ${uid}：成功`;
                } else {
                    autoBlockState.failed += 1;
                    autoBlockState.lastMessage = `UID ${uid}：${result.code} ${result.message}`;
                    if (fatalCodes.has(result.code)) {
                        autoBlockState.cancelled = true;
                    }
                }
            } catch (error) {
                autoBlockState.processed += 1;
                autoBlockState.failed += 1;
                autoBlockState.lastMessage = `UID ${uid}：${error && error.message ? error.message : String(error)}`;
                autoBlockState.cancelled = true;
            }
            renderAutoBlockStatus();
            if (!autoBlockState.cancelled) await wait(AUTO_BLOCK_DELAY_MS);
        }

        const stopped = autoBlockState.cancelled && autoBlockState.processed < autoBlockState.total;
        autoBlockState.running = false;
        autoBlockState.lastMessage = stopped
            ? `已停止，处理 ${autoBlockState.processed}/${autoBlockState.total}`
            : `已完成，处理 ${autoBlockState.processed}/${autoBlockState.total}`;
        renderAutoBlockStatus();
        alert(`${autoBlockState.lastMessage}\n成功 ${autoBlockState.success}，失败 ${autoBlockState.failed}。`);
    }

    function renderDbUrlList() {
        const list = document.getElementById('lowQualityDbUrlList');
        if (!list) return;

        if (!lowQualityDbUrls.length) {
            list.innerHTML = '<span style="color:#777;">暂无订阅 URL。</span>';
            return;
        }

        list.innerHTML = lowQualityDbUrls.map((url, index) => `
            <div style="display:flex;gap:6px;align-items:center;justify-content:space-between;border-bottom:1px solid #ddd;padding:3px 0;">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:275px;" title="${escapeHtml(url)}">${escapeHtml(url)}</span>
                <button data-remove-dburl="${index}">删除</button>
            </div>
        `).join('');

        list.querySelectorAll('[data-remove-dburl]').forEach((button) => {
            button.onclick = () => removeDbUrl(parseInt(button.dataset.removeDburl, 10));
        });
    }

    function clearLogs() {
        detectedElements = [];
        const log = document.getElementById('logInfo');
        if (log) log.innerHTML = '';
    }

    function updateLogInfo() {
        const logDiv = document.getElementById('logInfo');
        if (!logDiv) return;
        logDiv.innerHTML = `
            当前检测到的视频数量：${detectedElements.length}<br>
            索引位置：${detectedElements.map((elem) => elem.index).join(', ')}
        `;
    }

    function convertDurationToSeconds(durationText) {
        const timeParts = String(durationText ?? '').split(':').map(Number);
        if (timeParts.some((part) => !Number.isFinite(part))) return 0;
        if (timeParts.length === 2) return timeParts[0] * 60 + timeParts[1];
        if (timeParts.length === 3) return timeParts[0] * 3600 + timeParts[1] * 60 + timeParts[2];
        return 0;
    }

    function clearMarkers() {
        detectedElements.forEach((item) => {
            if (!item.element) return;
            item.element.style.opacity = item.previousStyle?.opacity ?? '1';
            item.element.style.border = item.previousStyle?.border ?? '';
            item.element.style.backgroundColor = item.previousStyle?.backgroundColor ?? '';
            item.element.style.display = item.previousStyle?.display ?? '';
            item.element.style.position = item.previousStyle?.position ?? '';
            const warning = item.element.querySelector('.short-video-warning');
            if (warning) warning.remove();
        });
        detectedElements = [];
        updateLogInfo();
    }

    function applyStyle(element, warningText, info) {
        const previousStyle = {
            opacity: element.style.opacity,
            border: element.style.border,
            backgroundColor: element.style.backgroundColor,
            display: element.style.display,
            position: element.style.position,
        };

        if (styleChoice === '半透明') {
            element.style.opacity = '0.5';
        } else if (styleChoice === '边框高亮') {
            element.style.border = '2px solid red';
        } else if (styleChoice === '背景高亮') {
            element.style.backgroundColor = 'rgba(255, 0, 0, 0.2)';
        } else if (styleChoice === '隐藏') {
            element.style.display = 'none';
        }

        if (warningText && styleChoice !== '隐藏') {
            const warning = document.createElement('div');
            warning.className = 'short-video-warning';
            warning.style.position = 'absolute';
            warning.style.top = '10px';
            warning.style.left = '10px';
            warning.style.padding = '4px 8px';
            warning.style.backgroundColor = 'rgba(255, 0, 0, 1)';
            warning.style.color = 'white';
            warning.style.fontSize = '12px';
            warning.style.fontWeight = 'bold';
            warning.style.borderRadius = '4px';
            warning.style.zIndex = '999';
            warning.style.display = 'flex';
            warning.style.gap = '6px';
            warning.style.alignItems = 'center';
            warning.style.boxShadow = '0 2px 6px rgba(0,0,0,.25)';

            const text = document.createElement('span');
            text.textContent = warningText;
            warning.appendChild(text);

            const button = document.createElement('button');
            button.textContent = '加例外';
            button.title = '把这个视频加入全局例外，以后不再灰掉';
            button.style.fontSize = '12px';
            button.style.padding = '1px 4px';
            button.style.cursor = 'pointer';
            button.onclick = (event) => {
                event.preventDefault();
                event.stopPropagation();
                addExceptionFromCard(info);
            };
            warning.appendChild(button);

            element.style.position = 'relative';
            element.appendChild(warning);
        }

        return previousStyle;
    }

    function getCardInfo(card) {
        const upNameElement = card.querySelector('.bili-video-card__info--author')
            || card.querySelector('.bili-video-card__info--owner')
            || card.querySelector('.upname .name')
            || card.querySelector('.up-name')
            || card.querySelector('a[href*="space.bilibili.com"]');

        const titleElement = card.querySelector('.bili-video-card__info--tit a')
            || card.querySelector('.title a')
            || card.querySelector('a[href*="/video/"]');

        const durationElement = card.querySelector('.bili-video-card__stats__duration')
            || card.querySelector('.duration')
            || card.querySelector('.bili-cover-card__stats__duration');

        const authorLink = card.querySelector('a[href*="space.bilibili.com"]')
            || card.querySelector('a[href*="/space/"]');
        const videoLink = titleElement?.href || card.querySelector('a[href*="/video/"]')?.href || '';
        const uidFromDom = extractUid(authorLink?.href || '')
            || extractUid(card.getAttribute('data-mid') || '')
            || extractUid(card.getAttribute('data-uid') || '')
            || extractUid(card.dataset?.mid || '')
            || extractUid(card.dataset?.uid || '');

        return {
            upName: upNameElement ? upNameElement.textContent.trim() : '',
            title: titleElement ? titleElement.textContent.trim() : '',
            durationText: durationElement ? durationElement.textContent.trim() : '',
            uid: uidFromDom,
            bvid: extractBvid(videoLink),
            videoUrl: videoLink,
        };
    }

    function extractUid(value) {
        const text = String(value ?? '');
        const spaceMatch = text.match(/space\.bilibili\.com\/(\d+)/i);
        if (spaceMatch) return spaceMatch[1];
        const pureNumberMatch = text.match(/^(\d{3,})$/);
        if (pureNumberMatch) return pureNumberMatch[1];
        return '';
    }

    function extractBvid(url) {
        const match = String(url ?? '').match(/\/video\/(BV[0-9A-Za-z]+)/i) || String(url ?? '').match(/\b(BV[0-9A-Za-z]+)\b/);
        return match ? match[1] : '';
    }

    function isFollowedCard(card) {
        const candidates = Array.from(card.querySelectorAll([
            '.bili-video-card__info--icon-text',
            '.upname .name',
            '.bili-video-card__info--follow',
            '.followed',
            '[title*="已关注"]',
        ].join(',')));

        return candidates.some((element) => {
            const text = `${element.textContent || ''} ${element.getAttribute('title') || ''}`;
            return text.includes('已关注');
        });
    }

    function isFollowedAccountException(info) {
        if (!settings.globalFollowException) return false;
        const upName = normalizeText(info.upName);

        return followedAccountExceptions.some((item) => {
            if (item.uid && info.uid && String(item.uid) === String(info.uid)) return true;
            if (item.upName && upName && normalizeText(item.upName) === upName) return true;
            return false;
        });
    }

    function isGlobalException(info) {
        const title = normalizeText(info.title);
        const upName = normalizeText(info.upName);

        return globalExceptions.some((item) => {
            const value = String(item.value ?? '').trim();
            if (!value) return false;
            if (item.type === 'video') return info.bvid && value === info.bvid;
            if (item.type === 'uid') return info.uid && value === info.uid;
            if (item.type === 'upName') return upName && normalizeText(value) === upName;
            if (item.type === 'keyword') return normalizeText(value) && (title.includes(normalizeText(value)) || upName.includes(normalizeText(value)));
            return false;
        });
    }

    function matchLowQualityDb(info) {
        const title = normalizeText(info.title);
        const upName = normalizeText(info.upName);

        for (const item of lowQualityAccounts) {
            const value = String(item.value ?? '').trim();
            const normalizedValue = normalizeText(value);
            if (!value) continue;

            if (item.type === 'uid' && info.uid && value === info.uid) return item;
            if (item.type === 'upName' && upName && normalizedValue === upName) return item;
            if (item.type === 'keyword' && normalizedValue && (title.includes(normalizedValue) || upName.includes(normalizedValue))) return item;
        }
        return null;
    }

    function processVideoCards() {
        const videoSelectors = ['.bili-video-card', '.video-page-card-small'];
        videoSelectors.forEach((selector) => {
            const videoCards = document.querySelectorAll(selector);

            videoCards.forEach((card, index) => {
                if (detectedElements.find((elem) => elem.element === card)) return;

                const info = getCardInfo(card);
                if (isGlobalException(info)) return;

                if (isFollowedCard(card)) {
                    rememberFollowedAccount(info);
                    return;
                }

                if (isFollowedAccountException(info)) return;

                let warningText = '';

                const dbMatch = settings.warnSubscribedLowQualityAccount ? matchLowQualityDb(info) : null;
                if (dbMatch) {
                    warningText = dbMatch.tip || '订阅低质账号';
                }

                else if (settings.warnMarketingAccount && info.upName && info.upName.includes('观察')) {
                    warningText = '警惕营销号';
                }

                else if (settings.warnLowQualityName && info.upName && (info.upName.match(/_/g) || []).length >= 2) {
                    warningText = '小心科技区小学生低质视频';
                }

                else if (settings.warnClickbaitTitle && info.title && (info.title.match(/!/g) || []).length >= 2) {
                    warningText = '小心标题党';
                }

                else if (settings.warnFakeHacker && info.upName && /(黑客|网安|白帽)/.test(info.upName)) {
                    warningText = '警惕假黑客';
                }

                else if (settings.warnPseudoScience && info.title && /(禁止废话|废话)/.test(info.title)) {
                    warningText = '小心伪科普';
                }

                else {
                    for (const rule of customRules) {
                        if ((info.upName && info.upName.includes(rule.keyword)) || (info.title && info.title.includes(rule.keyword))) {
                            warningText = rule.tip;
                            break;
                        }
                    }
                }

                if (!warningText && info.durationText) {
                    const durationInSeconds = convertDurationToSeconds(info.durationText);
                    if (durationInSeconds > 0 && durationInSeconds < minDuration) {
                        warningText = durationInSeconds < 60 ? '小心沉迷短视频！' : '短视频';
                    }
                }

                if (warningText) {
                    const previousStyle = applyStyle(card, warningText, info);
                    detectedElements.push({ element: card, index, previousStyle });
                    updateLogInfo();
                }
            });
        });
    }

    function debounce(func, delay) {
        let timeout;
        return function (...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), delay);
        };
    }

    const observer = new MutationObserver(debounce(() => {
        if (isActive) runDetection();
    }, debounceDelay));

    function runDetection() {
        clearMarkers();
        processVideoCards();
    }

    function maybeAutoRefreshDb() {
        if (!lowQualityDbUrls.length) return;
        const last = Date.parse(lowQualityDbLastUpdate);
        const twelveHours = 12 * 60 * 60 * 1000;
        if (!Number.isFinite(last) || Date.now() - last > twelveHours) {
            refreshLowQualityDb(false);
        }
    }

    initControlPanel();
    observer.observe(document.body, { childList: true, subtree: true });
    if (isActive) runDetection();
    maybeAutoRefreshDb();

    GM_registerMenuCommand('显示/隐藏控制面板', () => {
        isPanelVisible = !isPanelVisible;
        localStorage.setItem(KEY.isPanelVisible, isPanelVisible);
        document.getElementById('controlPanel').style.display = isPanelVisible ? 'block' : 'none';
    });

    GM_registerMenuCommand('清空已关注 UP 全局例外缓存', () => {
        clearFollowedExceptions();
    });

    GM_registerMenuCommand('订阅/更新 BiliBili-BlockList', () => {
        subscribeDefaultBlocklist();
    });

    GM_registerMenuCommand('根据订阅黑名单自动拉黑', () => {
        autoBlockSubscribedAccounts();
    });
})();
