// ==UserScript==
// @name         Bilibili隐藏短视频
// @namespace    http://tampermonkey.net/
// @version      7.1
// @description  低质迷因
// @match        *://www.bilibili.com/*
// @match        *://search.bilibili.com/*
// @match        *://space.bilibili.com/*
// @match        *://t.bilibili.com/*
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

    const DOM_ADAPTERS = [
        {
            id: 'dynamic',
            label: '动态',
            matches: (loc) => loc.hostname === 't.bilibili.com' || /\/dynamic\/?$/.test(loc.pathname),
            selectors: ['a.bili-dyn-card-video'],
            contextSelector: '.bili-dyn-item',
        },
        {
            id: 'watchlater',
            label: '稍后再看',
            matches: (loc) => /\/watchlater(?:\/list)?/.test(loc.pathname),
            selectors: ['.watchlater-list-container .video-card.video-card--grid'],
        },
        {
            id: 'history',
            label: '历史',
            matches: (loc) => /\/history\/?$/.test(loc.pathname),
            selectors: ['.history-card'],
        },
        {
            id: 'favorites',
            label: '收藏',
            matches: (loc) => loc.hostname === 'space.bilibili.com' && /\/favlist/.test(loc.pathname),
            selectors: ['.items__item > .bili-video-card', '.items__item .bili-video-card'],
        },
        {
            id: 'space-upload',
            label: '空间投稿',
            matches: (loc) => loc.hostname === 'space.bilibili.com' && /\/(?:upload|video)/.test(loc.pathname),
            selectors: ['.upload-video-card'],
        },
        {
            id: 'video-page',
            label: '播放页推荐',
            matches: (loc) => /\/video\/BV[0-9A-Za-z]+/i.test(loc.pathname),
            selectors: ['.video-page-card-small', '.video-pod__item'],
        },
        {
            id: 'popular',
            label: '热门',
            matches: (loc) => /\/v\/popular\//.test(loc.pathname),
            selectors: ['.popular-video-container .video-card', '.popular-video-container .rank-item'],
        },
        {
            id: 'feed',
            label: '首页 / 搜索 / 分区',
            matches: () => true,
            selectors: ['.bili-video-card', '.video-card-common', '.rank-item', '.small-item'],
        },
    ];

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
        repoSubscriptionEnabled: 'repoSubscriptionEnabled',
        followedAccountExceptions: 'followedAccountExceptions',
        warnMarketingAccount: 'warnMarketingAccount',
        warnLowQualityName: 'warnLowQualityName',
        warnClickbaitTitle: 'warnClickbaitTitle',
        warnFakeHacker: 'warnFakeHacker',
        warnPseudoScience: 'warnPseudoScience',
        warnSubscribedLowQualityAccount: 'warnSubscribedLowQualityAccount',
        globalFollowException: 'globalFollowException',
    };

    if (typeof module !== 'undefined' && module.exports && typeof document === 'undefined') {
        module.exports = {
            DOM_ADAPTERS,
            extractUid,
            extractBvid,
            convertDurationToSeconds,
            parseTypedValue,
            parseLowQualityDb,
        };
        return;
    }

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
    let detectedElements = new Map();
    let customRules = loadJson(KEY.customRules, []);
    let globalExceptions = loadJson(KEY.globalExceptions, []);
    let lowQualityDbUrls = loadJson(KEY.lowQualityDbUrls, []).filter((url) => url !== DEFAULT_BLOCKLIST_URL);
    let lowQualityAccounts = loadJson(KEY.lowQualityAccounts, []);
    let repoSubscriptionEnabled = loadBool(KEY.repoSubscriptionEnabled, false);
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
    let panelRoot = null;
    let panelHost = null;
    let engineRevision = 1;
    let currentRoute = location.href;
    let detectionLog = [];
    const processedCards = new WeakMap();

    let settings = {
        warnMarketingAccount: loadBool(KEY.warnMarketingAccount, true),
        warnLowQualityName: loadBool(KEY.warnLowQualityName, true),
        warnClickbaitTitle: loadBool(KEY.warnClickbaitTitle, true),
        warnFakeHacker: loadBool(KEY.warnFakeHacker, true),
        warnPseudoScience: loadBool(KEY.warnPseudoScience, true),
        warnSubscribedLowQualityAccount: loadBool(KEY.warnSubscribedLowQualityAccount, true),
        globalFollowException: loadBool(KEY.globalFollowException, true),
    };

    function ui(id) {
        return panelRoot ? panelRoot.getElementById(id) : null;
    }

    function initControlPanel() {
        if (document.getElementById('bbbl-control-host')) return;

        panelHost = document.createElement('div');
        panelHost.id = 'bbbl-control-host';
        panelHost.style.cssText = 'all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647;font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif;';
        panelRoot = panelHost.attachShadow({ mode: 'open' });
        panelRoot.innerHTML = `
            <style>
                :host{color-scheme:light}*{box-sizing:border-box}button,input,select{font:inherit}
                button{border:0;cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}
                #launcher{display:flex;align-items:center;gap:9px;height:44px;padding:0 15px;border-radius:15px;background:#101828;color:#fff;box-shadow:0 12px 32px #1018283d;cursor:pointer;user-select:none;font-size:13px;font-weight:700}
                #launcher i{display:grid;place-items:center;min-width:22px;height:22px;padding:0 6px;border-radius:8px;background:#fb7299;font-style:normal;font-size:11px}
                #controlPanel{position:absolute;right:0;bottom:56px;width:min(440px,calc(100vw - 24px));max-height:min(760px,calc(100vh - 88px));display:flex;flex-direction:column;overflow:hidden;border:1px solid #e4e7ec;border-radius:22px;background:#f8fafc;color:#101828;box-shadow:0 24px 80px #10182840;transition:.18s ease}
                #controlPanel.is-hidden{opacity:0;transform:translateY(10px) scale(.98);pointer-events:none}
                header{display:flex;align-items:center;justify-content:space-between;padding:18px 20px 12px;background:#fff}header h2{margin:0;font-size:17px}header p{margin:3px 0 0;color:#667085;font-size:11px}#closePanel{width:32px;height:32px;border-radius:10px;background:#f2f4f7;color:#475467;font-size:20px}
                nav{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:8px;background:#fff;border-bottom:1px solid #eaecf0}nav button{padding:8px 4px;border-radius:9px;background:transparent;color:#667085;font-size:12px}nav button.active{background:#101828;color:#fff}
                main{overflow:auto;padding:12px}section[data-page]{display:none;gap:10px;flex-direction:column}section[data-page].active{display:flex}
                .hero{padding:16px;border-radius:16px;background:linear-gradient(135deg,#101828,#344054);color:#fff}.hero-row{display:flex;justify-content:space-between;align-items:center}.hero strong{font-size:22px}.hero small{color:#d0d5dd}
                .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.stat,.card{padding:13px;border:1px solid #eaecf0;border-radius:14px;background:#fff}.stat b{display:block;font-size:18px}.stat span,.muted{color:#667085;font-size:11px}
                .card h3{margin:0 0 10px;font-size:13px}.row{display:flex;align-items:center;gap:8px}.row.wrap{flex-wrap:wrap}.row.between{justify-content:space-between}.stack{display:grid;gap:8px}.field{display:grid;gap:4px;color:#475467;font-size:12px}.field input,.field select,#lowQualityDbUrlInput{width:100%;height:36px;padding:0 10px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#101828;outline:none}.field input:focus,#lowQualityDbUrlInput:focus{border-color:#fb7299;box-shadow:0 0 0 3px #fb72991c}
                .switch{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 0;font-size:12px}.switch input{appearance:none;width:36px;height:20px;border-radius:20px;background:#d0d5dd;position:relative;transition:.15s}.switch input:after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;transition:.15s}.switch input:checked{background:#fb7299}.switch input:checked:after{left:19px}
                .primary,.secondary,.danger{min-height:34px;padding:0 12px;border-radius:9px;font-size:12px;font-weight:650}.primary{background:#fb7299;color:#fff}.secondary{background:#f2f4f7;color:#344054}.danger{background:#fff1f3;color:#c01048}.notice{padding:10px;border-radius:10px;background:#fff6ed;color:#9a3412;font-size:11px;line-height:1.55}.list{max-height:150px;overflow:auto;border-radius:10px;background:#f9fafb;padding:8px;font-size:11px;color:#475467}.list:empty:after{content:"暂无内容";color:#98a2b3}.list button{padding:3px 7px;border-radius:6px;background:#fee4e2;color:#b42318;font-size:10px}#logInfo{min-height:120px;white-space:normal;line-height:1.6}.repo-off{color:#b54708}.repo-on{color:#067647}
                @media(max-width:520px){#controlPanel{width:calc(100vw - 20px);max-height:calc(100vh - 78px)}.stats{grid-template-columns:1fr 1fr}.stats .stat:last-child{grid-column:1/-1}}
            </style>
            <div id="launcher" title="打开 Bilibili 视频筛选器"><span>视频筛选器</span><i id="launcherCount">0</i></div>
            <div id="controlPanel" class="${isPanelVisible ? '' : 'is-hidden'}">
                <header><div><h2>Bilibili 视频筛选器</h2><p id="enginePage">正在识别当前页面…</p></div><button id="closePanel" aria-label="关闭">×</button></header>
                <nav><button class="active" data-tab="detect">检测</button><button data-tab="subscribe">订阅</button><button data-tab="exceptions">例外</button><button data-tab="logs">日志</button></nav>
                <main>
                    <section data-page="detect" class="active">
                        <div class="hero"><div class="hero-row"><div><small>引擎状态</small><div><strong id="engineStatus">${isActive ? '运行中' : '已暂停'}</strong></div></div><button id="toggleDetection" class="${isActive ? 'danger' : 'primary'}">${isActive ? '暂停检测' : '开始检测'}</button></div></div>
                        <div class="stats"><div class="stat"><b id="detectedCount">0</b><span>已标记卡片</span></div><div class="stat"><b id="adapterCount">0</b><span>当前适配器</span></div><div class="stat"><b id="localRuleCount">${lowQualityAccounts.length}</b><span>本地名单规则</span></div></div>
                        <div class="card stack"><h3>显示与性能</h3><label class="field">短视频分界（秒）<input type="number" id="minDuration" min="1" value="${minDuration}"></label><label class="field">DOM 合并延迟（毫秒）<input type="number" id="debounceDelay" min="50" value="${debounceDelay}"></label><label class="field">命中后的显示方式<select id="styleChoice"><option ${styleChoice === '半透明' ? 'selected' : ''}>半透明</option><option ${styleChoice === '边框高亮' ? 'selected' : ''}>边框高亮</option><option ${styleChoice === '背景高亮' ? 'selected' : ''}>背景高亮</option><option ${styleChoice === '隐藏' ? 'selected' : ''}>隐藏</option></select></label></div>
                        <div class="card"><h3>检测规则</h3>${[
                            ['warnMarketingAccount','警惕营销号',settings.warnMarketingAccount],['warnLowQualityName','低质账号名特征',settings.warnLowQualityName],['warnClickbaitTitle','标题党特征',settings.warnClickbaitTitle],['warnFakeHacker','假黑客账号特征',settings.warnFakeHacker],['warnPseudoScience','伪科普标题特征',settings.warnPseudoScience],['warnSubscribedLowQualityAccount','启用已加载的名单规则',settings.warnSubscribedLowQualityAccount],['globalFollowException','已关注 UP 全局例外',settings.globalFollowException]
                        ].map(([id,label,on]) => `<label class="switch"><span>${label}</span><input type="checkbox" id="${id}" ${on ? 'checked' : ''}></label>`).join('')}<div class="row wrap"><button id="addCustomRule" class="secondary">添加自定义规则</button></div></div>
                    </section>
                    <section data-page="subscribe">
                        <div class="card stack"><div class="row between"><div><h3 style="margin-bottom:3px">仓库名单</h3><div id="repoState" class="muted"></div></div><label class="switch"><input type="checkbox" id="repoSubscriptionEnabled" ${repoSubscriptionEnabled ? 'checked' : ''}></label></div><div class="notice">默认关闭且不会发起网络请求。开启后立即读取本仓库 blocklist.json，并在超过 12 小时时自动刷新。</div><button id="refreshLowQualityDb" class="primary">立即更新已启用订阅</button><div id="lowQualityDbInfo" class="muted"></div></div>
                        <div class="card stack"><h3>自定义订阅</h3><div class="row"><input id="lowQualityDbUrlInput" placeholder="https://example.com/blocklist.json"><button id="addDbUrl" class="secondary">添加</button></div><div id="lowQualityDbUrlList" class="list"></div><button id="clearLowQualityDb" class="danger">清空本地名单缓存</button></div>
                        <div class="card stack"><h3>批量拉黑</h3><div class="notice">${AUTO_BLOCK_WARNING}</div><div class="row wrap"><button id="autoBlockSubscribedAccounts" class="danger">按当前名单自动拉黑</button><button id="stopAutoBlock" class="secondary" disabled>停止</button></div><div id="autoBlockStatus" class="list"></div></div>
                    </section>
                    <section data-page="exceptions">
                        <div class="card stack"><div class="row between"><h3>全局例外</h3><div class="row"><button id="addManualException" class="secondary">添加</button><button id="clearExceptions" class="danger">清空</button></div></div><div id="exceptionList" class="list"></div></div>
                        <div class="card stack"><div class="row between"><h3>已关注 UP 缓存</h3><button id="clearFollowedExceptions" class="danger">清空缓存</button></div><div id="followedExceptionInfo" class="list"></div></div>
                    </section>
                    <section data-page="logs"><div class="card stack"><div class="row between"><h3>本页命中记录</h3><button id="clearLogs" class="secondary">清空显示</button></div><div id="logInfo" class="list"></div></div><div class="notice">页面适配器只读取卡片已有 DOM，不请求视频详情接口。UID 优先从空间链接和 data 属性提取，BV 号同时支持普通视频链接与稍后再看链接。</div></section>
                </main>
            </div>`;

        document.body.appendChild(panelHost);
        ui('launcher').onclick = togglePanel;
        ui('closePanel').onclick = closePanel;
        panelRoot.querySelectorAll('[data-tab]').forEach((button) => {
            button.onclick = () => showPanelTab(button.dataset.tab);
        });
        ['minDuration', 'debounceDelay', 'styleChoice', 'warnMarketingAccount', 'warnLowQualityName', 'warnClickbaitTitle', 'warnFakeHacker', 'warnPseudoScience', 'warnSubscribedLowQualityAccount', 'globalFollowException'].forEach((id) => {
            ui(id).onchange = updateSettings;
        });
        ui('toggleDetection').onclick = toggleDetection;
        ui('repoSubscriptionEnabled').onchange = toggleRepoSubscription;
        ui('addCustomRule').onclick = addCustomRule;
        ui('clearLogs').onclick = clearLogs;
        ui('addManualException').onclick = addManualException;
        ui('clearExceptions').onclick = clearExceptions;
        ui('clearFollowedExceptions').onclick = clearFollowedExceptions;
        ui('addDbUrl').onclick = addDbUrl;
        ui('refreshLowQualityDb').onclick = () => refreshLowQualityDb(true);
        ui('clearLowQualityDb').onclick = clearLowQualityDb;
        ui('autoBlockSubscribedAccounts').onclick = autoBlockSubscribedAccounts;
        ui('stopAutoBlock').onclick = stopAutoBlock;
        refreshPanelLists();
        updateLogInfo();
    }

    function showPanelTab(name) {
        panelRoot.querySelectorAll('[data-tab]').forEach((item) => item.classList.toggle('active', item.dataset.tab === name));
        panelRoot.querySelectorAll('[data-page]').forEach((item) => item.classList.toggle('active', item.dataset.page === name));
    }

    function togglePanel() {
        isPanelVisible = !isPanelVisible;
        localStorage.setItem(KEY.isPanelVisible, isPanelVisible);
        ui('controlPanel')?.classList.toggle('is-hidden', !isPanelVisible);
    }

    function toggleDetection() {
        isActive = !isActive;
        localStorage.setItem(KEY.isActive, isActive);
        ui('toggleDetection').textContent = isActive ? '暂停检测' : '开始检测';
        ui('toggleDetection').className = isActive ? 'danger' : 'primary';
        ui('engineStatus').textContent = isActive ? '运行中' : '已暂停';
        if (!isActive) {
            clearMarkers();
        } else {
            runDetection();
        }
    }

    function closePanel() {
        isPanelVisible = false;
        localStorage.setItem(KEY.isPanelVisible, isPanelVisible);
        ui('controlPanel')?.classList.add('is-hidden');
    }

    function updateSettings() {
        minDuration = loadNumberFromInput('minDuration', 300);
        debounceDelay = loadNumberFromInput('debounceDelay', 500);
        styleChoice = ui('styleChoice').value;
        settings.warnMarketingAccount = ui('warnMarketingAccount').checked;
        settings.warnLowQualityName = ui('warnLowQualityName').checked;
        settings.warnClickbaitTitle = ui('warnClickbaitTitle').checked;
        settings.warnFakeHacker = ui('warnFakeHacker').checked;
        settings.warnPseudoScience = ui('warnPseudoScience').checked;
        settings.warnSubscribedLowQualityAccount = ui('warnSubscribedLowQualityAccount').checked;
        settings.globalFollowException = ui('globalFollowException').checked;

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

        requestFullScan();
    }

    function loadNumberFromInput(id, fallback) {
        const value = parseInt(ui(id).value, 10);
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
        const input = ui('lowQualityDbUrlInput');
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

    function getActiveDbUrls() {
        return repoSubscriptionEnabled
            ? [DEFAULT_BLOCKLIST_URL, ...lowQualityDbUrls]
            : [...lowQualityDbUrls];
    }

    function getActiveLowQualityAccounts() {
        return lowQualityAccounts.filter((item) => item.source !== DEFAULT_BLOCKLIST_URL || repoSubscriptionEnabled);
    }

    async function toggleRepoSubscription() {
        repoSubscriptionEnabled = ui('repoSubscriptionEnabled').checked;
        localStorage.setItem(KEY.repoSubscriptionEnabled, repoSubscriptionEnabled);
        refreshPanelLists();
        requestFullScan();
        if (repoSubscriptionEnabled) await refreshLowQualityDb(true);
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
        const activeUrls = getActiveDbUrls();
        if (!activeUrls.length) {
            if (showAlert) alert('还没有添加订阅 URL。');
            return { count: 0, errors: ['还没有添加订阅 URL'] };
        }

        const allAccounts = [];
        const errors = [];

        for (const url of activeUrls) {
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
            const tip = tipParts.join('|').trim() || '低质迷因';
            const parsed = parseTypedValue(mainPart.trim());
            if (!parsed) return null;
            return { type: parsed.type, value: parsed.value, tip, source: sourceUrl };
        }

        if (item && typeof item === 'object') {
            const tip = String(item.tip || item.reason || '低质迷因');
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
        const list = ui('exceptionList');
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
        const info = ui('followedExceptionInfo');
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
        const info = ui('lowQualityDbInfo');
        if (!info) return;
        const uidCount = getSubscribedUids().length;
        const activeCount = getActiveDbUrls().length;
        info.textContent = `启用 ${activeCount} 个来源；当前生效 ${getActiveLowQualityAccounts().length} 条（UID ${uidCount} 条）；上次更新：${lowQualityDbLastUpdate}`;
        const state = ui('repoState');
        if (state) {
            state.className = repoSubscriptionEnabled ? 'muted repo-on' : 'muted repo-off';
            state.textContent = repoSubscriptionEnabled ? '已启用 · 会自动刷新' : '未启用 · 不会请求仓库';
        }
        const count = ui('localRuleCount');
        if (count) count.textContent = String(getActiveLowQualityAccounts().length);
    }

    function renderAutoBlockStatus() {
        const status = ui('autoBlockStatus');
        const startButton = ui('autoBlockSubscribedAccounts');
        const stopButton = ui('stopAutoBlock');
        if (!status) return;

        status.textContent = autoBlockState.running
            ? `处理中 ${autoBlockState.processed}/${autoBlockState.total}；成功 ${autoBlockState.success}，失败 ${autoBlockState.failed}。${autoBlockState.lastMessage}`
            : `${autoBlockState.lastMessage}；成功 ${autoBlockState.success}，失败 ${autoBlockState.failed}。`;

        if (startButton) startButton.disabled = autoBlockState.running;
        if (stopButton) stopButton.disabled = !autoBlockState.running;
    }

    function getSubscribedUids() {
        const uids = getActiveLowQualityAccounts()
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
        if (!getActiveLowQualityAccounts().length && getActiveDbUrls().length) {
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
        const list = ui('lowQualityDbUrlList');
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
        detectionLog = [];
        updateLogInfo();
    }

    function updateLogInfo() {
        const count = detectedElements.size;
        const logDiv = ui('logInfo');
        const countNode = ui('detectedCount');
        const launcherCount = ui('launcherCount');
        if (countNode) countNode.textContent = String(count);
        if (launcherCount) launcherCount.textContent = String(count);
        if (!logDiv) return;
        logDiv.innerHTML = detectionLog.length
            ? detectionLog.slice(0, 30).map((item) => `<div><b>${escapeHtml(item.reason)}</b> · ${escapeHtml(item.title || item.upName || item.bvid || '未知卡片')} <span class="muted">[${escapeHtml(item.adapter)}]</span></div>`).join('')
            : '<span class="muted">当前没有检测日志。</span>';
    }

    function convertDurationToSeconds(durationText) {
        const matches = String(durationText ?? '').match(/(?:\d{1,3}:)?\d{1,2}:\d{2}/g);
        if (!matches?.length) return 0;
        const timeParts = matches[matches.length - 1].split(':').map(Number);
        if (timeParts.some((part) => !Number.isFinite(part))) return 0;
        if (timeParts.length === 2) return timeParts[0] * 60 + timeParts[1];
        return timeParts[0] * 3600 + timeParts[1] * 60 + timeParts[2];
    }

    function unmarkCard(element) {
        const item = detectedElements.get(element);
        if (!item) return;
        element.style.opacity = item.previousStyle.opacity;
        element.style.border = item.previousStyle.border;
        element.style.backgroundColor = item.previousStyle.backgroundColor;
        element.style.display = item.previousStyle.display;
        element.style.position = item.previousStyle.position;
        element.querySelector(':scope > .bbbl-card-warning')?.remove();
        detectedElements.delete(element);
    }

    function clearMarkers() {
        Array.from(detectedElements.keys()).forEach(unmarkCard);
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
        if (styleChoice === '半透明') element.style.opacity = '0.46';
        if (styleChoice === '边框高亮') element.style.border = '2px solid #f04438';
        if (styleChoice === '背景高亮') element.style.backgroundColor = 'rgba(240,68,56,.14)';
        if (styleChoice === '隐藏') element.style.display = 'none';

        if (warningText && styleChoice !== '隐藏') {
            const warning = document.createElement('div');
            warning.className = 'bbbl-card-warning';
            warning.style.cssText = 'position:absolute;top:8px;left:8px;display:flex;align-items:center;gap:6px;max-width:calc(100% - 16px);padding:5px 7px;border-radius:8px;background:#d92d20;color:#fff;font:600 12px/1.2 "Microsoft YaHei",sans-serif;z-index:9999;box-shadow:0 4px 12px #1018283d;';
            const text = document.createElement('span');
            text.textContent = warningText;
            const button = document.createElement('button');
            button.textContent = '例外';
            button.title = '以后不再标记此视频或 UP';
            button.style.cssText = 'border:0;border-radius:5px;padding:2px 5px;background:#fff;color:#b42318;cursor:pointer;font:inherit;';
            button.onclick = (event) => {
                event.preventDefault();
                event.stopPropagation();
                addExceptionFromCard(info);
            };
            warning.append(text, button);
            element.style.position = 'relative';
            element.appendChild(warning);
        }
        return previousStyle;
    }

    function extractUid(value) {
        const text = String(value ?? '');
        const spaceMatch = text.match(/(?:https?:)?\/\/space\.bilibili\.com\/(\d+)/i);
        if (spaceMatch) return spaceMatch[1];
        const dataMatch = text.match(/^(\d{3,})$/);
        return dataMatch ? dataMatch[1] : '';
    }

    function extractBvid(value) {
        const match = String(value ?? '').match(/(?:\/video\/|[?&]bvid=)(BV[0-9A-Za-z]+)/i)
            || String(value ?? '').match(/\b(BV[0-9A-Za-z]{8,})\b/i);
        return match ? match[1] : '';
    }

    function firstElement(root, selectors) {
        for (const selector of selectors) {
            if (root.matches?.(selector)) return root;
            const found = root.querySelector?.(selector);
            if (found) return found;
        }
        return null;
    }

    function cleanLabel(element) {
        return String(element?.getAttribute?.('title') || element?.getAttribute?.('aria-label') || element?.textContent || '')
            .replace(/\s+/g, ' ').trim();
    }

    function cleanUpName(element) {
        return cleanLabel(element)
            .replace(/^UP主[:：]?\s*/i, '')
            .replace(/\s*[·・]\s*(?:\d{4}-)?\d{1,2}-\d{1,2}.*$/, '')
            .trim();
    }

    function getCardInfo(card, adapter) {
        const context = adapter.contextSelector ? (card.closest(adapter.contextSelector) || card) : card;
        const videoLink = firstElement(card, [
            'a[href*="/video/BV"]', 'a[href*="bvid=BV"]', 'a[href*="/list/watchlater/"]',
        ]);
        const titleElement = firstElement(card, [
            '.bili-video-card__info--tit a', '.bili-video-card__info--tit', '.bili-video-card__title a',
            '.bili-video-card__title', '.bili-dyn-card-video__title', '.title a', 'a.title', '.title',
            '.info > a[href*="/video/"]', 'img[alt]',
        ]) || videoLink;
        const authorLink = firstElement(context, ['a[href*="space.bilibili.com/"]', 'a[href^="//space.bilibili.com/"]']);
        const upNameElement = firstElement(context, [
            '.bili-video-card__info--author', '.bili-video-card__info--owner', '.bili-video-card__info--bottom .name',
            '.upname .name', '.up-name', '.name', 'a[href*="space.bilibili.com/"]',
        ]) || authorLink;
        const durationElement = firstElement(card, [
            '.bili-video-card__stats__duration', '.bili-cover-card__stats__duration', '.bili-dyn-card-video__duration',
            '.duration', '.time', '[class*="duration"]',
        ]);
        const dataOwner = firstElement(context, ['[data-mid]', '[data-uid]']);
        const href = videoLink?.href || card.href || '';
        let durationText = cleanLabel(durationElement);
        const inlineTimes = String(card.innerText || '').match(/(?:\d{1,3}:)?\d{1,2}:\d{2}/g);
        if (inlineTimes?.length) durationText = inlineTimes[inlineTimes.length - 1];
        return {
            element: card,
            context,
            adapterId: adapter.id,
            adapterLabel: adapter.label,
            upName: cleanUpName(upNameElement),
            title: cleanLabel(titleElement) || cleanLabel(videoLink?.querySelector?.('img[alt]')),
            durationText,
            uid: extractUid(authorLink?.href || '') || extractUid(dataOwner?.dataset?.mid || dataOwner?.dataset?.uid || '') || extractUid(context.dataset?.mid || context.dataset?.uid || ''),
            bvid: extractBvid(href),
            videoUrl: href,
        };
    }

    function isFollowedCard(info) {
        const candidates = Array.from(info.context.querySelectorAll([
            '.bili-video-card__info--icon-text', '.bili-video-card__info--follow', '.followed',
            '[title*="已关注"]', '[aria-label*="已关注"]',
        ].join(',')));
        return candidates.some((element) => `${element.textContent || ''} ${element.title || ''} ${element.getAttribute('aria-label') || ''}`.includes('已关注'));
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

        for (const item of getActiveLowQualityAccounts()) {
            const value = String(item.value ?? '').trim();
            const normalizedValue = normalizeText(value);
            if (!value) continue;

            if (item.type === 'uid' && info.uid && value === info.uid) return item;
            if (item.type === 'upName' && upName && normalizedValue === upName) return item;
            if (item.type === 'keyword' && normalizedValue && (title.includes(normalizedValue) || upName.includes(normalizedValue))) return item;
        }
        return null;
    }

    function getCurrentAdapter() {
        return DOM_ADAPTERS.find((adapter) => adapter.matches(location)) || DOM_ADAPTERS[DOM_ADAPTERS.length - 1];
    }

    function collectCards(root, adapter) {
        const cards = new Set();
        for (const selector of adapter.selectors) {
            if (root instanceof Element) {
                if (root.matches(selector)) cards.add(root);
                const ancestor = root.closest(selector);
                if (ancestor) cards.add(ancestor);
            }
            root.querySelectorAll?.(selector).forEach((card) => cards.add(card));
        }
        return Array.from(cards);
    }

    function evaluateRules(info) {
        const dbMatch = settings.warnSubscribedLowQualityAccount ? matchLowQualityDb(info) : null;
        if (dbMatch) return dbMatch.tip || '低质迷因';
        if (settings.warnMarketingAccount && info.upName.includes('观察')) return '警惕营销号';
        if (settings.warnLowQualityName && (info.upName.match(/_/g) || []).length >= 2) return '小心科技区小学生低质视频';
        if (settings.warnClickbaitTitle && (info.title.match(/[!！]/g) || []).length >= 2) return '小心标题党';
        if (settings.warnFakeHacker && /(黑客|网安|白帽)/.test(info.upName)) return '警惕假黑客';
        if (settings.warnPseudoScience && /(禁止废话|废话)/.test(info.title)) return '小心伪科普';
        for (const rule of customRules) {
            if ((info.upName && info.upName.includes(rule.keyword)) || (info.title && info.title.includes(rule.keyword))) return rule.tip;
        }
        const durationInSeconds = convertDurationToSeconds(info.durationText);
        if (durationInSeconds > 0 && durationInSeconds < minDuration) return durationInSeconds < 60 ? '小心沉迷短视频！' : '短视频';
        return '';
    }

    function processCard(card, adapter) {
        if (!card.isConnected || card.closest('#bbbl-control-host')) return;
        const info = getCardInfo(card, adapter);
        if (!info.bvid && !info.title) return;
        const fingerprint = `${engineRevision}|${info.bvid}|${info.uid}|${info.upName}|${info.title}|${info.durationText}`;
        if (processedCards.get(card) === fingerprint) return;
        processedCards.set(card, fingerprint);
        unmarkCard(card);

        if (isGlobalException(info)) return;
        if (isFollowedCard(info)) {
            rememberFollowedAccount(info);
            return;
        }
        if (isFollowedAccountException(info)) return;
        const warningText = evaluateRules(info);
        if (!warningText) return;

        const previousStyle = applyStyle(card, warningText, info);
        detectedElements.set(card, { element: card, previousStyle, warningText, info });
        detectionLog.unshift({ reason: warningText, title: info.title, upName: info.upName, bvid: info.bvid, adapter: info.adapterLabel });
        if (detectionLog.length > 100) detectionLog.length = 100;
    }

    function scanRoot(root = document) {
        if (!isActive) return;
        const adapter = getCurrentAdapter();
        collectCards(root, adapter).forEach((card) => processCard(card, adapter));
        for (const element of Array.from(detectedElements.keys())) {
            if (!element.isConnected) unmarkCard(element);
        }
        const page = ui('enginePage');
        const adapterCount = ui('adapterCount');
        if (page) page.textContent = `${adapter.label} · 增量 DOM 监听`;
        if (adapterCount) adapterCount.textContent = '1';
        updateLogInfo();
    }

    function requestFullScan() {
        engineRevision += 1;
        clearMarkers();
        if (isActive) scanRoot(document);
    }

    function runDetection() {
        requestFullScan();
    }

    const pendingRoots = new Set();
    let scanTimer = 0;
    function scheduleIncrementalScan(root) {
        if (!isActive || !root) return;
        pendingRoots.add(root.nodeType === Node.TEXT_NODE ? root.parentElement : root);
        clearTimeout(scanTimer);
        scanTimer = setTimeout(() => {
            const roots = Array.from(pendingRoots);
            pendingRoots.clear();
            roots.forEach((item) => item?.isConnected && scanRoot(item));
        }, Math.max(50, debounceDelay));
    }

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            scheduleIncrementalScan(mutation.target);
            mutation.addedNodes.forEach(scheduleIncrementalScan);
        }
    });

    function maybeAutoRefreshDb() {
        if (!getActiveDbUrls().length) return;
        const last = Date.parse(lowQualityDbLastUpdate);
        const twelveHours = 12 * 60 * 60 * 1000;
        if (!Number.isFinite(last) || Date.now() - last > twelveHours) {
            refreshLowQualityDb(false);
        }
    }

    async function enableAndRefreshRepository() {
        if (!repoSubscriptionEnabled) {
            repoSubscriptionEnabled = true;
            localStorage.setItem(KEY.repoSubscriptionEnabled, true);
            if (ui('repoSubscriptionEnabled')) ui('repoSubscriptionEnabled').checked = true;
        }
        refreshPanelLists();
        await refreshLowQualityDb(true);
    }

    function bootstrap() {
        initControlPanel();
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        if (isActive) requestFullScan();
        maybeAutoRefreshDb();
        setInterval(() => {
            if (location.href === currentRoute) return;
            currentRoute = location.href;
            requestFullScan();
        }, 1000);
    }

    if (document.body) bootstrap();
    else window.addEventListener('DOMContentLoaded', bootstrap, { once: true });

    GM_registerMenuCommand('显示/隐藏控制面板', togglePanel);

    GM_registerMenuCommand('清空已关注 UP 全局例外缓存', () => {
        clearFollowedExceptions();
    });

    GM_registerMenuCommand('启用/更新 BiliBili-BlockList', enableAndRefreshRepository);

    GM_registerMenuCommand('根据订阅黑名单自动拉黑', () => {
        autoBlockSubscribedAccounts();
    });
})();
