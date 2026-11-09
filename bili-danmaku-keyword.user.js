// ==UserScript==
// @name         B站直播关键词高亮
// @namespace    local.bili-danmaku-keyword
// @version      1.3.1
// @updateURL    https://raw.githubusercontent.com/areusa/bili-danmaku-keyword-release/main/bili-danmaku-keyword.user.js
// @downloadURL  https://raw.githubusercontent.com/areusa/bili-danmaku-keyword-release/main/bili-danmaku-keyword.user.js
// @description  本机配置关键词，高亮原生弹幕并保留昵称和命中记录，不额外连接弹幕服务器。
// @match        https://live.bilibili.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// ==/UserScript==

(() => {
  'use strict';
  if (document.getElementById('bdk-host')) return;
  const SETTINGS = 'bdk-settings-v1', HISTORY = 'bdk-history-v1';
  const BACKUPS = 'bdk-settings-backups-v1';
  const ROW = '.chat-item.danmaku-item';
  // 下列数据由defaults/exclusions.json生成；修改JSON后运行构建命令，不在面板列出。
  // 默认排除清单开始
  const DEFAULT_EXCLUSIONS = {
    "version": 1,
    "description": "内置排除词仅跳过高亮、记录和提醒，不隐藏原生弹幕。普通包含匹配，英文忽略大小写，可能误判；不代表平台官方词库。",
    "groups": [
      {
        "name": "隐私曝光与人肉",
        "terms": [
          "开盒",
          "人肉",
          "曝光",
          "中之人",
          "皮下"
        ]
      },
      {
        "name": "直接攻击与煽动",
        "terms": [
          "废物",
          "不去死",
          "冲了",
          "滚"
        ]
      },
      {
        "name": "明确广告与色情招揽",
        "terms": [
          "看黄",
          "加群",
          "加微",
          "看片",
          "刷单",
          "代刷人气"
        ]
      }
    ]
  };
  // 默认排除清单结束
  const exclusionTerms = DEFAULT_EXCLUSIONS.groups.flatMap(group => group.terms).map(term => term.toLowerCase());
  const excluded = text => exclusionTerms.some(term => text.toLowerCase().includes(term));
  // 从原生弹幕列表读取正文、可见昵称和消息标识。
  const adapter = {
    container: () => document.querySelector('#chat-history-list, .chat-history-list'),
    room: () => location.pathname.match(/^\/(?:blanc\/)?(\d+)(?:\/|$)/)?.[1] || '',
    read(row) {
      const body = row.querySelector('.danmaku-item-right');
      if (!body) return null;
      const text = row.getAttribute('data-danmaku') || body.textContent || '';
      if (!text.trim()) return null;
      const shown = row.querySelector('.user-name')?.textContent?.trim() || '';
      const original = row.getAttribute('data-uname') || '';
      const uname = original && (shown === original || shown.replace(/\s*[:：]\s*$/, '') === original)
        ? original : shown.replace(/\s*[:：]\s*$/, '') || '昵称未能读取';
      return { body, text, uname, id: row.getAttribute('data-id_str') || row.getAttribute('data-id-str') || '' };
    }
  };
  const defaults = () => ({ enabled: true, rooms: [], words: [], color: '#f4b740', sound: false, desktop: false });
  const tidyWords = entries => {
    const seen = new Set();
    return entries.flatMap(entry => {
      const text = String(typeof entry === 'string' ? entry : entry?.text || '').trim();
      const key = text.toLowerCase();
      if (!text || seen.has(key)) return [];
      seen.add(key);
      return [{ text, enabled: typeof entry === 'string' || entry.enabled !== false }];
    });
  };
  function normalize(raw) {
    const base = defaults();
    if (!raw || typeof raw !== 'object') return base;
    return { enabled: raw.enabled !== false,
      rooms: Array.isArray(raw.rooms) ? [...new Set(raw.rooms.map(String).filter(s => /^\d+$/.test(s)))] : base.rooms,
      words: tidyWords(Array.isArray(raw.words) ? raw.words : []),
      color: /^#[a-f\d]{6}$/i.test(raw.color || '') ? raw.color : base.color,
      sound: raw.sound === true, desktop: raw.desktop === true };
  }
  // 更新不改变脚本身份和存储键。异常设置不能按空词表写回。
  const clone = value => JSON.parse(JSON.stringify(value));
  function parseSettings(raw) {
    if (raw == null) return null;
    if (typeof raw === 'string') raw = JSON.parse(raw);
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.words)
      || raw.words.some(w => typeof w !== 'string' && (!w || typeof w.text !== 'string')))
      throw new Error('设置结构无法识别');
    return normalize(raw);
  }
  function readBackups() {
    const raw = GM_getValue(BACKUPS, []);
    if (!Array.isArray(raw)) throw new Error('备份结构无法识别');
    return raw.flatMap(item => { try { const value = parseSettings(item?.config); return value ? [{ at: item.at, config: value }] : []; } catch { return []; } });
  }
  let notice = '', config, records, hadStoredSettings = false;
  let historyGeneration = 'initial';
  const unsaved = new Map();
  try { config = parseSettings(GM_getValue(SETTINGS, null)); hadStoredSettings = !!config; }
  catch { notice = '设置读取失败；已保护原存储，正常修改不会将空设置覆盖回去。'; }
  if (!config) {
    try { config = readBackups()[0]?.config; if (config) notice += ' 已从本机自动备份载入设置。'; } catch { /* 保留原存储，不自动写入默认值。 */ }
  }
  config ||= defaults();
  let baseConfig = clone(config);
  function cleanHistory(raw) {
    return Array.isArray(raw) ? raw.filter(r => r && typeof r.id === 'string' && typeof r.room === 'string'
      && typeof r.text === 'string' && typeof r.uname === 'string' && typeof r.at === 'string'
      && Array.isArray(r.words) && r.words.every(w => typeof w === 'string')).slice(-500) : [];
  }
  function historyValue(raw) {
    return { generation: typeof raw?.generation === 'string' ? raw.generation : 'initial',
      entries: cleanHistory(Array.isArray(raw) ? raw : raw?.entries) };
  }
  try { const stored = historyValue(GM_getValue(HISTORY, [])); records = stored.entries; historyGeneration = stored.generation; }
  catch { records = []; notice = '记录读取失败，当前仅保留本页新记录。'; }
  let room = adapter.room(), container = null, observer = null, count = 0, lastAt = '';
  let nodeStates = new WeakMap(), baseline = new WeakSet(), invalid = new Set();
  const seen = new Map(), paint = new Map(), pending = new Set();
  let pendingTimer = 0, saveTimer = 0, uiTimer = 0, lastAlert = -Infinity, audio = null, stopped = false;
  const active = () => config.enabled && config.rooms.includes(room);
  const matches = text => config.words.filter(w => w.enabled && text.toLowerCase().includes(w.text.toLowerCase())).map(w => w.text);
  const host = document.createElement('div'); host.id = 'bdk-host';
  const shadow = host.attachShadow({ mode: 'open' });
  document.documentElement.append(host);
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'checked' || key === 'value' || key === 'hidden') node[key] = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    return node;
  }
  const button = (text, handler, cls = '') => el('button', { type: 'button', text, onclick: handler, class: cls });
  // MingCute 3.0.2 原始图标路径；许可与来源见 vendor/mingcute。
  const ICONS = {
  "chat": "<path fill=\"none\" stroke=\"currentColor\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M21 11.5c0 4.142-4.03 7.5-9 7.5-.687 0-1.357-.064-2-.186C9.5 18.72 9 20 7 20c0-.5.182-2.123-.5-2.563C4.371 16.065 3 13.917 3 11.5 3 7.358 7.03 4 12 4s9 3.358 9 7.5Z\"/>",
  "close": "<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-width=\"2\" d=\"m5.636 5.637 12.728 12.728m-12.728 0L18.364 5.637\"/>",
  "information": "<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M12 8h.002M11 11h1v6h.5m8.5-5a9 9 0 1 1-18 0 9 9 0 0 1 18 0\"/>",
  "hashtag": "<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-width=\"2\" d=\"M5 9h15M4.5 15h15M10 4 8 20m8-16-2 16\"/>",
  "history": "<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M12 7v5l3 3m5-3.03-1.607-.42a.1.1 0 0 0-.1.162l2.251 2.588c.052.06.15.038.17-.04q.148-.567.22-1.144A9.003 9.003 0 0 0 4.205 7.5 9 9 0 0 0 18.08 18.639\"/>",
  "storage": "<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-width=\"2\" d=\"M8 17h2M8 8h2M5 20h14a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1Zm0-9h14a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1Z\"/>",
  "check": "<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"m3.514 11.83 5.657 5.656L20.485 6.172\"/>",
  "add": "<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-width=\"2\" d=\"M5 12h14m-7 7V5\"/>",
  "volume": "<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M17 9.764A3 3 0 0 1 18 12c0 .888-.386 1.687-1 2.236m2-6.708A6 6 0 0 1 21 12a6 6 0 0 1-2 4.472M14 4v16l-6.74-4.814A1 1 0 0 0 6.68 15H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h2.68a1 1 0 0 0 .58-.186z\"/>",
  "notification": "<path fill=\"none\" stroke=\"currentColor\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M15 17a3 3 0 1 1-6 0M6 9v3.528a2 2 0 0 1-.211.894l-1.717 3.433a.1.1 0 0 0 .09.145h15.676a.1.1 0 0 0 .09-.145l-1.717-3.433a2 2 0 0 1-.211-.894V9A6 6 0 0 0 6 9Z\"/>",
  "play": "<path fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" d=\"M6.661 4.88a.47.47 0 0 1 .656-.378c1.032.441 3.375 1.502 6.354 3.222s5.071 3.22 5.97 3.893a.468.468 0 0 1 0 .755c-.889.667-2.954 2.148-5.97 3.89-3.019 1.742-5.334 2.79-6.356 3.226a.468.468 0 0 1-.653-.378c-.135-1.11-.389-3.662-.389-7.116 0-3.452.254-6.003.388-7.115Z\"/>",
  "copy": "<path fill=\"currentColor\" d=\"M8 11a1 1 0 1 0 0 2zm4 2a1 1 0 1 0 0-2zm-4 2a1 1 0 1 0 0 2zm2 2a1 1 0 1 0 0-2zm6-9h-1v12h2V8zm-1 13v-1H5v2h10zM4 20h1V8H3v12zM5 7v1h10V6H5zm3 5v1h4v-2H8zm0 4v1h2v-2H8zm12 0h1V4h-2v12zM19 3V2H9v2h10zM8 4H7v3h2V4zm8 13v1h3v-2h-3zM9 3V2a2 2 0 0 0-2 2h2zm11 1h1a2 2 0 0 0-2-2v2zm0 12h-1v2a2 2 0 0 0 2-2zM5 21v-1H3a2 2 0 0 0 2 2zm11-1h-1v2a2 2 0 0 0 2-2zm0-12h1a2 2 0 0 0-2-2v2zM4 8h1V6a2 2 0 0 0-2 2z\"/>",
  "delete": "<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-width=\"2\" d=\"m5 6 .876 13.133A2 2 0 0 0 7.87 21h8.258a2 2 0 0 0 1.995-1.867L19 6M8 6l.772-2.316A1 1 0 0 1 9.721 3h4.558a1 1 0 0 1 .949.684L16 6m-6 5v5m4-5v5M4 6h16\"/>",
  "download": "<path fill=\"currentColor\" d=\"M13 3a1 1 0 1 0-2 0zm-2 13a1 1 0 1 0 2 0zm-1.828-4a1 1 0 1 0-1.415 1.414l.707-.707zM12 16.243l-.707.707a1 1 0 0 0 1.414 0zm4.243-2.829A1 1 0 1 0 14.828 12l.708.707zM20 7h-1v13h2V7zm-1 14v-1H5v2h14zM4 20h1V7H3v13zM5 6v1h3V5H5zm11 0v1h3V5h-3zm-4-3h-1v13h2V3zm-3.536 9.707-.707.707 3.536 3.536.707-.707.707-.707L9.172 12zM12 16.243l.707.707 3.536-3.536-.707-.707-.708-.707-3.535 3.536zM4 7h1V5a2 2 0 0 0-2 2zm1 14v-1H3a2 2 0 0 0 2 2zm15-1h-1v2a2 2 0 0 0 2-2zm0-13h1a2 2 0 0 0-2-2v2z\"/>",
  "upload": "<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M8 9H6a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10a1 1 0 0 0-1-1h-2m-4-6v11m2.5-8.5L12 3 9.5 5.5\"/>",
  "recover": "<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"m4 11.97 1.607-.42a.1.1 0 0 1 .1.162L3.456 14.3a.098.098 0 0 1-.17-.04A9.003 9.003 0 0 1 19.794 7.5 9 9 0 0 1 5.92 18.64M12 7v5l3 3\"/>"
};
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('icon');
    // 仅解析上方固定图标资源，用户输入始终通过 textContent 写入。
    svg.innerHTML = ICONS[name]; return svg;
  }
  function iconButton(name, label, handler, cls = '') {
    const node = button('', handler, `icon-button ${cls}`);
    node.setAttribute('aria-label', label); node.dataset.tip = label; node.append(icon(name)); return node;
  }
  const css = el('style', { text: `
    :host{all:initial;--surface:var(--bg1,#fff);--soft:var(--bg2,#f6f7f8);--ink:var(--text1,#18191c);--muted:var(--text2,#61666d);--line:var(--line_regular,#e3e5e7);--accent:#008ac5;--tint:#e3f5fc;--danger:#b83b51;font:13px/1.6 "Microsoft YaHei",system-ui,sans-serif;color:var(--ink);color-scheme:light}
    *{box-sizing:border-box;min-width:0}button,input,textarea{font:inherit;color:inherit}button,input,label,summary{touch-action:manipulation}button{display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;border:1px solid var(--line);border-radius:6px;background:var(--surface);padding:6px 10px;min-height:32px;transition:background-color 160ms ease-out,color 160ms ease-out,border-color 160ms ease-out,transform 160ms ease-out}button:active{transform:scale(.96)}button:disabled{cursor:default;color:var(--muted);background:var(--soft)}button:focus-visible,input:focus-visible,textarea:focus-visible,[tabindex]:focus-visible{outline:2px solid #00aeec;outline-offset:2px}.icon{width:18px;height:18px;flex:none;pointer-events:none}.icon-button{width:32px;flex:none;padding:6px;border-color:transparent;background:transparent;color:var(--muted)}.icon-button.danger{color:var(--danger)}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
    [hidden]{display:none!important}.launch{position:fixed;right:16px;top:145px;z-index:2147483646;box-shadow:0 3px 12px #0001;gap:8px;max-width:calc(100vw - 24px)}.launch .icon{color:var(--accent)}.count{font-size:12px;font-variant-numeric:tabular-nums;color:var(--muted)}
    .panel{position:fixed;right:16px;top:76px;z-index:2147483647;display:flex;flex-direction:column;width:clamp(280px,calc(100vw - 32px),360px);max-width:calc(100% - 24px);min-height:min(240px,calc(100dvh - 92px));max-height:min(660px,calc(100dvh - 92px));overflow:hidden;background:var(--surface);border:1px solid var(--line);border-radius:10px;box-shadow:0 6px 24px #0002;opacity:1;transform:translateY(0);transition:opacity 160ms ease-out,transform 160ms ease-out,display 160ms ease-out allow-discrete}.panel[hidden]{opacity:0;transform:translateY(6px)}@starting-style{.panel{opacity:0;transform:translateY(6px)}}
    .head{display:flex;align-items:center;gap:8px;flex:none;padding:10px 12px 4px}.head>.icon{color:var(--accent)}h2{flex:1;font-size:14px;font-weight:600;margin:0}h3{font-size:13px;font-weight:500;margin:0}.switch{position:relative;display:flex;align-items:center;justify-content:center;width:36px;height:32px;cursor:pointer}.switch input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}.switch-track{width:30px;height:18px;background:#ccd0d7;border-radius:20px;pointer-events:none;transition:background-color 160ms ease-out}.switch-track:after{content:'';display:block;width:14px;height:14px;margin:2px;border-radius:50%;background:#fff;box-shadow:0 1px 2px #0002;transition:transform 160ms ease-out}.switch input:checked+.switch-track{background:var(--accent)}.switch input:checked+.switch-track:after{transform:translateX(12px)}.switch:has(input:focus-visible){outline:2px solid #00aeec;outline-offset:2px;border-radius:6px}
    .status{display:flex;align-items:center;gap:8px;padding:0 14px 10px;flex:none}.pill{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-size:12px}.pill:before{content:'';width:6px;height:6px;border-radius:50%;background:#23a275}.pill.warn:before{background:#d59a32}.stats{margin-left:auto;display:flex;align-items:center;gap:4px;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}.stats .icon{width:14px;height:14px}.status .icon-button{width:24px;min-height:24px;padding:3px}.hint{padding:0 14px 10px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}.hint:empty{display:none}
    .tabs{display:flex;align-items:center;gap:4px;padding:0 12px 8px;border-bottom:1px solid var(--line);flex:none}.tabs [role=tab]{border-color:transparent;background:transparent;color:var(--muted);flex:1}.tabs [aria-selected=true]{background:var(--tint);color:var(--accent)}.tabs [data-view=backup]{flex:0 0 32px}.view{overflow:auto;overscroll-behavior:contain;min-height:0;padding:12px 14px;scrollbar-width:thin;scrollbar-color:#ccd0d7 transparent;animation:view-in 160ms ease-out}.section{display:grid;gap:10px}.section+.section{margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}.line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.spread{justify-content:space-between}.muted{font-size:12px;color:var(--muted)}.field-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px}input[type=text],textarea{width:100%;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:7px 9px;transition:border-color 160ms ease-out}input[aria-invalid=true]{border-color:var(--danger)}textarea{display:block;resize:vertical;min-height:64px;max-height:min(160px,30dvh);height:68px;line-height:1.5}input::placeholder,textarea::placeholder{color:var(--muted)}.composer{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;align-items:end}.primary{background:var(--accent);color:#fff;border-color:var(--accent)}.word-heading{display:flex;align-items:center;gap:7px}.word-heading .color-control{margin-left:auto}.color-control{position:relative;display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:6px;cursor:pointer}.color-control input{position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer}.color-control:has(input:focus-visible){outline:2px solid #00aeec;outline-offset:2px}.color-dot{display:block;width:16px;height:16px;border-radius:50%;background:var(--highlight);border:2px solid var(--surface);box-shadow:0 0 0 1px var(--line);pointer-events:none}
    .words{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,125px),1fr));gap:4px 10px;max-height:180px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}.word{display:flex;align-items:center;gap:2px;border-bottom:1px solid var(--line);min-height:34px}.word label{display:flex;align-items:center;gap:6px;flex:1;cursor:pointer;overflow:hidden;min-height:32px}.word input{accent-color:var(--accent);flex:none;margin:0}.word-text{white-space:pre;overflow:hidden;text-overflow:ellipsis}.word:has(input:not(:checked)) .word-text{color:var(--muted);text-decoration:line-through}.word .icon-button{width:28px;min-height:28px;padding:5px}.word .icon{width:15px;height:15px}.toolbar{display:flex;align-items:center;gap:6px}.toolbar>.muted{flex:1}.toggle-icon{position:relative;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:1px solid var(--line);border-radius:6px;color:var(--muted);cursor:pointer;transition:background-color 160ms ease-out,color 160ms ease-out}.toggle-icon input{position:absolute;inset:0;margin:0;opacity:0;width:100%;height:100%;cursor:pointer}.toggle-icon:has(input:checked){color:var(--accent);background:var(--tint);border-color:#b2dfef}.toggle-icon:has(input:focus-visible){outline:2px solid #00aeec;outline-offset:2px}
    .records{display:grid}.record{padding:11px 0;border-bottom:1px solid var(--line);animation:view-in 160ms ease-out}.record:first-child{padding-top:2px}.record:last-child{border-bottom:0}.record-head{display:flex;align-items:center;gap:6px}.name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.record time{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}.record .icon-button{width:26px;min-height:26px;padding:4px}.record .icon{width:15px;height:15px}.record p{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}.record-meta{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--muted)}.tags{color:var(--accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.empty{grid-column:1/-1;display:flex;align-items:center;justify-content:center;gap:8px;padding:20px 0;color:var(--muted);font-size:12px}.more{width:100%;margin-top:8px}.note{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;padding:8px 14px;border-top:1px solid var(--line);color:var(--ink);background:var(--soft);flex:none;max-height:110px;overflow:auto;animation:view-in 160ms ease-out}.note:empty{display:none}
    .backup-view{display:block}.transfer-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;padding-bottom:12px;margin-bottom:12px;border-bottom:1px solid var(--line)}.transfer-tabs button{padding:6px 4px;font-size:12px;gap:4px;background:transparent;border-color:transparent}.transfer-tabs .icon{width:16px;height:16px}.transfer-tabs [aria-selected=true]{color:var(--accent);background:var(--tint)}.transfer-view{display:grid;gap:10px;align-content:start;animation:view-in 160ms ease-out}.transfer-view h3{font-weight:600}.transfer-view p{margin:0}.transfer-summary{display:flex;flex-wrap:wrap;gap:6px 16px;font-variant-numeric:tabular-nums}.transfer-action{width:100%;min-height:36px}.transfer-note{font-size:12px;overflow-wrap:anywhere;white-space:pre-wrap}.transfer-note:empty{display:none}.transfer-note.error{color:var(--danger)}.transfer-preview{display:grid;gap:10px;border-top:1px solid var(--line);padding-top:12px;animation:view-in 160ms ease-out}.transfer-preview strong{font-size:12px;font-weight:500;overflow-wrap:anywhere}.transfer-buttons{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px}.preview-words{display:flex;flex-wrap:wrap;gap:5px;max-height:120px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}.preview-words:empty{display:none}.preview-words span{padding:2px 6px;border-radius:4px;background:var(--soft);max-width:100%;overflow-wrap:anywhere;white-space:pre-wrap;font-size:12px}.transfer-view select{width:100%;min-width:0;min-height:36px;font:inherit;color:inherit;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:6px;cursor:pointer}.transfer-view select:focus-visible{outline:2px solid #00aeec;outline-offset:2px}.transfer-view select:disabled{cursor:default;color:var(--muted);background:var(--soft)}.paste-import summary{width:fit-content;color:var(--muted);font-size:12px;cursor:pointer;min-height:28px;line-height:28px}.paste-import form{display:grid;gap:8px;margin-top:8px;animation:view-in 160ms ease-out}.paste-import form button{justify-self:end}.paste-import summary:focus-visible{outline:2px solid #00aeec;outline-offset:2px}
    .preview-settings{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 10px;margin:0;font-size:12px}.preview-settings dt{color:var(--muted)}.preview-settings dd{margin:0;overflow-wrap:anywhere}
    .tooltip{max-height:calc(100dvh - 16px);overflow:hidden;position:fixed;z-index:2147483647;max-width:min(260px,calc(100vw - 16px));padding:7px 10px;background:var(--ink);color:var(--surface);border-radius:6px;box-shadow:0 3px 12px #0002;font-size:12px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere;pointer-events:none;opacity:0;visibility:hidden;transform:translateY(3px);transition:opacity 160ms ease-out,transform 160ms ease-out,visibility 160ms ease-out}.tooltip.show{opacity:1;visibility:visible;transform:translateY(0)}
    @media(hover:hover) and (pointer:fine){button:hover{background:var(--tint);color:var(--accent)}button.primary:hover{background:#0079ad;color:#fff}.danger:hover{background:#fff0f3;color:var(--danger)}.color-control:hover,.toggle-icon:hover{background:var(--soft)}}
    @media(pointer:coarse){.icon-button,.toggle-icon,.color-control,.switch{min-width:44px;min-height:44px}.word .icon-button,.record .icon-button,.status .icon-button{width:44px;min-height:44px}.tabs [data-view=backup]{flex-basis:44px}input[type=text],textarea{font-size:16px}.word label{min-height:44px}}
    @media(max-width:400px){.panel{right:12px;width:calc(100% - 24px)}.launch{right:12px}.head{padding-inline:10px}.view{padding-inline:12px}}
    @media(max-height:420px){.panel{top:12px;max-height:calc(100dvh - 24px);min-height:0}.head{padding-top:6px}.status{padding-bottom:4px}.launch{top:min(145px,calc(100dvh - 48px))}}
    @keyframes view-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
    @media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}}
  ` });
  shadow.append(css);
  const launcherCount = el('span', { class: 'count', text: '0' });
  const launcher = button('', () => openPanel(panel.hidden), 'launch');
  launcher.append(icon('chat'), el('span', { text: '弹幕关键词' }), launcherCount);
  launcher.setAttribute('aria-label', '打开关键词检测面板'); launcher.setAttribute('aria-expanded', 'false'); launcher.setAttribute('aria-controls', 'bdk-panel');
  const panel = el('section', { class: 'panel', id: 'bdk-panel', hidden: true, 'aria-label': '直播关键词检测面板' });
  const close = iconButton('close', '收起面板', () => openPanel(false));
  const enabled = el('input', { type: 'checkbox', 'aria-label': '启用检测', checked: config.enabled, onchange: () => { config.enabled = enabled.checked; saveConfig(); refresh(); } });
  panel.append(el('div', { class: 'head' }, icon('chat'), el('h2', { text: '弹幕关键词' }), el('label', { class: 'switch', 'data-tip': '启用 / 暂停检测' }, enabled, el('span', { class: 'switch-track' })), close));
  const stateBadge = el('span', { class: 'pill' }), stats = el('span', { class: 'stats' }), hint = el('div', { class: 'hint' });
  const statusInfo = iconButton('information', '检测状态详情', () => {});
  const statusSection = el('div', { class: 'status' }, stateBadge, stats, statusInfo);
  panel.append(statusSection, hint);
  const settingsView = el('div', { class: 'view', role: 'tabpanel', id: 'bdk-settings' }), historyView = el('div', { class: 'view', role: 'tabpanel', id: 'bdk-records' }), backupView = el('div', { class: 'view backup-view', role: 'tabpanel', id: 'bdk-backup' });
  const settingsTab = button('', () => selectTab('settings')), historyTab = button('', () => selectTab('history')), backupTab = iconButton('storage', '设置备份与恢复', () => selectTab('backup'));
  const wordCount = el('span', { class: 'count' }), historyTitle = el('span', { class: 'count' });
  settingsTab.append(icon('hashtag'), '关键词', wordCount); historyTab.append(icon('history'), '记录', historyTitle);
  const views = { settings: [settingsTab, settingsView], history: [historyTab, historyView], backup: [backupTab, backupView] };
  let layoutAnimation = null;
  function changeLayout(change) {
    const before = panel.getBoundingClientRect().height;
    layoutAnimation?.cancel(); change();
    const after = panel.getBoundingClientRect().height;
    if (!panel.hidden && before !== after && panel.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      layoutAnimation = panel.animate([{ height: `${before}px` }, { height: `${after}px` }], { duration: 160, easing: 'ease-out' });
  }
  for (const [name, [tab, view]] of Object.entries(views)) {
    tab.setAttribute('role', 'tab'); tab.dataset.view = name; tab.id = `${view.id}-tab`;
    tab.setAttribute('aria-controls', view.id); view.setAttribute('aria-labelledby', tab.id);
    tab.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault(); const names = Object.keys(views), index = names.indexOf(name);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? names.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + names.length) % names.length;
      selectTab(names[next]); views[names[next]][0].focus();
    });
  }
  function selectTab(which) {
    changeLayout(() => {
      for (const [name, [tab, view]] of Object.entries(views)) {
        view.hidden = name !== which; tab.setAttribute('aria-selected', String(name === which)); tab.tabIndex = name === which ? 0 : -1;
      }
    });
    resetTransfers();
    if (which === 'backup') refreshBackup();
  }
  panel.append(el('div', { class: 'tabs', role: 'tablist', 'aria-label': '面板内容' }, settingsTab, historyTab, backupTab), settingsView, historyView, backupView);
  const roomsInput = el('input', { id: 'bdk-rooms', type: 'text', value: config.rooms.join('、'), 'aria-label': '启用房间号', placeholder: '房间号，逗号分隔', autocomplete: 'off', spellcheck: 'false' });
  const saveRooms = () => {
    const tokens = roomsInput.value.split(/[\s,，、;；]+/).filter(Boolean);
    if (tokens.some(s => !/^\d+$/.test(s))) { roomsInput.setAttribute('aria-invalid', 'true'); return tell('请只填写房间号，用逗号或空格分隔。'); }
    roomsInput.removeAttribute('aria-invalid'); config.rooms = [...new Set(tokens)]; roomsInput.value = config.rooms.join('、'); const saved = saveConfig(); refresh(); if (saved) tell('已保存房间');
  };
  settingsView.append(el('form', { class: 'field-row', onsubmit: e => { e.preventDefault(); saveRooms(); } }, el('label', { for: 'bdk-rooms', text: '房间' }), roomsInput, iconButton('check', '保存房间', saveRooms)));
  const wordList = el('div', { class: 'words' });
  const wordInput = el('textarea', { id: 'bdk-words', 'aria-label': '添加关键词，每行一个', placeholder: '添加关键词，每行一个', autocomplete: 'off', spellcheck: 'false' });
  const addWords = () => {
    const entries = wordInput.value.split(/\r?\n/); const before = config.words.length;
    config.words = tidyWords([...config.words, ...entries]);
    wordInput.value = ''; const saved = saveConfig(); renderWords(); refresh();
    if (saved) tell(`已添加 ${config.words.length - before} 个关键词`);
    wordInput.focus();
  };
  wordInput.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addWords(); } });
  const color = el('input', { type: 'color', value: config.color, 'aria-label': '选择高亮颜色', onchange: () => { config.color = color.value; saveConfig(); updateNativeStyle(); } });
  const colorControl = el('label', { class: 'color-control', 'data-tip': '高亮颜色' }, color, el('span', { class: 'color-dot' }));
  colorControl.style.setProperty('--highlight', config.color);
  settingsView.append(el('div', { class: 'section', style: 'margin-top:12px' },
    el('div', { class: 'word-heading' }, el('label', { for: 'bdk-words', text: '关键词' }), colorControl), wordList,
    el('form', { class: 'composer', onsubmit: e => { e.preventDefault(); addWords(); } }, wordInput, iconButton('add', '添加关键词', addWords, 'primary'))));
  const sound = el('input', { type: 'checkbox', 'aria-label': '提示音', checked: config.sound, onchange: async () => {
    if (sound.checked) { try { await beep(); config.sound = true; tell('已启用提示音'); } catch { sound.checked = false; config.sound = false; tell('声音播放失败，请先点击页面或检查浏览器声音设置。'); } }
    else config.sound = false;
    saveConfig();
  } });
  const desktop = el('input', { type: 'checkbox', 'aria-label': '桌面通知', checked: config.desktop, onchange: async () => {
    if (desktop.checked) {
      try {
        if (!window.Notification) throw new Error();
        const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
        if (permission !== 'granted') throw new Error();
        config.desktop = true; tell('已启用桌面通知');
      } catch { desktop.checked = false; config.desktop = false; tell('桌面通知未获许可，请在浏览器网站设置中检查通知权限。'); }
    } else config.desktop = false;
    saveConfig();
  } });
  const testAlerts = async () => {
    if (!config.sound && !config.desktop) return tell('启用提示音或桌面通知后再测试。');
    await alertUser({ uname: '提醒测试', text: '这是一条本机测试，不会发送到直播间。', words: ['测试'] }, true);
  };
  settingsView.append(el('div', { class: 'section toolbar' }, el('span', { class: 'muted', text: '提醒' }),
    el('label', { class: 'toggle-icon', 'data-tip': '提示音 · 提醒间隔 5 秒' }, sound, icon('volume'), el('span', { class: 'sr-only', text: '提示音' })),
    el('label', { class: 'toggle-icon', 'data-tip': '桌面通知 · 提醒间隔 5 秒' }, desktop, icon('notification'), el('span', { class: 'sr-only', text: '桌面通知' })), iconButton('play', '测试通报', testAlerts)));
  const exportView = el('div', { class: 'transfer-view', role: 'tabpanel', id: 'bdk-export-view' });
  const importView = el('div', { class: 'transfer-view', role: 'tabpanel', id: 'bdk-import-view' });
  const recoveryView = el('div', { class: 'transfer-view', role: 'tabpanel', id: 'bdk-recovery-view' });
  const backupModes = { export: exportView, import: importView, recovery: recoveryView };
  const modeTabs = el('div', { class: 'transfer-tabs', role: 'tablist', 'aria-label': '备份操作' });
  let pendingImport = null, pendingRecovery = null, fileReadVersion = 0;
  const exportSummary = el('div', { class: 'transfer-summary' });
  const exportNote = el('div', { class: 'transfer-note', role: 'status', 'aria-live': 'polite' });
  const exportButton = button('导出 JSON 文件', exportSettings, 'primary transfer-action'); exportButton.prepend(icon('download'));
  exportView.append(el('h3', { text: '保存到文件' }), exportSummary,
    el('p', { class: 'muted', text: '全部房间、共用词表和提醒设置。不含命中记录。' }), exportButton, exportNote);
  const importNote = el('div', { class: 'transfer-note', role: 'status', 'aria-live': 'polite' });
  const importPreview = el('div', { class: 'transfer-preview', hidden: true, tabindex: '-1', 'aria-label': '导入预览' });
  const fileInput = el('input', { type: 'file', accept: '.json,application/json', hidden: true, 'aria-label': '选择设置 JSON 文件' });
  const fileButton = button('选择 JSON 文件', () => { fileInput.value = ''; fileInput.click(); }, 'transfer-action'); fileButton.prepend(icon('upload'));
  const importInput = el('textarea', { id: 'bdk-import', 'aria-label': '粘贴设置备份JSON', placeholder: '粘贴旧版备份 JSON', autocomplete: 'off', spellcheck: 'false' });
  const pasteDetails = el('details', { class: 'paste-import' }, el('summary', { text: '粘贴旧版 JSON' }),
    el('form', { onsubmit: e => { e.preventDefault(); previewImport(importInput.value, '粘贴的 JSON'); } }, importInput, button('预览 JSON', () => previewImport(importInput.value, '粘贴的 JSON'))));
  importInput.addEventListener('input', () => { pendingImport = null; fileReadVersion++; changeLayout(() => { importPreview.hidden = true; importNote.textContent = ''; }); });
  importInput.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); previewImport(importInput.value, '粘贴的 JSON'); } });
  pasteDetails.addEventListener('toggle', () => { if (pasteDetails.open) { fileReadVersion++; pendingImport = null; importPreview.hidden = true; importNote.textContent = ''; } });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]; if (!file) return;
    const request = ++fileReadVersion; pendingImport = null; importPreview.hidden = true; pasteDetails.open = false;
    if (!/\.json$/i.test(file.name)) return transferFeedback(importNote, '请选择 .json 文件。', true);
    if (file.size > 5 * 1024 * 1024) return transferFeedback(importNote, '文件超过 5 MB，请选择设置备份文件。', true);
    transferFeedback(importNote, '正在读取文件…');
    const reader = new FileReader();
    reader.onload = () => {
      if (request !== fileReadVersion) return;
      try { previewImport(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(reader.result)), file.name); }
      catch { transferFeedback(importNote, '文件不是有效的 UTF-8 文本，请另存为 UTF-8 后重试。', true); }
    };
    reader.onerror = () => { if (request === fileReadVersion) transferFeedback(importNote, '文件读取失败，请重新选择。', true); };
    reader.readAsArrayBuffer(file);
  });
  importView.append(el('h3', { text: '从文件导入' }), el('p', { class: 'muted', text: '先预览，再确认替换当前设置。' }), fileButton, fileInput, pasteDetails, importNote, importPreview);
  const recoverySelect = el('select', { id: 'bdk-recovery-source', 'aria-label': '找回来源' });
  const recoveryNote = el('div', { class: 'transfer-note', role: 'status', 'aria-live': 'polite' });
  const recoveryPreview = el('div', { class: 'transfer-preview', hidden: true, tabindex: '-1', 'aria-label': '找回预览' });
  const recoveryButton = button('预览可找回的词', () => {
    pendingRecovery = null; recoveryPreview.hidden = true;
    try {
      const stamp = JSON.stringify(GM_getValue(SETTINGS, null));
      let current; try { current = parseSettings(GM_getValue(SETTINGS, null)); } catch { /* 允许从预览恢复损坏的主设置。 */ }
      current ||= clone(config);
      const selected = recoverySelect.value;
      const snapshot = selected === 'history' ? null : readBackups()[Number(selected)];
      const words = selected === 'history' ? tidyWords(records.flatMap(r => r.words)) : snapshot?.config.words;
      if (!words) throw new Error('该快照已不可用，请重新选择。');
      const existing = new Set(current.words.map(w => w.text.toLowerCase()));
      const missing = words.filter(w => !existing.has(w.text.toLowerCase()));
      if (!missing.length) return transferFeedback(recoveryNote, '没有需要补回的关键词。');
      const source = selected === 'history' ? '命中记录' : `自动快照 · ${backupTime(snapshot.at)}`;
      pendingRecovery = { stamp, value: { ...current, words: tidyWords([...current.words, ...missing]) } };
      transferFeedback(recoveryNote, '');
      const apply = button(`补回 ${missing.length} 个关键词`, () => {
        if (!pendingRecovery) return;
        const item = pendingRecovery; pendingRecovery = null;
        if (applyBackup(item, recoveryNote)) { recoveryPreview.hidden = true; transferFeedback(recoveryNote, `已补回 ${missing.length} 个关键词`); recoveryButton.focus(); }
      }, 'primary');
      changeLayout(() => {
        recoveryPreview.replaceChildren(el('strong', { text: source }), el('p', { class: 'muted', text: '只补缺少的词，保留现有词的启停状态和其他设置。' }),
          el('div', { class: 'preview-words' }, ...missing.map(w => el('span', { class: w.enabled ? '' : 'muted', text: w.text + (w.enabled ? '' : '（停用）') }))),
          el('div', { class: 'transfer-buttons' }, button('取消找回', () => { pendingRecovery = null; changeLayout(() => { recoveryPreview.hidden = true; }); recoveryButton.focus(); }), apply));
        recoveryPreview.hidden = false;
      });
      recoveryPreview.focus();
    } catch (error) { transferFeedback(recoveryNote, `无法预览：${error.message}`, true); }
  }, 'transfer-action');
  recoverySelect.addEventListener('change', () => { pendingRecovery = null; recoveryButton.disabled = Number(recoverySelect.selectedOptions[0]?.dataset.missing || 0) === 0; changeLayout(() => { recoveryPreview.hidden = true; recoveryNote.textContent = ''; }); });
  recoveryView.append(el('h3', { text: '找回关键词' }), el('p', { class: 'muted', text: '只补回缺少的词，不替换整套设置。' }),
    el('label', { for: recoverySelect.id, text: '找回来源' }), recoverySelect, recoveryButton,
    el('p', { class: 'muted', text: '自动快照：修改设置时保存，最多 10 份，仅存本机。' }), recoveryNote, recoveryPreview);
  const modeLabels = { export: ['download', '导出文件'], import: ['upload', '导入文件'], recovery: ['recover', '找回词'] };
  for (const [mode, view] of Object.entries(backupModes)) {
    const tab = button('', () => selectBackupMode(mode)); tab.append(icon(modeLabels[mode][0]), modeLabels[mode][1]);
    tab.id = `${view.id}-tab`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', view.id); tab.dataset.backupMode = mode;
    view.setAttribute('aria-labelledby', tab.id); view.hidden = mode !== 'export'; tab.setAttribute('aria-selected', String(mode === 'export')); tab.tabIndex = mode === 'export' ? 0 : -1;
    tab.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault(); const modes = Object.keys(backupModes), index = modes.indexOf(mode);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (index + (e.key === 'ArrowRight' ? 1 : 2)) % 3;
      selectBackupMode(modes[next]); modeTabs.children[next].focus();
    });
    modeTabs.append(tab);
  }
  backupView.append(modeTabs, exportView, importView, recoveryView);
  function transferFeedback(target, text, error = false) {
    changeLayout(() => { target.textContent = text; target.classList.toggle('error', error); });
  }
  function resetTransfers() {
    fileReadVersion++; pendingImport = null; pendingRecovery = null;
    changeLayout(() => { importPreview.hidden = true; recoveryPreview.hidden = true; importNote.textContent = ''; recoveryNote.textContent = ''; });
  }
  function selectBackupMode(mode) {
    resetTransfers();
    changeLayout(() => {
      for (const [name, view] of Object.entries(backupModes)) view.hidden = name !== mode;
      for (const tab of modeTabs.children) { const selected = tab.dataset.backupMode === mode; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; }
    });
    refreshBackup();
  }
  function backupTime(at) {
    const date = new Date(at); return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false });
  }
  function refreshBackup() {
    let saved = config;
    try {
      const current = parseSettings(GM_getValue(SETTINGS, null));
      if (!current && hadStoredSettings) throw new Error('设置暂不可读');
      const value = current || config;
      saved = value;
      if (exportButton.disabled) exportNote.textContent = '';
      exportSummary.replaceChildren(el('span', { text: `${value.rooms.length} 个房间` }), el('span', { text: `${value.words.length} 个关键词` })); exportButton.disabled = false;
    } catch { exportButton.disabled = true; transferFeedback(exportNote, '设置读取失败，暂不能导出。', true); }
    const selected = recoverySelect.value;
    const existing = new Set(saved.words.map(w => w.text.toLowerCase()));
    const missingCount = words => words.filter(w => !existing.has(w.text.toLowerCase())).length;
    recoverySelect.replaceChildren();
    try {
      readBackups().forEach((item, i) => {
        const missing = missingCount(item.config.words);
        recoverySelect.append(el('option', { value: String(i), 'data-missing': String(missing), text: `自动快照 · ${backupTime(item.at)} · 可补 ${missing} 词` }));
      });
    } catch { transferFeedback(recoveryNote, '自动快照读取失败。', true); }
    if (records.some(r => r.words.length)) {
      const missing = missingCount(tidyWords(records.flatMap(r => r.words)));
      recoverySelect.append(el('option', { value: 'history', 'data-missing': String(missing), text: `命中记录 · 可补 ${missing} 词（仅含曾命中的词）` }));
    }
    const available = recoverySelect.options.length > 0;
    if (!available) recoverySelect.append(el('option', { value: '', text: '暂无可用快照或命中记录' }));
    const options = [...recoverySelect.options];
    const preferred = options.find(option => option.value === selected && Number(option.dataset.missing) > 0) || options.find(option => Number(option.dataset.missing) > 0);
    if (preferred) recoverySelect.value = preferred.value;
    recoverySelect.disabled = !available; recoveryButton.disabled = !preferred;
  }
  function exportSettings() {
    let url;
    try {
      const current = parseSettings(GM_getValue(SETTINGS, null));
      if (!current && hadStoredSettings) throw new Error('设置暂不可读');
      const now = new Date(), value = current || config;
      const stamp = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2, '0')).join('');
      const json = JSON.stringify({ format: 'bdk-settings-backup', version: 1, exportedAt: now.toISOString(), config: value }, null, 2) + '\n';
      url = URL.createObjectURL(new Blob([json], { type: 'application/json;charset=utf-8' }));
      const link = el('a', { href: url, download: `bili-keywords-settings-${stamp}.json`, hidden: true });
      shadow.append(link); try { link.click(); } finally { link.remove(); }
      transferFeedback(exportNote, '已发起 JSON 文件下载');
    } catch { transferFeedback(exportNote, '导出失败，请检查浏览器下载设置或重试。', true); }
    finally { if (url) setTimeout(() => URL.revokeObjectURL(url), 30000); }
  }
  function previewImport(text, source) {
    pendingImport = null; fileReadVersion++; importPreview.hidden = true;
    try {
      if (text.length > 5 * 1024 * 1024) throw new Error('内容超过 5 MB。');
      let parsed; try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('不是有效的设置JSON，请检查文件或粘贴内容。'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('不是设置备份。');
      if ('format' in parsed && (parsed.format !== 'bdk-settings-backup' || parsed.version !== 1)) throw new Error('不支持此备份格式或版本。');
      const raw = 'format' in parsed ? parsed.config : parsed;
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rooms) || !Array.isArray(raw.words)) throw new Error('备份缺少房间或关键词列表。');
      if (raw.rooms.some(r => !/^\d+$/.test(String(r))) || raw.words.some(w => typeof w !== 'string' && (!w || typeof w.text !== 'string' || ('enabled' in w && typeof w.enabled !== 'boolean')))) throw new Error('房间或关键词格式错误。');
      if (['enabled', 'sound', 'desktop'].some(key => key in raw && typeof raw[key] !== 'boolean') || ('color' in raw && !/^#[a-f\d]{6}$/i.test(raw.color))) throw new Error('开关或颜色格式错误。');
      const value = parseSettings(raw), stamp = JSON.stringify(GM_getValue(SETTINGS, null));
      let current; try { current = parseSettings(GM_getValue(SETTINGS, null)); } catch { /* 保留原始校验标记，确认后才替换损坏数据。 */ }
      current ||= config;
      pendingImport = { value, stamp };
      const oldWords = new Set(current.words.map(w => w.text.toLowerCase())), newWords = new Set(value.words.map(w => w.text.toLowerCase()));
      const removed = [...oldWords].filter(w => !newWords.has(w)).length, added = [...newWords].filter(w => !oldWords.has(w)).length;
      const confirm = button('确认替换设置', () => {
        if (!pendingImport) return;
        const item = pendingImport; pendingImport = null;
        if (applyBackup(item, importNote)) { importInput.value = ''; fileInput.value = ''; importPreview.hidden = true; transferFeedback(importNote, '已导入设置'); fileButton.focus(); }
      }, 'primary');
      transferFeedback(importNote, '');
      changeLayout(() => {
        importPreview.replaceChildren(el('strong', { class: 'source-name', text: source }),
          el('div', { class: 'transfer-summary' }, el('span', { text: `${current.rooms.length} → ${value.rooms.length} 个房间` }), el('span', { text: `${current.words.length} → ${value.words.length} 个关键词` })),
          el('p', { class: 'muted', text: `新增 ${added}，移除 ${removed}。房间、词表、颜色和提醒设置将被替换，命中记录保留。` }),
          el('dl', { class: 'preview-settings' }, el('dt', { text: '房间' }), el('dd', { text: value.rooms.join('、') || '未设置' }),
            el('dt', { text: '高亮' }), el('dd', { text: value.color }),
            el('dt', { text: '开关' }), el('dd', { text: `检测${value.enabled ? '开' : '关'} · 提示音${value.sound ? '开' : '关'} · 通知${value.desktop ? '开' : '关'}` })),
          el('div', { class: 'preview-words' }, ...value.words.map(w => el('span', { class: w.enabled ? '' : 'muted', text: w.text + (w.enabled ? '' : '（停用）') }))),
          el('div', { class: 'transfer-buttons' }, button('取消导入', () => { pendingImport = null; changeLayout(() => { importPreview.hidden = true; }); fileButton.focus(); }), confirm));
        importPreview.hidden = false;
      });
      importPreview.focus();
    } catch (error) { transferFeedback(importNote, `无法导入：${error.message}`, true); }
  }
  function applyBackup(item, feedback) {
    try {
      if (JSON.stringify(GM_getValue(SETTINGS, null)) !== item.stamp) { resetTransfers(); refreshBackup(); transferFeedback(feedback, '设置已在其他页面改变，请重新预览。', true); return false; }
    } catch { transferFeedback(feedback, '设置读取失败，未执行替换。', true); return false; }
    const previous = clone(config); config = clone(item.value);
    if (saveConfig(true, true)) return true;
    config = previous; syncSettingsUI(); tell('');
    transferFeedback(feedback, '保存未通过校验，当前界面已恢复；请重新打开面板核实存储，自动快照中可查找原设置。', true); return false;
  }
  const recordList = el('div', { class: 'records' }), more = button('再显示 50 条', () => { visibleRecords += 50; renderRecords(); }, 'more');
  let visibleRecords = 50;
  const clearRecords = iconButton('delete', '清空记录', () => {
    if (!records.length) return;
    if (!window.confirm('清空本机的全部命中记录？此操作无法撤销。')) return;
    records = []; unsaved.clear(); clearTimeout(saveTimer); saveTimer = 0;
    historyGeneration = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try { GM_setValue(HISTORY, { generation: historyGeneration, entries: [] }); tell('本机命中记录已清空'); }
    catch { tell('本页记录已清空，但存储清空失败，请检查油猴存储。'); }
    renderRecords();
  }, 'danger');
  historyView.append(el('div', { class: 'line spread' }, el('span', { class: 'muted', text: '最近命中', 'data-tip': '仅存本机，最多 500 条；现有弹幕只高亮，不补记。', tabindex: '0' }), clearRecords), recordList, more);
  const message = el('div', { class: 'note', role: 'status', 'aria-live': 'polite' });
  panel.append(message);
  const tooltip = el('div', { class: 'tooltip', id: 'bdk-tooltip', role: 'tooltip' });
  shadow.append(launcher, panel, tooltip);
  let tipTarget = null, tipTimer = 0, tipWarmUntil = 0;
  function hideTip() {
    clearTimeout(tipTimer); tipTarget?.removeAttribute('aria-describedby'); tipTarget = null;
    tooltip.classList.remove('show'); tipWarmUntil = Date.now() + 300;
  }
  function showTip(target, immediate = false) {
    clearTimeout(tipTimer); tipTarget?.removeAttribute('aria-describedby'); tipTarget = target;
    const display = () => {
      if (!target.isConnected || !target.getClientRects().length) return;
      tooltip.textContent = target.dataset.tip; target.setAttribute('aria-describedby', tooltip.id);
      const rect = target.getBoundingClientRect();
      tooltip.style.left = '8px'; tooltip.style.top = '8px';
      const width = tooltip.offsetWidth, height = tooltip.offsetHeight;
      tooltip.style.left = `${Math.max(8, Math.min(document.documentElement.clientWidth - width - 8, rect.left + rect.width / 2 - width / 2))}px`;
      tooltip.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, rect.top >= height + 12 ? rect.top - height - 7 : rect.bottom + 7))}px`;
      tooltip.classList.add('show');
    };
    if (immediate || Date.now() < tipWarmUntil) display(); else tipTimer = setTimeout(display, 250);
  }
  shadow.addEventListener('pointerover', e => { const target = e.target.closest?.('[data-tip]'); if (target && target !== tipTarget) showTip(target); });
  shadow.addEventListener('pointerout', e => { if (tipTarget && !tipTarget.contains(e.relatedTarget)) hideTip(); });
  shadow.addEventListener('focusin', e => { const target = e.target.closest?.('[data-tip]'); if (target) showTip(target, true); });
  shadow.addEventListener('focusout', hideTip);
  shadow.addEventListener('click', hideTip);
  statusInfo.addEventListener('click', e => { e.stopPropagation(); showTip(statusInfo, true); });
  shadow.addEventListener('scroll', hideTip, true); window.addEventListener('resize', hideTip);
  panel.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    e.stopPropagation(); if (tooltip.classList.contains('show')) hideTip(); else openPanel(false);
  });
  function openPanel(open) {
    hideTip(); panel.hidden = !open; launcher.hidden = open; launcher.setAttribute('aria-expanded', String(open)); launcher.setAttribute('aria-label', open ? '收起面板' : '打开关键词检测面板');
    if (!open) resetTransfers();
    if (open) { renderRecords(); views[Object.keys(views).find(name => !views[name][1].hidden)][0].focus(); } else launcher.focus();
  }
  let messageTimer = 0;
  function tell(text) {
    clearTimeout(messageTimer); notice = text; changeLayout(() => { message.textContent = text; });
    // 错误与操作指引保持可见，简短成功反馈自动收起。
    if (text && /^(已|本机命中记录已清空)/.test(text)) messageTimer = setTimeout(() => { notice = ''; changeLayout(() => { message.textContent = ''; }); }, 3600);
  }
  function syncSettingsUI() {
    const hadPreview = pendingImport || pendingRecovery;
    resetTransfers(); refreshBackup();
    if (hadPreview) transferFeedback(importView.hidden ? recoveryNote : importNote, '设置已改变，请重新预览。', true);
    enabled.checked = config.enabled; color.value = config.color; sound.checked = config.sound; desktop.checked = config.desktop;
    colorControl.style.setProperty('--highlight', config.color);
    roomsInput.value = config.rooms.join('、'); renderWords(); updateNativeStyle(); refresh();
  }
  function saveConfig(allowRecovery = false, replace = false) {
    try {
      let latest;
      try { latest = parseSettings(GM_getValue(SETTINGS, null)); if (!latest && hadStoredSettings) throw new Error('原设置暂不可读'); }
      catch (error) { if (!allowRecovery) throw error; }
      const merged = clone(replace ? config : latest || baseConfig);
      if (!replace) {
        for (const key of ['enabled', 'rooms', 'color', 'sound', 'desktop'])
          if (JSON.stringify(config[key]) !== JSON.stringify(baseConfig[key])) merged[key] = clone(config[key]);
        // 只应用本页明确增删和启停的词，不用旧页面快照覆盖其他页面刚添加的词。
        const before = new Map(baseConfig.words.map(w => [w.text.toLowerCase(), w]));
        const current = new Map(config.words.map(w => [w.text.toLowerCase(), w]));
        const words = new Map(merged.words.map(w => [w.text.toLowerCase(), w]));
        for (const [key, word] of before) {
          if (!current.has(key)) words.delete(key);
          else if (current.get(key).enabled !== word.enabled && words.has(key)) words.set(key, clone(current.get(key)));
        }
        for (const [key, word] of current) if (!before.has(key)) words.set(key, clone(word));
        merged.words = [...words.values()];
      }
      const backups = [{ at: new Date().toISOString(), config: merged }, ...(latest ? [{ at: new Date().toISOString(), config: latest }] : []), ...readBackups()];
      const unique = new Set();
      GM_setValue(BACKUPS, backups.filter(item => { const key = JSON.stringify(item.config); if (unique.has(key)) return false; unique.add(key); return true; }).slice(0, 10));
      GM_setValue(SETTINGS, merged);
      const verified = parseSettings(GM_getValue(SETTINGS, null));
      if (!verified || JSON.stringify(verified) !== JSON.stringify(normalize(merged))) throw new Error('写入校验失败');
      config = verified; baseConfig = clone(config); hadStoredSettings = true; syncSettingsUI(); return true;
    } catch { tell('设置保存失败，无法确认写入结果；请保留原存储和备份，重新载入核实。'); return false; }
  }
  function persistHistory() {
    clearTimeout(saveTimer); saveTimer = 0;
    try {
      const latest = historyValue(GM_getValue(HISTORY, []));
      if (latest.generation !== historyGeneration) { historyGeneration = latest.generation; unsaved.clear(); }
      records = [...new Map([...latest.entries, ...unsaved.values()].map(r => [r.id, r])).values()]
        .sort((a, b) => a.at.localeCompare(b.at)).slice(-500);
      GM_setValue(HISTORY, { generation: historyGeneration, entries: records }); unsaved.clear();
    } catch { tell('记录保存失败，当前记录仅保留在本页，请检查油猴存储。'); }
  }
  function renderWords() {
    wordCount.textContent = String(config.words.length);
    const focused = wordList.contains(shadow.activeElement) ? shadow.activeElement.getAttribute('aria-label') : null;
    wordList.replaceChildren();
    if (!config.words.length) wordList.append(el('div', { class: 'empty', text: '暂无关键词' }));
    for (const word of config.words) {
      const toggle = el('input', { type: 'checkbox', checked: word.enabled, onchange: () => { word.enabled = toggle.checked; saveConfig(); refresh(); } });
      toggle.setAttribute('aria-label', `启用关键词：${word.text}`);
      wordList.append(el('div', { class: 'word' }, el('label', {}, toggle, el('span', { class: 'word-text', title: word.text, text: word.text })), iconButton('close', `删除关键词：${word.text}`, () => { config.words = config.words.filter(w => w !== word); saveConfig(); renderWords(); refresh(); wordInput.focus(); })));
    }
    if (focused) [...wordList.querySelectorAll('[aria-label]')].find(node => node.getAttribute('aria-label') === focused)?.focus();
  }
  function renderRecords() {
    historyTitle.textContent = String(records.length);
    launcherCount.textContent = String(records.length);
    clearRecords.disabled = !records.length;
    if (panel.hidden) return;
    recordList.replaceChildren();
    if (!records.length) recordList.append(el('div', { class: 'empty' }, icon('chat'), '等待命中弹幕'));
    for (const r of records.slice(-visibleRecords).reverse()) {
      const formatted = new Date(r.at).toLocaleString('zh-CN', { hour12: false });
      const copy = iconButton('copy', '复制命中记录', () => {
        try { GM_setClipboard(`[${formatted}] 房间 ${r.room}\n${r.uname}：${r.text}\n命中：${r.words.join('、')}`, 'text'); tell('已复制这条命中记录。'); }
        catch { tell('复制失败，请在命中记录中手动选择文字复制。'); }
      });
      recordList.append(el('article', { class: 'record' }, el('div', { class: 'record-head' }, el('span', { class: 'name', title: r.uname, text: r.uname }),
        el('time', { datetime: r.at, title: formatted, text: new Date(r.at).toLocaleTimeString('zh-CN', { hour12: false }) }), copy),
        el('p', { text: r.text }), el('div', { class: 'record-meta' }, el('span', { text: `房间 ${r.room}` }), el('span', { class: 'tags', title: r.words.join('、'), text: r.words.join(' · ') }))));
    }
    more.hidden = records.length <= visibleRecords;
  }
  function updateStatus() {
    const state = !active() ? '未启用' : !container ? '等待弹幕列表' : invalid.size ? '页面识别异常' : '正在观察页面';
    stateBadge.textContent = state === '正在观察页面' ? '检测中' : state; stateBadge.classList.toggle('warn', state !== '正在观察页面');
    stats.replaceChildren(icon('chat'), String(count));
    statusInfo.dataset.tip = `房间 ${room || '未识别'} · 本页新弹幕 ${count} 条\n最近处理 ${lastAt || '暂无'}\n仅观察页面已加载的弹幕；关页后停止，后台可能降频。`;
    hint.textContent = !active() ? '请开启检测，并将当前房间加入允许列表。'
      : invalid.size ? `有 ${invalid.size} 条消息暂无法读取正文，请检查页面兼容性。`
      : !config.words.some(w => w.enabled) ? '请添加并启用关键词' : '';
    if (document.visibilityState === 'hidden' && active()) hint.textContent += ' 当前标签页在后台，浏览器可能降低处理频率。';
  }
  const nativeStyle = el('style'); nativeStyle.id = 'bdk-native-style'; document.documentElement.append(nativeStyle);
  function updateNativeStyle() {
    const hex = config.color;
    const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    const ink = rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114 > 150 ? '#151b26' : '#ffffff';
    const fallback = !window.CSS?.highlights || !window.Highlight;
    nativeStyle.textContent = `.bdk-hit{background-color:rgba(${rgb.join(',')},.22)!important;box-shadow:inset 3px 0 0 ${hex}!important;border-radius:4px}${fallback ? `.bdk-hit .danmaku-item-right{text-decoration:underline;text-decoration-color:${hex};text-underline-offset:3px}` : ''}::highlight(bdk-words){background-color:${hex};color:${ink};text-decoration:none}`;
  }
  // 使用CSS文本高亮，不插入span、不替换正文，不接管原生点击事件。
  function rangesFor(body, words) {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); const nodes = []; let text = '', n;
    while ((n = walker.nextNode())) { nodes.push({ node: n, start: text.length, end: text.length + n.length }); text += n.data; }
    // 仅折叠ASCII英文大小写，避免Unicode小写展开改变原始文本的偏移。
    const fold = s => s.replace(/[A-Z]/g, c => c.toLowerCase());
    const lower = fold(text), spans = [];
    for (const word of words) { const needle = fold(word); let from = 0, at;
      while (needle && (at = lower.indexOf(needle, from)) !== -1) { spans.push([at, at + needle.length]); from = at + Math.max(needle.length, 1); }
    }
    spans.sort((a, b) => a[0] - b[0]); const merged = [];
    for (const span of spans) { const last = merged.at(-1); if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]); else merged.push([...span]); }
    return merged.flatMap(([a, b]) => {
      const start = nodes.find(item => item.start <= a && a < item.end), end = nodes.find(item => item.start < b && b <= item.end);
      if (!start || !end) return [];
      const range = document.createRange(); range.setStart(start.node, a - start.start); range.setEnd(end.node, b - end.start); return [range];
    });
  }
  function rebuildHighlights() {
    const ranges = [];
    for (const [row, item] of paint) {
      if (!row.isConnected || !container?.contains(row)) { paint.delete(row); row.classList.remove('bdk-hit'); continue; }
      if (window.CSS?.highlights && window.Highlight) ranges.push(...rangesFor(item.body, item.words));
    }
    if (!window.CSS?.highlights || !window.Highlight) return;
    CSS.highlights.set('bdk-words', new Highlight(...ranges));
  }
  function remember(key) { if (!key) return; seen.set(key, true); if (seen.size > 5000) seen.delete(seen.keys().next().value); }
  function processRow(row, initial = false) {
    if (!container?.contains(row)) { invalid.delete(row); return; }
    const data = adapter.read(row);
    if (initial) baseline.add(row);
    if (!data) { invalid.add(row); paint.delete(row); row.classList.remove('bdk-hit'); return; }
    invalid.delete(row);
    const signature = JSON.stringify([room, data.id, data.uname, data.text]);
    const previous = nodeStates.get(row), key = data.id ? `${room}:${data.id}` : '';
    const isNew = previous !== signature && !(key && seen.has(key));
    const suppress = initial || baseline.has(row) || !active();
    nodeStates.set(row, signature); baseline.delete(row); remember(key);
    // 排除规则优先于用户关键词：保留原生弹幕，不高亮、不记录、不通报。
    const words = active() && !excluded(data.text) ? matches(data.text) : [];
    row.classList.toggle('bdk-hit', words.length > 0);
    if (words.length) paint.set(row, { body: data.body, words }); else paint.delete(row);
    if (isNew && !suppress) {
      count++; lastAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      if (words.length) {
        const record = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, room, uname: data.uname, text: data.text, words, at: new Date().toISOString() };
        records.push(record); records = records.slice(-500);
        unsaved.set(record.id, record);
        if (unsaved.size > 500) unsaved.delete(unsaved.keys().next().value);
        if (!saveTimer) saveTimer = setTimeout(persistHistory, 300);
        void alertUser(record);
        if (!uiTimer) uiTimer = setTimeout(() => { uiTimer = 0; renderRecords(); }, 100);
      }
    }
  }
  function flushPending() {
    pendingTimer = 0;
    for (const row of pending) processRow(row); pending.clear();
    for (const row of invalid) if (!container?.contains(row)) invalid.delete(row);
    rebuildHighlights(); updateStatus();
  }
  function scheduleRow(node) {
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!element) return;
    const parentRow = element.closest(ROW); if (parentRow) pending.add(parentRow);
    for (const row of element.querySelectorAll(ROW)) pending.add(row);
  }
  function detach() {
    observer?.disconnect(); observer = null; pending.clear(); clearTimeout(pendingTimer); pendingTimer = 0;
    for (const row of paint.keys()) row.classList.remove('bdk-hit');
    paint.clear(); invalid.clear(); container = null;
    window.CSS?.highlights?.delete('bdk-words');
  }
  function attach(next) {
    detach(); container = next;
    if (!container) return;
    for (const row of container.querySelectorAll(ROW)) processRow(row, true);
    observer = new MutationObserver(changes => {
      for (const change of changes) {
        if (change.type === 'childList') {
          const affected = change.target.nodeType === 1 ? change.target.closest(ROW) : change.target.parentElement?.closest(ROW);
          if (affected) pending.add(affected);
          for (const node of change.addedNodes) scheduleRow(node);
        }
        else scheduleRow(change.target);
      }
      if (!pendingTimer) pendingTimer = setTimeout(flushPending, 50);
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['data-danmaku', 'data-uname', 'data-id_str', 'data-id-str'] });
    rebuildHighlights();
  }
  function refresh() {
    if (!container) return updateStatus();
    for (const row of container.querySelectorAll(ROW)) processRow(row, true);
    rebuildHighlights(); updateStatus();
  }
  function tick() {
    if (stopped) return;
    const currentRoom = adapter.room();
    if (room !== currentRoom) { detach(); room = currentRoom; nodeStates = new WeakMap(); baseline = new WeakSet(); count = 0; lastAt = ''; }
    const next = adapter.container();
    if (next !== container) attach(next);
    // 无新弹幕时不判故障；只重试尚未构建完整的消息节点。
    for (const row of invalid) processRow(row);
    updateStatus();
  }
  async function beep() {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) throw new Error('浏览器不支持提示音');
    if (!audio || audio.state === 'closed') audio = new Audio();
    await audio.resume();
    if (audio.state !== 'running') throw new Error('声音未能启动');
    const osc = audio.createOscillator(), gain = audio.createGain();
    osc.frequency.value = 880; gain.gain.setValueAtTime(.08, audio.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .22);
    osc.connect(gain); gain.connect(audio.destination); osc.start(); osc.stop(audio.currentTime + .25);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
  }
  async function alertUser(record, force = false) {
    if (!config.sound && !config.desktop) return;
    if (!force && Date.now() - lastAlert < 5000) return;
    if (!force) lastAlert = Date.now();
    const failures = [];
    if (config.sound) try { await beep(); } catch { failures.push('声音播放失败，请检查浏览器声音设置。'); }
    if (config.desktop) try {
      if (!window.Notification || Notification.permission !== 'granted') throw new Error();
      const notification = new Notification(`弹幕命中：${record.uname}`, { body: `${record.text}\n关键词：${record.words.join('、')}`, tag: 'bdk-alert' });
      setTimeout(() => notification.close(), 8000);
    } catch { failures.push('桌面通知不可用，请检查通知权限。'); }
    if (failures.length) tell(failures.join('\n')); else if (force) tell('已尝试播放已启用的通报，请确认系统声音或通知是否可见。');
  }
  // 多标签页设置同步；各页只检测自己加载的消息，存储更新合并最新记录。
  if (typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener(SETTINGS, (_key, _old, value, remote) => {
      if (!remote) return;
      try { const parsed = parseSettings(value); if (!parsed) throw new Error(); config = parsed; baseConfig = clone(config); hadStoredSettings = true; syncSettingsUI(); }
      catch { tell('另一个页面传来无法读取的设置，已保留当前关键词，不自动清空。'); }
    });
    GM_addValueChangeListener(HISTORY, (_key, _old, value, remote) => {
      if (!remote) return;
      const incoming = historyValue(value);
      if (incoming.generation !== historyGeneration) { historyGeneration = incoming.generation; unsaved.clear(); clearTimeout(saveTimer); saveTimer = 0; }
      const merged = new Map([...incoming.entries, ...unsaved.values()].map(r => [r.id, r]));
      records = [...merged.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-500);
      renderRecords();
    });
  }
  if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('打开关键词检测面板', () => openPanel(true));
  if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('导出设置 JSON 文件', () => { openPanel(true); selectTab('backup'); selectBackupMode('export'); exportSettings(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistHistory(); else tick(); });
  window.addEventListener('pagehide', persistHistory);
  const interval = setInterval(tick, 1500);
  window.addEventListener('unload', () => { stopped = true; clearInterval(interval); detach(); audio?.close(); });
  if (!window.CSS?.highlights || !window.Highlight) notice += ' 当前浏览器不支持词内高亮，将使用整行底色和正文下划线。';
  selectTab(config.words.length ? 'history' : 'settings');
  updateNativeStyle(); renderWords(); renderRecords(); tell(notice); tick();
})();
