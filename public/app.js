'use strict';

/**
 * 蛇域争霸 · 客户端
 * 原生 Canvas + WebSocket，兼容桌面浏览器、Electron 与 Android WebView。
 */

(() => {
  const TAU = Math.PI * 2;
  const PALETTE = [
    '#3ff08a', '#5ce1ff', '#b388ff', '#ffd166', '#ff6b7d',
    '#ff9f43', '#67e8f9', '#f472b6', '#a3e635', '#f97316'
  ];
  const FOOD_COLORS = ['#ff6b7d', '#ffd166', '#5ce1ff', '#b388ff', '#7dffb0'];
  const POWERUP_META = {
    shield: { name: '护盾', color: '#67e8f9' },
    speed: { name: '疾风', color: '#facc15' },
    magnet: { name: '磁铁', color: '#c084fc' },
    double: { name: '双倍', color: '#fb923c' },
    life: { name: '复活币', color: '#f472b6' }
  };

  const SOLO = Object.freeze({
    MAP_W: 4200,
    MAP_H: 3000,
    BASE_MASS: 20,
    MIN_MASS: 10,
    BOOST_MIN_MASS: 26,
    BASE_SPEED: 168,
    BOOST_MULT: 1.55,
    SPEED_BUFF_MULT: 1.45,
    TURN_RATE: 4.6,
    BOOST_DRAIN: 7,
    BOOST_ORB_MS: 320,
    FOOD_COUNT: 430,
    POWERUP_MAX: 4,
    POWERUP_EVERY_MS: 9000,
    STEP: 1 / 30
  });

  const $ = (id) => document.getElementById(id);

  const el = {
    connectScreen: $('connectScreen'),
    lobbyScreen: $('lobbyScreen'),
    gameScreen: $('gameScreen'),
    nameInput: $('nameInput'),
    serverField: $('serverField'),
    serverInput: $('serverInput'),
    colorPicker: $('colorPicker'),
    connectBtn: $('connectBtn'),
    connectStatus: $('connectStatus'),
    soundConnectBtn: $('soundConnectBtn'),
    serverPill: $('serverPill'),
    serverPillText: $('serverPillText'),
    leaveLobbyBtn: $('leaveLobbyBtn'),
    roomCount: $('roomCount'),
    roundLabel: $('roundLabel'),
    playerSlots: $('playerSlots'),
    startBtn: $('startBtn'),
    lobbyHint: $('lobbyHint'),
    powerupList: $('powerupList'),
    wanPanel: $('wanPanel'),
    wanState: $('wanState'),
    wanHint: $('wanHint'),
    wanStartBtn: $('wanStartBtn'),
    wanUrlBox: $('wanUrlBox'),
    wanUrl: $('wanUrl'),
    wanCopyBtn: $('wanCopyBtn'),
    wanStopBtn: $('wanStopBtn'),
    countdownOverlay: $('countdownOverlay'),
    countdownNum: $('countdownNum'),
    gameCanvas: $('gameCanvas'),
    hudScore: $('hudScore'),
    hudMass: $('hudMass'),
    hudKills: $('hudKills'),
    hudLives: $('hudLives'),
    hudBuffs: $('hudBuffs'),
    hudTimer: $('hudTimer'),
    hudLeaderboard: $('hudLeaderboard'),
    soloBtn: $('soloBtn'),
    soloMeta: $('soloMeta'),
    soloBest: $('soloBest'),
    soloExitBtn: $('soloExitBtn'),
    soloOver: $('soloOver'),
    soloReason: $('soloReason'),
    soloScore: $('soloScore'),
    soloMass: $('soloMass'),
    soloBestScore: $('soloBestScore'),
    soloRestartBtn: $('soloRestartBtn'),
    soloBackBtn: $('soloBackBtn'),
    killFeed: $('killFeed'),
    minimap: $('minimap'),
    hudPing: $('hudPing'),
    soundGameBtn: $('soundGameBtn'),
    powerupToast: $('powerupToast'),
    deathBanner: $('deathBanner'),
    deathEyebrow: $('deathEyebrow'),
    deathTitle: $('deathTitle'),
    deathText: $('deathText'),
    spectateBadge: $('spectateBadge'),
    disconnectBanner: $('disconnectBanner'),
    reconnectBtn: $('reconnectBtn'),
    boostBtn: $('boostBtn'),
    touchHint: $('touchHint'),
    resultsScreen: $('resultsScreen'),
    resultsTitle: $('resultsTitle'),
    resultsSub: $('resultsSub'),
    resultsList: $('resultsList'),
    resultsNext: $('resultsNext'),
    resultsLeaveBtn: $('resultsLeaveBtn')
  };

  const canvas = el.gameCanvas;
  const ctx = canvas.getContext('2d');
  const mini = el.minimap;
  const miniCtx = mini.getContext('2d');

  let viewW = window.innerWidth;
  let viewH = window.innerHeight;
  let dpr = 1;
  let orbSprites = [];

  const STORE = {
    get(key, fallback) {
      try {
        const value = localStorage.getItem(key);
        return value == null ? fallback : value;
      } catch (_) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, String(value));
      } catch (_) {
        /* ignore */
      }
    }
  };

  const sameOrigin = location.protocol === 'http:' || location.protocol === 'https:';
  const coarsePointer = window.matchMedia('(pointer: coarse)');

  const app = {
    ws: null,
    connected: false,
    connecting: false,
    leaving: false,
    serverError: '',
    youId: null,
    youName: '',
    youColor: PALETTE[0],
    config: null,
    server: null,
    room: null,
    snapshot: null,
    you: null,
    connectedDisplay: '',
    connectedCopyUrl: '',
    inGame: false,
    playing: false,
    spectator: false,
    wasAlive: false,
    round: 0,
    angle: 0,
    angleInit: false,
    boost: false,
    boostMouse: false,
    boostKey: false,
    boostBtn: false,
    mouseSeen: false,
    mouseX: window.innerWidth / 2,
    mouseY: window.innerHeight / 2,
    joystick: null,
    camera: { x: 2100, y: 1500, zoom: 1, ready: false, targetId: null },
    visuals: new Map(),
    particles: [],
    shake: 0,
    lastFrame: 0,
    lastHud: 0,
    lastScore: 0,
    lastDeath: null,
    countdownActive: false,
    countdownUntil: 0,
    lastCountdownSec: null,
    resultsUntil: 0,
    lastResultsSec: null,
    ping: 0,
    lastEatSound: 0,
    powerupToastTimer: 0,
    feedTimers: [],
    muted: STORE.get('muted', '0') === '1',
    tunnel: { state: 'idle', url: null, error: null },
    tunnelUrl: '',
    tunnelFetching: false,
    tunnelLastCheck: 0,
    solo: false,
    soloState: null,
    soloBest: 0,
    soloAccumulator: 0
  };

  /* ======================================================================== */
  /* 基础工具                                                                  */
  /* ======================================================================== */

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function formatTime(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function shade(hex, percent) {
    const value = String(hex || '#3ff08a').replace('#', '');
    const num = parseInt(value.length === 3 ? value.split('').map((c) => c + c).join('') : value, 16);
    if (!Number.isFinite(num)) return hex;
    const amount = Math.round((255 * percent) / 100);
    const r = clamp(((num >> 16) & 255) + amount, 0, 255);
    const g = clamp(((num >> 8) & 255) + amount, 0, 255);
    const b = clamp((num & 255) + amount, 0, 255);
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  }

  function roundRect(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function randomName() {
    return '蛇友' + Math.floor(1000 + Math.random() * 9000);
  }

  function mapSize() {
    return (app.config && app.config.map) || { w: 4200, h: 3000 };
  }

  function getYou(snapshot = app.snapshot) {
    return snapshot ? snapshot.players.find((player) => player.id === app.youId) || null : null;
  }

  function setStatus(text, kind = '') {
    el.connectStatus.textContent = text;
    el.connectStatus.className = 'status' + (kind ? ' ' + kind : '');
  }

  function showScreen(name) {
    el.connectScreen.classList.toggle('hidden', name !== 'connect');
    el.lobbyScreen.classList.toggle('hidden', name !== 'lobby');
    el.gameScreen.classList.toggle('hidden', name !== 'game');
    if (name === 'game') resize();
  }

  function resize() {
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
    canvas.style.width = viewW + 'px';
    canvas.style.height = viewH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function worldToScreen(x, y) {
    return {
      x: (x - app.camera.x) * app.camera.zoom + viewW / 2,
      y: (y - app.camera.y) * app.camera.zoom + viewH / 2
    };
  }

  function viewBounds(pad = 100) {
    const halfW = viewW / (2 * app.camera.zoom);
    const halfH = viewH / (2 * app.camera.zoom);
    return {
      left: app.camera.x - halfW - pad,
      right: app.camera.x + halfW + pad,
      top: app.camera.y - halfH - pad,
      bottom: app.camera.y + halfH + pad
    };
  }

  /* ======================================================================== */
  /* 音效                                                                     */
  /* ======================================================================== */

  let audioCtx = null;

  function ensureAudio() {
    if (audioCtx) return audioCtx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      audioCtx = new AC();
    } catch (_) {
      audioCtx = null;
    }
    return audioCtx;
  }

  function unlockAudio() {
    const context = ensureAudio();
    if (context && context.state === 'suspended') context.resume();
  }

  function tone(freq, duration = 0.08, type = 'sine', volume = 0.035, delay = 0) {
    if (app.muted) return;
    const context = ensureAudio();
    if (!context) return;
    if (context.state === 'suspended') context.resume();

    const start = context.currentTime + delay;
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(context.destination);
    osc.start(start);
    osc.stop(start + duration + 0.03);
  }

  function playEat() {
    const now = performance.now();
    if (now - app.lastEatSound < 55) return;
    app.lastEatSound = now;
    tone(660 + Math.random() * 160, 0.05, 'sine', 0.028);
  }

  function playPowerup() {
    [660, 880, 1180].forEach((f, index) => tone(f, 0.09, 'triangle', 0.04, index * 0.06));
  }

  function playRevive() {
    tone(420, 0.1, 'sine', 0.04);
    tone(760, 0.16, 'sine', 0.04, 0.08);
  }

  function playDeath() {
    tone(300, 0.16, 'sawtooth', 0.035);
    tone(210, 0.2, 'sawtooth', 0.032, 0.12);
    tone(120, 0.3, 'sawtooth', 0.03, 0.28);
  }

  function playKill() {
    tone(880, 0.08, 'triangle', 0.04);
    tone(1320, 0.12, 'triangle', 0.035, 0.07);
  }

  function playStart() {
    tone(440, 0.1, 'triangle', 0.035);
    tone(660, 0.18, 'triangle', 0.04, 0.1);
  }

  function playTick() {
    tone(560, 0.05, 'square', 0.02);
  }

  function playEnd(win) {
    if (win) {
      [523, 659, 784, 1047].forEach((f, index) => tone(f, 0.14, 'triangle', 0.04, index * 0.11));
    } else {
      [420, 330, 260].forEach((f, index) => tone(f, 0.16, 'sine', 0.035, index * 0.12));
    }
  }

  function updateSoundUI() {
    el.soundConnectBtn.textContent = app.muted ? '♪ 声音关' : '♪ 声音开';
    el.soundConnectBtn.classList.toggle('muted', app.muted);
    el.soundConnectBtn.setAttribute('aria-label', app.muted ? '打开声音' : '关闭声音');
    el.soundGameBtn.textContent = app.muted ? '×' : '♪';
    el.soundGameBtn.classList.toggle('muted', app.muted);
    el.soundGameBtn.setAttribute('aria-label', app.muted ? '打开声音' : '关闭声音');
  }

  function toggleSound() {
    app.muted = !app.muted;
    STORE.set('muted', app.muted ? '1' : '0');
    updateSoundUI();
    if (!app.muted) {
      unlockAudio();
      tone(880, 0.06, 'sine', 0.03);
    }
  }

  /* ======================================================================== */
  /* 连接                                                                     */
  /* ======================================================================== */

  function normalizeServer(raw) {
    let value = String(raw || '').trim().replace(/\s+/g, '');
    if (!value) return null;

    let inferredScheme = false;
    if (/^https:\/\//i.test(value)) {
      value = 'wss://' + value.slice(8);
    } else if (/^http:\/\//i.test(value)) {
      value = 'ws://' + value.slice(7);
    } else if (!/^wss?:\/\//i.test(value)) {
      inferredScheme = true;
      const hostPart = value.split('/')[0];
      const localOrIp =
        /^\d{1,3}(\.\d{1,3}){3}(?::\d+)?$/.test(hostPart) ||
        /^\[[0-9a-f:]+\](?::\d+)?$/i.test(hostPart) ||
        /^(localhost|127\.0\.0\.1)(?::\d+)?$/i.test(hostPart);
      value = (localOrIp ? 'ws://' : 'wss://') + value;
    }

    if (!/^wss?:\/\//i.test(value)) return null;

    let url;
    try {
      url = new URL(value);
    } catch (_) {
      return null;
    }
    if (!url.hostname) return null;
    if (inferredScheme && !url.port && url.protocol === 'ws:') url.port = '31888';
    url.pathname = '/ws';
    url.search = '';
    url.hash = '';
    return { url: url.toString(), display: url.host };
  }

  function savePrefs() {
    STORE.set('name', el.nameInput.value.trim());
    STORE.set('color', app.youColor);
    if (!sameOrigin) STORE.set('server', el.serverInput.value.trim());
  }

  function connect() {
    if (app.solo) return;
    if (app.ws && (app.ws.readyState === WebSocket.OPEN || app.ws.readyState === WebSocket.CONNECTING)) return;

    let name = el.nameInput.value.trim().slice(0, 12);
    if (!name) {
      name = randomName();
      el.nameInput.value = name;
    }

    let url;
    let display;

    if (sameOrigin) {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      url = `${scheme}://${location.host}/ws`;
      display = location.host;
      app.connectedDisplay = location.host;
      app.connectedCopyUrl = location.origin;
    } else {
      const parsed = normalizeServer(el.serverInput.value);
      if (!parsed) {
        setStatus('请输入服务器地址，例如 192.168.1.10:31888 或 https://…', 'error');
        el.serverInput.focus();
        return;
      }
      url = parsed.url;
      display = parsed.display;
      app.connectedDisplay = parsed.display;
      app.connectedCopyUrl = parsed.url.replace(/^ws/i, 'http').replace(/\/ws$/, '');
    }

    savePrefs();
    app.youColor = el.colorPicker.querySelector('.selected')?.dataset.color || app.youColor;
    app.serverError = '';
    app.leaving = false;
    app.connecting = true;
    app.connected = false;
    el.connectBtn.disabled = true;
    setStatus(`正在连接 ${display} …`);

    let socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      app.connecting = false;
      el.connectBtn.disabled = false;
      setStatus('无法创建 WebSocket 连接。', 'error');
      return;
    }

    app.ws = socket;
    let opened = false;

    const timeout = setTimeout(() => {
      if (opened) return;
      if (app.ws === socket) app.ws = null;
      try {
        socket.close();
      } catch (_) {
        /* ignore */
      }
      app.connecting = false;
      el.connectBtn.disabled = false;
      setStatus('连接超时：请确认房主服务器已启动，且两台设备在同一个 Wi-Fi。', 'error');
    }, 9000);

    socket.onopen = () => {
      if (app.ws !== socket) return;
      opened = true;
      clearTimeout(timeout);
      app.connected = true;
      app.connecting = false;
      unlockAudio();
      socket.send(JSON.stringify({ type: 'join', name, color: app.youColor }));
      setStatus('已连接，正在进入房间…');
    };

    socket.onmessage = (event) => {
      if (app.ws !== socket) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      handleMessage(message);
    };

    socket.onclose = () => {
      if (app.ws !== socket) return;
      clearTimeout(timeout);
      const wasConnected = app.connected;
      app.connected = false;
      app.connecting = false;
      app.ws = null;
      el.connectBtn.disabled = false;

      if (app.leaving) return;
      if (app.serverError) {
        setStatus(app.serverError, 'error');
        return;
      }
      if (!wasConnected) {
        setStatus('连接失败：请检查地址、服务器是否启动、是否在同一 Wi-Fi。', 'error');
        return;
      }

      app.playing = false;
      if (app.inGame) {
        el.disconnectBanner.classList.remove('hidden');
        setStatus('连接已断开，请重新连接。', 'error');
      } else {
        el.lobbyHint.textContent = '连接已断开，请重新连接服务器。';
        el.startBtn.disabled = true;
      }
    };

    socket.onerror = () => {
      /* onclose 会处理 */
    };
  }

  function handleMessage(message) {
    if (app.solo) return;
    switch (message.type) {
      case 'welcome':
        onWelcome(message);
        break;
      case 'room':
        onRoom(message.room);
        break;
      case 'start':
        onStart(message);
        break;
      case 'state':
        onState(message);
        break;
      case 'events':
        onEvents(message.events);
        break;
      case 'end':
        onEnd(message);
        break;
      case 'pong':
        app.ping = Math.max(1, Math.round(performance.now() - message.t));
        break;
      case 'error':
        app.serverError = message.message || '服务器拒绝了连接。';
        setStatus(app.serverError, 'error');
        el.connectBtn.disabled = false;
        break;
      default:
        break;
    }
  }

  function onWelcome(message) {
    app.connected = true;
    app.connecting = false;
    app.serverError = '';
    el.connectBtn.disabled = false;
    app.youId = message.you.id;
    app.youName = message.you.name;
    app.youColor = message.you.color;
    app.config = message.config;
    app.server = message.server;
    app.room = message.room;

    updateServerPill();
    renderPowerupList();
    showScreen('lobby');
    renderLobby(message.room);
    updateWanVisibility();
    refreshTunnelStatus(true);
    setStatus('已进入房间：' + message.you.name, 'ok');
    document.title = '蛇域争霸 · ' + message.you.name;
  }

  function updateServerPill() {
    if (!app.server) return;

    let address;
    let copyUrl;

    if (isTunnelHost()) {
      address = app.server.addresses && app.server.addresses.length
        ? `${app.server.addresses[0]}:${app.server.port}`
        : location.host || `127.0.0.1:${app.server.port}`;
      copyUrl = `http://${address}`;
    } else if (sameOrigin) {
      address = location.host;
      copyUrl = location.origin;
    } else if (app.connectedDisplay) {
      address = app.connectedDisplay;
      copyUrl = app.connectedCopyUrl || `http://${address}`;
    } else {
      address = app.server.addresses && app.server.addresses.length
        ? `${app.server.addresses[0]}:${app.server.port}`
        : location.host || `127.0.0.1:${app.server.port}`;
      copyUrl = `http://${address}`;
    }

    el.serverPillText.textContent = address;
    el.serverPill.dataset.url = copyUrl;
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    area.style.top = '0';
    area.style.fontSize = '16px';
    document.body.appendChild(area);
    area.focus();
    area.select();
    area.setSelectionRange(0, area.value.length);
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } finally {
      area.remove();
    }
    if (!copied) throw new Error('copy failed');
  }

  async function copyServerAddress() {
    const url = el.serverPill.dataset.url || location.origin;
    const original = el.serverPillText.textContent;
    try {
      await copyText(url);
      el.serverPillText.textContent = '已复制 ' + original;
      setTimeout(() => {
        el.serverPillText.textContent = original;
      }, 1300);
    } catch (_) {
      window.prompt('复制服务器地址', url);
    }
  }

  function isTunnelHost() {
    const hostname = location.hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  }

  function updateWanVisibility() {
    el.wanPanel.classList.toggle('hidden', !isTunnelHost());
  }

  function applyTunnelStatus(status) {
    const state = status && status.state ? status.state : 'idle';
    app.tunnel = {
      state,
      url: status && status.url ? status.url : null,
      error: status && status.error ? status.error : null
    };
    app.tunnelUrl = app.tunnel.url || '';
    el.wanState.className = 'wan-state' + (state === 'idle' ? '' : ' ' + state);

    if (state === 'running' && app.tunnelUrl) {
      el.wanState.textContent = '已开启';
      el.wanHint.textContent = '把下面的链接发给朋友：浏览器直接打开，或在手机 App 的服务器地址里粘贴。';
      el.wanStartBtn.classList.add('hidden');
      el.wanStartBtn.disabled = false;
      el.wanUrlBox.classList.remove('hidden');
      el.wanUrl.textContent = app.tunnelUrl;
      el.wanStopBtn.disabled = false;
    } else if (state === 'starting') {
      el.wanState.textContent = '建立中…';
      el.wanHint.textContent = '正在连接公网隧道，通常需要 5–15 秒…';
      el.wanStartBtn.classList.remove('hidden');
      el.wanStartBtn.disabled = true;
      el.wanStartBtn.textContent = '正在建立…';
      el.wanUrlBox.classList.add('hidden');
    } else if (state === 'error') {
      el.wanState.textContent = '失败';
      el.wanHint.textContent = app.tunnel.error || '公网隧道启动失败，请重试。';
      el.wanStartBtn.classList.remove('hidden');
      el.wanStartBtn.disabled = false;
      el.wanStartBtn.textContent = '重新生成';
      el.wanUrlBox.classList.add('hidden');
    } else {
      el.wanState.textContent = '未开启';
      el.wanHint.textContent = '生成一个临时公网地址。朋友用浏览器打开，或在手机 App 的服务器地址里粘贴这个链接。';
      el.wanStartBtn.classList.remove('hidden');
      el.wanStartBtn.disabled = false;
      el.wanStartBtn.textContent = '生成公网地址';
      el.wanUrlBox.classList.add('hidden');
    }
  }

  async function refreshTunnelStatus(force = false) {
    if (!isTunnelHost()) return;
    if (!force && performance.now() - app.tunnelLastCheck < 1500) return;
    if (el.lobbyScreen.classList.contains('hidden')) return;
    if (app.tunnelFetching) return;
    app.tunnelLastCheck = performance.now();
    app.tunnelFetching = true;
    try {
      const response = await fetch('/api/tunnel', { cache: 'no-store' });
      if (!response.ok) return;
      applyTunnelStatus(await response.json());
    } catch (_) {
      /* 隧道 API 不可用时静默；旧版服务器没有该接口 */
    } finally {
      app.tunnelFetching = false;
    }
  }

  async function startPublicTunnel() {
    if (!isTunnelHost() || app.tunnel.state === 'starting') return;
    applyTunnelStatus({ state: 'starting' });
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 40000);
      const response = await fetch('/api/tunnel/start', { method: 'POST', signal: controller.signal });
      clearTimeout(timer);
      let data = {};
      try {
        data = await response.json();
      } catch (_) {
        /* ignore */
      }
      if (!response.ok) throw new Error(data.error || '公网隧道启动失败');
      applyTunnelStatus(data);
    } catch (error) {
      const message = error.name === 'AbortError'
        ? '建立超时，请检查网络后重试。'
        : error.message;
      applyTunnelStatus({ state: 'error', error: message });
      refreshTunnelStatus(true);
    }
  }

  async function stopPublicTunnel() {
    if (!isTunnelHost()) return;
    el.wanStopBtn.disabled = true;
    try {
      await fetch('/api/tunnel/stop', { method: 'POST' });
    } catch (_) {
      /* ignore */
    }
    applyTunnelStatus({ state: 'idle' });
    refreshTunnelStatus(true);
  }

  async function copyTunnelUrl() {
    if (!app.tunnelUrl) return;
    try {
      await copyText(app.tunnelUrl);
      el.wanCopyBtn.textContent = '已复制';
      setTimeout(() => {
        el.wanCopyBtn.textContent = '复制链接';
      }, 1300);
    } catch (_) {
      window.prompt('复制公网地址', app.tunnelUrl);
    }
  }

  /* ======================================================================== */
  /* 房间界面                                                                  */
  /* ======================================================================== */

  function renderPowerupList() {
    if (!app.config || !Array.isArray(app.config.powerups)) return;
    el.powerupList.innerHTML = app.config.powerups.map((item) => `
      <div class="pu" style="--c:${escapeHtml(item.color)}">
        <i></i>
        <div><b>${escapeHtml(item.name)}</b><span>${escapeHtml(item.desc)}</span></div>
      </div>
    `).join('');
  }

  function renderLobby(room) {
    if (!room) return;

    el.roomCount.textContent = `${room.players.length} / ${room.maxPlayers}`;

    if (room.state === 'countdown') {
      el.roundLabel.textContent = `第 ${room.round} 轮 · 准备中`;
    } else if (room.state === 'ended') {
      el.roundLabel.textContent = '本轮结算中';
    } else if (room.round > 0) {
      el.roundLabel.textContent = `第 ${room.round + 1} 轮`;
    } else {
      el.roundLabel.textContent = '等待开局';
    }

    const fragment = document.createDocumentFragment();
    for (let index = 0; index < room.maxPlayers; index++) {
      const player = room.players[index];
      const slot = document.createElement('div');

      if (!player) {
        slot.className = 'slot empty';
        slot.innerHTML = '<div class="plus">+</div><span>等待加入</span>';
      } else {
        slot.className = 'slot filled' + (player.id === app.youId ? ' me' : '');
        slot.style.setProperty('--c', player.color);

        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.textContent = Array.from(player.name)[0] || '蛇';

        const name = document.createElement('div');
        name.className = 'slot-name';
        name.textContent = player.name + (player.id === app.youId ? '（你）' : '');

        const role = document.createElement('div');
        role.className = 'slot-role';
        if (player.isHost) role.textContent = '房主';
        else if (player.spectator) role.textContent = '观战';
        else if (room.state === 'countdown') role.textContent = '已准备';
        else role.textContent = '已连接';

        slot.append(avatar, name, role);

        if (player.isHost) {
          const tag = document.createElement('span');
          tag.className = 'host-tag';
          tag.textContent = 'HOST';
          slot.appendChild(tag);
        }
      }

      fragment.appendChild(slot);
    }
    el.playerSlots.replaceChildren(fragment);

    const isHost = room.hostId === app.youId;
    const canStart = isHost && room.state === 'lobby';

    el.startBtn.disabled = !canStart;
    if (room.state === 'countdown') {
      el.startBtn.textContent = '准备中…';
    } else if (room.state === 'ended') {
      el.startBtn.textContent = '结算中…';
    } else if (room.state === 'playing') {
      el.startBtn.textContent = '对局进行中';
    } else if (isHost) {
      el.startBtn.textContent = '开始游戏';
    } else {
      el.startBtn.textContent = '等待房主开始';
    }

    if (room.state === 'ended') {
      el.lobbyHint.textContent = '本轮已结束，马上回到房间。';
    } else if (room.state === 'countdown') {
      el.lobbyHint.textContent = '所有人准备，马上进入竞技场。';
    } else if (room.state === 'playing') {
      el.lobbyHint.textContent = '对局进行中，加入下一轮。';
    } else if (isHost) {
      el.lobbyHint.textContent = '你是房主，准备好就立即开始。';
    } else {
      el.lobbyHint.textContent = '等待房主开始游戏。';
    }

    if (room.state === 'countdown') {
      showCountdown(room.countdownLeft);
    } else {
      hideCountdown();
    }
  }

  function showCountdown(leftMs) {
    if (!Number.isFinite(leftMs)) return;
    app.countdownActive = true;
    app.countdownUntil = performance.now() + Math.max(0, leftMs);
    app.lastCountdownSec = null;
    el.countdownOverlay.classList.remove('hidden');
    updateCountdownDisplay();
  }

  function hideCountdown() {
    app.countdownActive = false;
    app.countdownUntil = 0;
    app.lastCountdownSec = null;
    el.countdownOverlay.classList.add('hidden');
  }

  function updateCountdownDisplay() {
    if (!app.countdownActive) return;
    const left = Math.max(0, app.countdownUntil - performance.now());
    const seconds = Math.max(0, Math.ceil(left / 1000));
    el.countdownNum.textContent = seconds > 0 ? String(seconds) : 'GO';
    if (seconds !== app.lastCountdownSec) {
      app.lastCountdownSec = seconds;
      if (seconds > 0) playTick();
    }
  }

  function onRoom(room) {
    if (!room) return;
    app.room = room;

    if (room.state === 'playing') return;

    if (room.state === 'ended') {
      if (!el.resultsScreen.classList.contains('hidden')) return;
      app.inGame = false;
      app.playing = false;
      showScreen('lobby');
      renderLobby(room);
      updateWanVisibility();
      refreshTunnelStatus();
      return;
    }

    app.inGame = false;
    app.playing = false;
    app.snapshot = null;
    app.you = null;
    app.visuals.clear();
    app.particles = [];
    app.resultsUntil = 0;

    el.resultsScreen.classList.add('hidden');
    el.disconnectBanner.classList.add('hidden');
    el.deathBanner.classList.add('hidden');
    el.spectateBadge.classList.add('hidden');
    showScreen('lobby');
    renderLobby(room);
    updateWanVisibility();
    refreshTunnelStatus();
  }

  /* ======================================================================== */
  /* 对局流程                                                                  */
  /* ======================================================================== */

  function onStart(message) {
    if (!app.solo) {
      el.gameScreen.classList.remove('solo-mode');
      el.soloMeta.classList.add('hidden');
      el.soloOver.classList.add('hidden');
    }
    app.room = message.room || app.room;
    app.round = message.round || (message.room && message.room.round) || 0;
    app.inGame = true;
    app.playing = true;
    app.spectator = !!message.spectator;
    app.snapshot = null;
    app.you = null;
    app.lastScore = 0;
    app.lastDeath = null;
    app.lastHud = 0;
    app.angleInit = false;
    app.wasAlive = false;
    app.boost = false;
    app.boostMouse = false;
    app.boostKey = false;
    app.boostBtn = false;
    app.camera.ready = false;
    app.camera.targetId = null;
    app.visuals.clear();
    app.particles = [];
    app.resultsUntil = 0;

    hideCountdown();
    el.resultsScreen.classList.add('hidden');
    el.deathBanner.classList.add('hidden');
    el.spectateBadge.classList.add('hidden');
    el.disconnectBanner.classList.add('hidden');
    el.killFeed.replaceChildren();
    el.powerupToast.classList.remove('show');
    el.hudBuffs.innerHTML = '';
    el.hudLives.innerHTML = '';
    el.hudLeaderboard.innerHTML = '';
    el.hudScore.textContent = '0';
    el.hudMass.textContent = '0';
    el.hudKills.textContent = '0';
    el.hudTimer.textContent = '04:00';
    el.hudTimer.classList.remove('low');
    el.hudPing.textContent = '-- ms';

    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    try {
      window.scrollTo(0, 0);
    } catch (_) {
      /* ignore */
    }

    showScreen('game');
    resize();
    playStart();
    showToast(`第 ${app.round} 轮 · 开战`, '#3ff08a', 1600);
  }

  function onState(snapshot) {
    if (app.solo) return;
    if (!app.inGame) {
      onStart({ room: app.room, round: snapshot.round });
    }

    app.snapshot = snapshot;
    app.playing = true;

    const you = getYou(snapshot);
    app.you = you;

    if (!app.angleInit && you) {
      app.angle = you.angle || 0;
      app.angleInit = true;
    }

    if (you && you.alive && !app.wasAlive) {
      app.camera.ready = false;
    }
    app.wasAlive = !!(you && you.alive);

    if (you && you.score > app.lastScore) {
      if (app.lastScore > 0 && you.points.length) {
        spawnBurst(you.points[0][0], you.points[0][1], '#b9ffd8', 7, 90);
        playEat();
      }
      app.lastScore = you.score;
    }

    app.spectator = !!(you && you.spectator);
  }

  function onEvents(events) {
    if (!Array.isArray(events)) return;

    for (const event of events) {
      if (!event || typeof event !== 'object') continue;

      if (event.kind === 'death') {
        addKillFeed(event);
        spawnBurst(event.x, event.y, event.color || '#ff6b7d', 26, 210);
        if (event.id === app.youId) {
          app.lastDeath = event;
          app.shake = 15;
          playDeath();
        } else if (event.killerId === app.youId) {
          app.shake = 8;
          playKill();
        }
      } else if (event.kind === 'revived') {
        if (event.id === app.youId) {
          app.camera.ready = false;
          el.deathBanner.classList.add('hidden');
          playRevive();
        }
        spawnBurst(event.x, event.y, '#7dffb0', 18, 150);
      } else if (event.kind === 'powerup') {
        spawnBurst(event.x, event.y, POWERUP_META[event.type]?.color || '#fff', 14, 130);
        if (event.id === app.youId) {
          playPowerup();
          showToast(`获得 ${POWERUP_META[event.type]?.name || event.type}`, POWERUP_META[event.type]?.color || '#3ff08a', 1800);
        }
      }
    }
  }

  function onEnd(message) {
    app.playing = false;
    app.room = message.room || app.room;
    renderResults(message.results || []);
    app.resultsUntil = performance.now() + 12000;
    app.lastResultsSec = null;
    el.resultsScreen.classList.remove('hidden');
    el.deathBanner.classList.add('hidden');
    el.spectateBadge.classList.add('hidden');
    playEnd(message.winnerId === app.youId);
  }

  function renderResults(results) {
    const sorted = [...results].sort((a, b) => b.score - a.score || b.kills - a.kills || b.bestMass - a.bestMass);
    const winner = sorted[0];
    const youAreWinner = winner && winner.id === app.youId;

    el.resultsTitle.textContent = youAreWinner ? '你赢了！' : winner ? `${winner.name} 获胜` : '本轮结束';

    const roundText = app.round ? `第 ${app.round} 轮` : '本轮';
    el.resultsSub.innerHTML = `${roundText} · 共 <b>${sorted.length}</b> 名玩家 · 击杀与能量决定排名`;

    const fragment = document.createDocumentFragment();
    sorted.forEach((result, index) => {
      const row = document.createElement('div');
      row.className = 'result-row' + (result.id === app.youId ? ' me' : '') + (index === 0 ? ' top1' : '');

      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = String(index + 1).padStart(2, '0');

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.setProperty('--c', result.color);

      const name = document.createElement('span');
      name.className = 'rname';
      name.textContent = result.name + (result.id === app.youId ? '（你）' : '');

      const score = document.createElement('span');
      score.className = 'rscore';
      score.textContent = String(result.score);

      const kills = document.createElement('span');
      kills.className = 'rkills';
      kills.textContent = `击杀 ${result.kills}`;

      row.append(rank, dot, name, score, kills);
      fragment.appendChild(row);
    });

    el.resultsList.replaceChildren(fragment);
  }

  function updateResultsCountdown() {
    if (!app.resultsUntil) return;
    const seconds = Math.max(0, Math.ceil((app.resultsUntil - performance.now()) / 1000));
    if (seconds !== app.lastResultsSec) {
      app.lastResultsSec = seconds;
      el.resultsNext.textContent = seconds > 0 ? `${seconds} 秒后回到房间` : '即将回到房间…';
    }
  }

  function showToast(text, color, duration = 1800) {
    el.powerupToast.textContent = text;
    el.powerupToast.style.setProperty('--c', color);
    el.powerupToast.classList.add('show');
    clearTimeout(app.powerupToastTimer);
    app.powerupToastTimer = setTimeout(() => {
      el.powerupToast.classList.remove('show');
    }, duration);
  }

  function addKillFeed(event) {
    const item = document.createElement('div');
    item.className = 'feed-item';

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.setProperty('--c', event.color || '#8aa');
    item.appendChild(dot);

    const text = document.createElement('span');

    if (event.killerName) {
      const killer = document.createElement('b');
      killer.textContent = event.killerName;
      const victim = document.createElement('b');
      victim.textContent = event.name;
      const verb = event.reason === 'body' ? ' 撞上了 ' : ' 吞噬了 ';
      text.append(killer, document.createTextNode(verb), victim);
      if (event.killerId === app.youId) item.classList.add('kill');
    } else if (event.reason === 'wall') {
      const victim = document.createElement('b');
      victim.textContent = event.name;
      text.append(victim, document.createTextNode(' 撞上了边界'));
    } else if (event.reason === 'head') {
      const victim = document.createElement('b');
      victim.textContent = event.name;
      text.append(victim, document.createTextNode(' 与对手同归于尽'));
    } else {
      const victim = document.createElement('b');
      victim.textContent = event.name;
      text.append(victim, document.createTextNode(' 阵亡'));
    }

    item.appendChild(text);
    if (event.id === app.youId) item.classList.add('mine');
    el.killFeed.appendChild(item);

    while (el.killFeed.children.length > 5) {
      el.killFeed.firstElementChild.remove();
    }

    setTimeout(() => {
      if (!item.parentNode) return;
      item.style.opacity = '0';
      item.style.transform = 'translateY(-4px)';
      setTimeout(() => item.remove(), 240);
    }, 4500);
  }

  function leaveRoom() {
    app.leaving = true;
    app.connected = false;
    app.playing = false;
    app.inGame = false;
    app.youId = null;
    app.snapshot = null;
    app.room = null;
    app.server = null;
    app.you = null;
    app.visuals.clear();
    app.particles = [];
    app.resultsUntil = 0;

    if (app.ws) {
      const socket = app.ws;
      app.ws = null;
      try {
        socket.close();
      } catch (_) {
        /* ignore */
      }
    }

    hideCountdown();
    el.resultsScreen.classList.add('hidden');
    el.deathBanner.classList.add('hidden');
    el.spectateBadge.classList.add('hidden');
    el.disconnectBanner.classList.add('hidden');
    el.killFeed.replaceChildren();
    showScreen('connect');
    el.connectBtn.disabled = false;
    setStatus('已离开房间。', 'ok');
    setTimeout(() => {
      app.leaving = false;
    }, 800);
  }

  /* ======================================================================== */
  /* HUD                                                                      */
  /* ======================================================================== */

  function updateHUD() {
    const snapshot = app.snapshot;
    if (!snapshot || !app.inGame) return;
    const you = getYou(snapshot);

    if (app.solo) {
      if (you) {
        el.hudScore.textContent = String(you.score);
        el.hudMass.textContent = String(you.mass);
        el.hudKills.textContent = '0';
        el.hudLives.innerHTML = '';
        el.soloBest.textContent = '最高 ' + Math.max(app.soloBest, you.score);

        const buffs = [];
        for (const key of ['speed', 'magnet', 'double']) {
          const remaining = you.buffs ? you.buffs[key] : 0;
          if (remaining > 0) {
            const meta = POWERUP_META[key];
            buffs.push(`<span class="buff" style="--c:${meta.color}"><i></i>${meta.name}<b>${Math.ceil(remaining / 1000)}s</b></span>`);
          }
        }
        el.hudBuffs.innerHTML = buffs.join('');
      }

      el.hudTimer.textContent = '∞';
      el.hudTimer.classList.remove('low');
      drawMinimap(snapshot);
      return;
    }

    if (you) {
      el.hudScore.textContent = String(you.score);
      el.hudMass.textContent = String(you.mass);
      el.hudKills.textContent = String(you.kills);

      if (you.eliminated) {
        el.hudLives.className = 'lives';
        el.hudLives.textContent = '已淘汰';
      } else if (you.lives > 0) {
        el.hudLives.className = 'lives on';
        el.hudLives.innerHTML = `<b>❤</b> 复活 × ${you.lives}`;
      } else {
        el.hudLives.className = 'lives';
        el.hudLives.innerHTML = '<b>♡</b> 无复活机会';
      }

      const buffs = [];
      for (const key of ['shield', 'speed', 'magnet', 'double']) {
        const remaining = you.buffs ? you.buffs[key] : 0;
        if (remaining > 0) {
          const meta = POWERUP_META[key];
          buffs.push(`<span class="buff" style="--c:${meta.color}"><i></i>${meta.name}<b>${Math.ceil(remaining / 1000)}s</b></span>`);
        }
      }
      el.hudBuffs.innerHTML = buffs.join('');

      if (!you.alive && !you.eliminated && !you.spectator) {
        el.deathBanner.classList.remove('hidden');
        el.deathEyebrow.textContent = 'CAUGHT';
        el.deathTitle.textContent = deathTitle(you);
        const seconds = Math.max(1, Math.ceil((you.respawnIn || 0) / 1000));
        el.deathText.innerHTML = `<b>${seconds}</b> 秒后自动复活`;
        el.spectateBadge.classList.add('hidden');
      } else if (!you.alive && (you.eliminated || you.spectator)) {
        el.deathBanner.classList.add('hidden');
        el.spectateBadge.classList.remove('hidden');
        el.spectateBadge.textContent = you.spectator ? '观战中 · 本轮结束后可加入' : '你已被淘汰 · 本轮观战';
      } else {
        el.deathBanner.classList.add('hidden');
        el.spectateBadge.classList.add('hidden');
      }
    }

    el.hudTimer.textContent = formatTime(snapshot.timeLeft);
    el.hudTimer.classList.toggle('low', snapshot.timeLeft <= 30000);
    el.hudPing.textContent = app.ping ? `${app.ping} ms` : '-- ms';
    updateLeaderboard(snapshot);
    drawMinimap(snapshot);
  }

  function deathTitle(you) {
    const death = app.lastDeath;
    if (!death) return '你阵亡了';
    if (death.killerName) {
      if (death.reason === 'body') return `撞上了 ${death.killerName} 的身体`;
      if (death.reason === 'eaten') return `被 ${death.killerName} 吞噬`;
      return `被 ${death.killerName} 击倒`;
    }
    if (death.reason === 'wall') return '撞上了边界';
    if (death.reason === 'head') return '与对手同归于尽';
    return '你阵亡了';
  }

  function updateLeaderboard(snapshot) {
    const sorted = [...snapshot.players].sort((a, b) => b.score - a.score || b.kills - a.kills);
    const fragment = document.createDocumentFragment();

    sorted.slice(0, 5).forEach((player, index) => {
      const row = document.createElement('li');
      if (player.id === app.youId) row.classList.add('me');
      if (player.eliminated || player.spectator) row.classList.add('dead');

      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = String(index + 1);

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.setProperty('--c', player.color);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = player.name;

      const points = document.createElement('span');
      points.className = 'pts';
      points.textContent = String(player.score);

      row.append(rank, dot, name, points);
      fragment.appendChild(row);
    });

    el.hudLeaderboard.replaceChildren(fragment);
  }

  function drawMinimap(snapshot) {
    if (!snapshot) return;
    const width = mini.width;
    const height = mini.height;
    const map = mapSize();

    miniCtx.clearRect(0, 0, width, height);
    miniCtx.fillStyle = 'rgba(3, 14, 16, .88)';
    miniCtx.fillRect(0, 0, width, height);

    miniCtx.strokeStyle = 'rgba(110, 255, 210, .16)';
    miniCtx.lineWidth = 1;
    miniCtx.strokeRect(1.5, 1.5, width - 3, height - 3);

    const toX = (x) => clamp((x / map.w) * width, 2, width - 2);
    const toY = (y) => clamp((y / map.h) * height, 2, height - 2);

    const halfW = viewW / (2 * app.camera.zoom);
    const halfH = viewH / (2 * app.camera.zoom);
    miniCtx.strokeStyle = 'rgba(255, 255, 255, .1)';
    miniCtx.strokeRect(
      toX(app.camera.x - halfW),
      toY(app.camera.y - halfH),
      toX(app.camera.x + halfW) - toX(app.camera.x - halfW),
      toY(app.camera.y + halfH) - toY(app.camera.y - halfH)
    );

    for (const item of snapshot.powerups) {
      const meta = POWERUP_META[item[2]];
      miniCtx.fillStyle = meta ? meta.color : '#fff';
      miniCtx.fillRect(toX(item[0]) - 1.5, toY(item[1]) - 1.5, 3, 3);
    }

    for (const player of snapshot.players) {
      if (!player.alive) continue;
      const x = toX(player.x);
      const y = toY(player.y);
      miniCtx.beginPath();
      miniCtx.fillStyle = player.color;
      miniCtx.arc(x, y, player.id === app.youId ? 3.2 : 2.4, 0, TAU);
      miniCtx.fill();
      if (player.id === app.youId) {
        miniCtx.strokeStyle = '#fff';
        miniCtx.lineWidth = 1.4;
        miniCtx.stroke();
      }
    }
  }

  /* ======================================================================== */
  /* 输入                                                                     */
  /* ======================================================================== */

  function refreshBoost() {
    app.boost = !!(app.boostMouse || app.boostKey || app.boostBtn);
  }

  function startJoystick(event) {
    el.touchHint.classList.add('hidden');
    app.joystick = {
      id: event.pointerId,
      ox: event.clientX,
      oy: event.clientY,
      x: event.clientX,
      y: event.clientY
    };
    if (canvas.setPointerCapture) {
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch (_) {
        /* ignore */
      }
    }
  }

  function moveJoystick(event) {
    const joystick = app.joystick;
    if (!joystick || joystick.id !== event.pointerId) return;
    const dx = event.clientX - joystick.ox;
    const dy = event.clientY - joystick.oy;
    const distance = Math.hypot(dx, dy);
    const capped = Math.min(distance, 62);

    if (distance > 0) {
      joystick.x = joystick.ox + (dx / distance) * capped;
      joystick.y = joystick.oy + (dy / distance) * capped;
    }
    if (distance > 9) app.angle = Math.atan2(dy, dx);
  }

  function endJoystick(event) {
    if (!app.joystick) return;
    if (event && app.joystick.id !== event.pointerId) return;
    if (canvas.releasePointerCapture && event) {
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch (_) {
        /* ignore */
      }
    }
    app.joystick = null;
  }

  function updateAim() {
    if (!app.mouseSeen || app.joystick) return;
    const you = getYou();
    if (!you || !you.alive) return;

    const visual = app.visuals.get(you.id);
    const head = visual && visual.points.length ? visual.points[0] : you;
    const point = worldToScreen(head.x, head.y);
    const dx = app.mouseX - point.x;
    const dy = app.mouseY - point.y;
    if (Math.hypot(dx, dy) > 26) app.angle = Math.atan2(dy, dx);
  }

  function sendInput() {
    if (app.solo) return;
    if (!app.ws || app.ws.readyState !== WebSocket.OPEN) return;
    if (!app.playing || !app.inGame) return;
    const you = getYou();
    if (!you || !you.alive) return;

    app.ws.send(JSON.stringify({
      type: 'input',
      angle: app.angle,
      boost: app.boost
    }));
  }

  function pingServer() {
    if (app.solo) return;
    if (!app.ws || app.ws.readyState !== WebSocket.OPEN) return;
    app.ws.send(JSON.stringify({ type: 'ping', t: performance.now() }));
  }

  /* ======================================================================== */
  /* 单人无尽                                                                  */
  /* ======================================================================== */

  function soloNormAngle(angle) {
    let value = (angle + Math.PI) % TAU;
    if (value < 0) value += TAU;
    return value - Math.PI;
  }

  function soloRadius(mass) {
    return 9 + Math.sqrt(Math.max(1, mass)) * 0.8;
  }

  function soloLength(mass) {
    return 90 + Math.max(1, mass) * 1.6;
  }

  function soloRound1(value) {
    return Math.round(value * 10) / 10;
  }

  function soloRandom(min, max) {
    return min + Math.random() * (max - min);
  }

  function soloMakeBody(x, y, angle, length) {
    const points = [];
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    for (let dist = 0; dist <= length; dist += 7) {
      points.push({ x: x - dx * dist, y: y - dy * dist });
    }
    return points;
  }

  function soloTrim(points, targetLength) {
    let total = 0;
    for (let index = 1; index < points.length; index++) {
      total += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
      if (total >= targetLength) {
        points.length = index + 1;
        return;
      }
    }
  }

  function soloAddFood(state, x, y, mass) {
    state.food.push({
      x: Number.isFinite(x) ? clamp(x, 20, SOLO.MAP_W - 20) : soloRandom(60, SOLO.MAP_W - 60),
      y: Number.isFinite(y) ? clamp(y, 20, SOLO.MAP_H - 20) : soloRandom(60, SOLO.MAP_H - 60),
      c: Math.floor(Math.random() * FOOD_COLORS.length),
      mass: Number.isFinite(mass) ? mass : soloRandom(0.8, 3)
    });
  }

  function soloAddPowerup(state) {
    const types = ['speed', 'magnet', 'double'];
    const type = types[Math.floor(Math.random() * types.length)];
    let x = 0;
    let y = 0;

    for (let attempt = 0; attempt < 12; attempt++) {
      x = soloRandom(220, SOLO.MAP_W - 220);
      y = soloRandom(220, SOLO.MAP_H - 220);
      if (!state.points.length || Math.hypot(x - state.x, y - state.y) > 420) break;
    }

    state.powerups.push({ x, y, type });
  }

  function createSoloState(name, color) {
    const now = performance.now();
    const x = SOLO.MAP_W / 2;
    const y = SOLO.MAP_H / 2;
    const angle = -Math.PI / 2;
    const mass = SOLO.BASE_MASS;
    const state = {
      name,
      color,
      mass,
      radius: soloRadius(mass),
      score: 0,
      deaths: 0,
      bestMass: mass,
      x,
      y,
      angle,
      points: soloMakeBody(x, y, angle, soloLength(mass)),
      alive: true,
      boosting: false,
      deadReason: '',
      buffs: { speedUntil: 0, magnetUntil: 0, doubleUntil: 0 },
      boostOrbAt: 0,
      lastEatSound: 0,
      nextPowerupAt: now + 4000,
      food: [],
      powerups: []
    };

    for (let index = 0; index < SOLO.FOOD_COUNT; index++) soloAddFood(state);
    for (let index = 0; index < 3; index++) soloAddPowerup(state);

    return state;
  }

  function soloSnapshot() {
    const state = app.soloState;
    if (!state) return null;
    const now = performance.now();

    return {
      type: 'state',
      t: now,
      serverTime: now,
      timeLeft: 0,
      round: 1,
      players: [{
        id: 'solo',
        name: state.name,
        color: state.color,
        alive: state.alive,
        eliminated: false,
        spectator: false,
        score: state.score,
        kills: 0,
        deaths: state.deaths,
        lives: 0,
        mass: Math.round(state.mass),
        radius: soloRound1(state.radius),
        x: Math.round(state.x),
        y: Math.round(state.y),
        angle: Math.round(state.angle * 100) / 100,
        boosting: state.boosting,
        shield: false,
        invuln: false,
        respawnIn: 0,
        buffs: {
          shield: 0,
          speed: Math.max(0, state.buffs.speedUntil - now),
          magnet: Math.max(0, state.buffs.magnetUntil - now),
          double: Math.max(0, state.buffs.doubleUntil - now)
        },
        points: state.alive ? state.points.map((point) => [Math.round(point.x), Math.round(point.y)]) : []
      }],
      food: state.food.map((item) => [Math.round(item.x), Math.round(item.y), item.c, soloRound1(item.mass)]),
      powerups: state.powerups.map((item) => [Math.round(item.x), Math.round(item.y), item.type]),
      aliveCount: state.alive ? 1 : 0,
      participants: 1
    };
  }

  function startSolo() {
    unlockAudio();
    const name = (el.nameInput.value.trim() || '独行蛇').slice(0, 12);
    const color = app.youColor;

    if (app.ws) {
      const socket = app.ws;
      app.ws = null;
      try {
        socket.close();
      } catch (_) {
        /* ignore */
      }
    }

    STORE.set('name', name);
    STORE.set('color', color);
    app.connected = false;
    app.connecting = false;
    app.serverError = '';
    app.leaving = false;
    app.solo = true;
    app.soloBest = Number(STORE.get('snakeArenaSoloBest', '0')) || 0;
    app.soloState = createSoloState(name, color);
    app.soloAccumulator = 0;
    app.youId = 'solo';
    app.youName = name;
    app.youColor = color;
    app.config = { map: { w: SOLO.MAP_W, h: SOLO.MAP_H } };
    app.room = null;
    app.server = null;
    app.inGame = true;
    app.playing = true;
    app.spectator = false;
    app.snapshot = null;
    app.you = null;
    app.lastFrame = 0;
    app.lastHud = 0;
    app.lastScore = 0;
    app.lastDeath = null;
    app.angle = app.soloState.angle;
    app.angleInit = true;
    app.boost = false;
    app.boostMouse = false;
    app.boostKey = false;
    app.boostBtn = false;
    app.joystick = null;
    app.mouseSeen = false;
    app.mouseX = viewW / 2;
    app.mouseY = viewH / 2;
    app.camera.x = app.soloState.x;
    app.camera.y = app.soloState.y;
    app.camera.zoom = 1;
    app.camera.ready = false;
    app.camera.targetId = 'solo';
    app.visuals.clear();
    app.particles = [];
    app.shake = 0;
    app.resultsUntil = 0;
    app.countdownActive = false;
    app.lastCountdownSec = null;
    app.lastResultsSec = null;

    el.gameScreen.classList.add('solo-mode');
    el.soloMeta.classList.remove('hidden');
    el.soloOver.classList.add('hidden');
    el.soloBest.textContent = '最高 ' + app.soloBest;
    el.soloBestScore.textContent = String(app.soloBest);
    el.soloScore.textContent = '0';
    el.soloMass.textContent = '0';
    el.soloReason.textContent = '撞上了边界';

    el.resultsScreen.classList.add('hidden');
    el.deathBanner.classList.add('hidden');
    el.spectateBadge.classList.add('hidden');
    el.disconnectBanner.classList.add('hidden');
    el.killFeed.replaceChildren();
    el.powerupToast.classList.remove('show');
    el.hudBuffs.innerHTML = '';
    el.hudLives.innerHTML = '';
    el.hudLeaderboard.innerHTML = '';
    el.hudScore.textContent = '0';
    el.hudMass.textContent = '0';
    el.hudKills.textContent = '0';
    el.hudTimer.textContent = '∞';
    el.hudTimer.classList.remove('low');
    el.hudPing.textContent = '单机';
    el.connectBtn.disabled = false;

    hideCountdown();
    app.snapshot = soloSnapshot();
    app.you = getYou();

    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    try {
      window.scrollTo(0, 0);
    } catch (_) {
      /* ignore */
    }

    showScreen('game');
    resize();
    playStart();
    showToast('单人无尽 · 撞墙或咬到自己结束', '#5ce1ff', 2200);
  }

  function restartSolo() {
    if (!app.solo) return;
    saveSoloBest();
    startSolo();
  }

  function saveSoloBest() {
    if (!app.soloState) return;
    const best = Math.max(app.soloBest, app.soloState.score);
    app.soloBest = best;
    STORE.set('snakeArenaSoloBest', best);
  }

  function exitSolo() {
    if (!app.solo) return;
    saveSoloBest();

    if (app.ws) {
      const socket = app.ws;
      app.ws = null;
      try {
        socket.close();
      } catch (_) {
        /* ignore */
      }
    }

    app.solo = false;
    app.soloState = null;
    app.soloAccumulator = 0;
    app.inGame = false;
    app.playing = false;
    app.spectator = false;
    app.snapshot = null;
    app.you = null;
    app.youId = null;
    app.room = null;
    app.server = null;
    app.connected = false;
    app.connecting = false;
    app.serverError = '';
    app.leaving = false;
    app.angleInit = false;
    app.joystick = null;
    app.boost = false;
    app.boostMouse = false;
    app.boostKey = false;
    app.boostBtn = false;
    app.camera.ready = false;
    app.visuals.clear();
    app.particles = [];
    app.shake = 0;
    app.resultsUntil = 0;
    app.lastFrame = 0;

    el.gameScreen.classList.remove('solo-mode');
    el.soloMeta.classList.add('hidden');
    el.soloOver.classList.add('hidden');
    el.resultsScreen.classList.add('hidden');
    el.deathBanner.classList.add('hidden');
    el.spectateBadge.classList.add('hidden');
    el.disconnectBanner.classList.add('hidden');
    el.killFeed.replaceChildren();
    el.powerupToast.classList.remove('show');
    el.connectBtn.disabled = false;

    showScreen('connect');
    setStatus('已退出单人无尽，可以重新联机。', 'ok');
  }

  function updateSolo(dt) {
    const state = app.soloState;
    if (!state || !state.alive) return;

    app.soloAccumulator += dt;
    let steps = 0;
    while (app.soloAccumulator >= SOLO.STEP && steps < 3 && state.alive) {
      stepSolo(SOLO.STEP);
      app.soloAccumulator -= SOLO.STEP;
      steps++;
    }

    if (steps) {
      app.snapshot = soloSnapshot();
      app.you = getYou();
    }
  }

  function stepSolo(dt) {
    const state = app.soloState;
    if (!state || !state.alive) return;
    const now = performance.now();

    const turn = clamp(soloNormAngle(app.angle - state.angle), -SOLO.TURN_RATE * dt, SOLO.TURN_RATE * dt);
    state.angle = soloNormAngle(state.angle + turn);

    let speed = SOLO.BASE_SPEED * (1 - clamp((state.radius - 12) * 0.004, 0, 0.15));
    if (state.buffs.speedUntil > now) speed *= SOLO.SPEED_BUFF_MULT;

    const canBoost = app.boost && state.mass > SOLO.BOOST_MIN_MASS;
    state.boosting = canBoost;
    if (canBoost) speed *= SOLO.BOOST_MULT;

    const head = state.points[0];
    const nx = head.x + Math.cos(state.angle) * speed * dt;
    const ny = head.y + Math.sin(state.angle) * speed * dt;

    if (nx < 0 || ny < 0 || nx > SOLO.MAP_W || ny > SOLO.MAP_H) {
      soloDie('撞上了边界');
      return;
    }

    state.points.unshift({ x: nx, y: ny });
    state.x = nx;
    state.y = ny;

    if (canBoost) {
      state.mass = Math.max(SOLO.MIN_MASS, state.mass - SOLO.BOOST_DRAIN * dt);
      state.radius = soloRadius(state.mass);
      if (now >= state.boostOrbAt) {
        state.boostOrbAt = now + SOLO.BOOST_ORB_MS;
        const tail = state.points[state.points.length - 1];
        if (tail) soloAddFood(state, tail.x + soloRandom(-4, 4), tail.y + soloRandom(-4, 4), 1.2);
      }
    }

    state.radius = soloRadius(state.mass);
    soloTrim(state.points, soloLength(state.mass));
    state.bestMass = Math.max(state.bestMass, state.mass);

    const newHead = state.points[0];
    for (let index = 10; index < state.points.length; index++) {
      const point = state.points[index];
      if (Math.hypot(newHead.x - point.x, newHead.y - point.y) < state.radius * 0.62) {
        soloDie('咬到了自己');
        return;
      }
    }

    const magnet = state.buffs.magnetUntil > now;
    const double = state.buffs.doubleUntil > now;

    for (let index = state.food.length - 1; index >= 0; index--) {
      const food = state.food[index];
      let dx = newHead.x - food.x;
      let dy = newHead.y - food.y;
      let distance = Math.hypot(dx, dy);

      if (magnet && distance < 265 && distance > 1) {
        const pull = Math.min(distance, 220 * dt);
        food.x += (dx / distance) * pull;
        food.y += (dy / distance) * pull;
        dx = newHead.x - food.x;
        dy = newHead.y - food.y;
        distance = Math.hypot(dx, dy);
      }

      if (distance > state.radius + 6) continue;

      state.food.splice(index, 1);
      state.mass += food.mass;
      state.radius = soloRadius(state.mass);
      state.score += Math.round(food.mass * 10 * (double ? 2 : 1));
      state.bestMass = Math.max(state.bestMass, state.mass);
      spawnBurst(food.x, food.y, FOOD_COLORS[food.c] || '#b9ffd8', 4, 55);
      if (now - state.lastEatSound > 70) {
        state.lastEatSound = now;
        playEat();
      }
    }

    for (let index = state.powerups.length - 1; index >= 0; index--) {
      const powerup = state.powerups[index];
      if (Math.hypot(newHead.x - powerup.x, newHead.y - powerup.y) > state.radius + 17) continue;

      state.powerups.splice(index, 1);
      if (powerup.type === 'speed') {
        state.buffs.speedUntil = Math.max(now, state.buffs.speedUntil) + 8000;
      } else if (powerup.type === 'magnet') {
        state.buffs.magnetUntil = Math.max(now, state.buffs.magnetUntil) + 12000;
      } else if (powerup.type === 'double') {
        state.buffs.doubleUntil = Math.max(now, state.buffs.doubleUntil) + 12000;
      }

      const meta = POWERUP_META[powerup.type];
      spawnBurst(powerup.x, powerup.y, meta ? meta.color : '#5ce1ff', 12, 120);
      playPowerup();
      showToast(`获得 ${meta ? meta.name : powerup.type}`, meta ? meta.color : '#5ce1ff', 1500);
    }

    while (state.food.length < SOLO.FOOD_COUNT) soloAddFood(state);

    if (now >= state.nextPowerupAt) {
      if (state.powerups.length < SOLO.POWERUP_MAX) soloAddPowerup(state);
      state.nextPowerupAt = now + SOLO.POWERUP_EVERY_MS;
    }
  }

  function soloDie(reason) {
    const state = app.soloState;
    if (!state || !state.alive) return;

    state.alive = false;
    state.deadReason = reason;
    state.boosting = false;
    state.deaths += 1;
    app.playing = false;
    app.soloAccumulator = 0;

    const best = Math.max(app.soloBest, state.score);
    app.soloBest = best;
    STORE.set('snakeArenaSoloBest', best);
    app.snapshot = soloSnapshot();
    app.you = getYou();
    app.shake = 16;

    const head = state.points[0] || state;
    spawnBurst(head.x, head.y, state.color, 30, 220);
    playDeath();

    el.soloReason.textContent = reason;
    el.soloScore.textContent = String(state.score);
    el.soloMass.textContent = String(Math.round(state.mass));
    el.soloBestScore.textContent = String(best);
    el.soloBest.textContent = '最高 ' + best;
    el.soloOver.classList.remove('hidden');
  }

  /* ======================================================================== */
  /* 视觉同步                                                                  */
  /* ======================================================================== */

  function updateVisuals(dt) {
    const snapshot = app.snapshot;
    if (!snapshot) return;

    const seen = new Set();

    for (const player of snapshot.players) {
      seen.add(player.id);
      let visual = app.visuals.get(player.id);

      if (!visual) {
        visual = {
          id: player.id,
          points: (player.points || []).map((point) => ({ x: point[0], y: point[1] })),
          color: player.color,
          name: player.name,
          radius: player.radius || 13,
          angle: player.angle || 0,
          opacity: player.alive ? 1 : 0,
          alive: !!player.alive,
          shield: false,
          invuln: false,
          boosting: false
        };
        app.visuals.set(player.id, visual);
      }

      if (!player.alive) {
        visual.alive = false;
        visual.opacity = Math.max(0, visual.opacity - dt * 2.6);
        continue;
      }

      if (!visual.alive) {
        visual.points = (player.points || []).map((point) => ({ x: point[0], y: point[1] }));
        visual.opacity = 1;
        visual.alive = true;
        if (player.id === app.youId) app.camera.ready = false;
      }

      visual.color = player.color;
      visual.name = player.name;
      visual.radius = player.radius;
      visual.angle = player.angle;
      visual.shield = !!player.shield;
      visual.invuln = !!player.invuln;
      visual.boosting = !!player.boosting;
      visual.opacity = 1;

      const target = player.points || [];
      while (visual.points.length > target.length) visual.points.pop();
      while (visual.points.length < target.length) {
        const point = target[visual.points.length];
        visual.points.push({ x: point[0], y: point[1] });
      }

      const ease = 1 - Math.exp(-dt * (player.id === app.youId ? 22 : 13));
      for (let index = 0; index < target.length; index++) {
        visual.points[index].x += (target[index][0] - visual.points[index].x) * ease;
        visual.points[index].y += (target[index][1] - visual.points[index].y) * ease;
      }

      if (visual.boosting && visual.points.length > 2 && Math.random() < 0.55) {
        const tail = visual.points[visual.points.length - 1];
        addParticle({
          x: tail.x,
          y: tail.y,
          vx: (Math.random() - 0.5) * 34,
          vy: (Math.random() - 0.5) * 34,
          life: 0.45 + Math.random() * 0.3,
          maxLife: 0.75,
          size: 1.6 + Math.random() * 2.6,
          color: player.color
        });
      }
    }

    for (const [id, visual] of app.visuals) {
      if (seen.has(id)) continue;
      visual.alive = false;
      visual.opacity = Math.max(0, visual.opacity - dt * 2.4);
      if (visual.opacity <= 0.01) app.visuals.delete(id);
    }
  }

  function updateCamera(dt) {
    const snapshot = app.snapshot;
    if (!snapshot) return;

    let target = snapshot.players.find((player) => player.id === app.youId && player.alive);
    if (!target) {
      target = snapshot.players
        .filter((player) => player.alive)
        .sort((a, b) => b.score - a.score)[0] || null;
    }
    if (!target) return;

    const visual = app.visuals.get(target.id);
    const head = visual && visual.points.length ? visual.points[0] : target;
    const radius = target.radius || 13;

    const base = clamp(Math.min(viewW, viewH) / 900, 0.58, 1.12);
    const sizeZoom = clamp(1 - (radius - 13) * 0.0055, 0.62, 1);
    const targetZoom = base * sizeZoom;

    if (!app.camera.ready) {
      app.camera.x = head.x;
      app.camera.y = head.y;
      app.camera.zoom = targetZoom;
      app.camera.ready = true;
    } else {
      const ease = 1 - Math.exp(-dt * 7);
      app.camera.x += (head.x - app.camera.x) * ease;
      app.camera.y += (head.y - app.camera.y) * ease;
      app.camera.zoom += (targetZoom - app.camera.zoom) * (1 - Math.exp(-dt * 4));
    }

    app.camera.targetId = target.id;
  }

  function addParticle(particle) {
    if (app.particles.length > 320) app.particles.shift();
    app.particles.push(particle);
  }

  function spawnBurst(x, y, color, count, speed) {
    for (let index = 0; index < count; index++) {
      const angle = Math.random() * TAU;
      const velocity = speed * (0.25 + Math.random() * 0.75);
      const life = 0.35 + Math.random() * 0.6;
      addParticle({
        x,
        y,
        vx: Math.cos(angle) * velocity,
        vy: Math.sin(angle) * velocity,
        life,
        maxLife: life,
        size: 1.5 + Math.random() * 3.2,
        color
      });
    }
  }

  function updateParticles(dt) {
    for (const particle of app.particles) {
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vx *= Math.pow(0.06, dt);
      particle.vy *= Math.pow(0.06, dt);
      particle.life -= dt;
    }
    app.particles = app.particles.filter((particle) => particle.life > 0);
  }

  /* ======================================================================== */
  /* 绘制                                                                     */
  /* ======================================================================== */

  function buildOrbSprites() {
    orbSprites = FOOD_COLORS.map((color) => {
      const size = 64;
      const sprite = document.createElement('canvas');
      sprite.width = size;
      sprite.height = size;
      const context = sprite.getContext('2d');
      const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      gradient.addColorStop(0, 'rgba(255,255,255,1)');
      gradient.addColorStop(0.1, color);
      gradient.addColorStop(0.3, color + 'cc');
      gradient.addColorStop(0.55, color + '33');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(size / 2, size / 2, size / 2, 0, TAU);
      context.fill();
      context.fillStyle = '#ffffff';
      context.beginPath();
      context.arc(size / 2, size / 2, 3.1, 0, TAU);
      context.fill();
      return sprite;
    });
  }

  function drawFrame(timestamp) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewW, viewH);
    ctx.fillStyle = '#03080a';
    ctx.fillRect(0, 0, viewW, viewH);

    if (!app.snapshot) return;

    const shakeX = app.shake ? (Math.random() * 2 - 1) * app.shake : 0;
    const shakeY = app.shake ? (Math.random() * 2 - 1) * app.shake : 0;

    ctx.save();
    ctx.translate(viewW / 2 + shakeX, viewH / 2 + shakeY);
    ctx.scale(app.camera.zoom, app.camera.zoom);
    ctx.translate(-app.camera.x, -app.camera.y);

    drawWorld();
    drawFood();
    drawPowerups(timestamp);
    drawParticles();
    drawSnakes(timestamp);

    ctx.restore();

    drawNames();
    drawJoystick();
  }

  function drawWorld() {
    const map = mapSize();
    const bounds = viewBounds(180);

    ctx.fillStyle = '#061115';
    ctx.fillRect(0, 0, map.w, map.h);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, map.w, map.h);
    ctx.clip();

    ctx.strokeStyle = 'rgba(96, 255, 190, .045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const startX = Math.max(0, Math.floor(bounds.left / 100) * 100);
    const endX = Math.min(map.w, bounds.right);
    for (let x = startX; x <= endX; x += 100) {
      ctx.moveTo(x, Math.max(0, bounds.top));
      ctx.lineTo(x, Math.min(map.h, bounds.bottom));
    }
    const startY = Math.max(0, Math.floor(bounds.top / 100) * 100);
    const endY = Math.min(map.h, bounds.bottom);
    for (let y = startY; y <= endY; y += 100) {
      ctx.moveTo(Math.max(0, bounds.left), y);
      ctx.lineTo(Math.min(map.w, bounds.right), y);
    }
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 82, 106, .7)';
    ctx.lineWidth = 5;
    ctx.shadowColor = 'rgba(255, 60, 90, .8)';
    ctx.shadowBlur = 30;
    ctx.strokeRect(0, 0, map.w, map.h);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255, 82, 106, .1)';
    ctx.lineWidth = 26;
    ctx.strokeRect(0, 0, map.w, map.h);
    ctx.restore();
  }

  function drawFood() {
    const bounds = viewBounds(60);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (const item of app.snapshot.food) {
      const x = item[0];
      const y = item[1];
      if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) continue;

      const mass = item[3] || 1;
      const radius = 2.6 + Math.sqrt(mass) * 1.85;
      const size = radius * 5.2;
      const sprite = orbSprites[item[2] % orbSprites.length];
      ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
    }

    ctx.restore();
  }

  function drawPowerups(timestamp) {
    const bounds = viewBounds(80);
    for (let index = 0; index < app.snapshot.powerups.length; index++) {
      const item = app.snapshot.powerups[index];
      const x = item[0];
      const y = item[1];
      if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) continue;

      const meta = POWERUP_META[item[2]];
      if (!meta) continue;

      const pulse = 1 + Math.sin(timestamp / 320 + index * 1.7) * 0.06;

      ctx.save();
      ctx.translate(x, y);
      ctx.scale(pulse, pulse);
      ctx.rotate(timestamp / 1100 + index);
      ctx.beginPath();
      for (let side = 0; side < 6; side++) {
        const angle = -Math.PI / 2 + side * (Math.PI / 3);
        const px = Math.cos(angle) * 15;
        const py = Math.sin(angle) * 15;
        if (side === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = meta.color + '22';
      ctx.strokeStyle = meta.color;
      ctx.lineWidth = 1.6;
      ctx.shadowColor = meta.color;
      ctx.shadowBlur = 18;
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.translate(x, y);
      drawPowerupIcon(item[2], meta.color);
      ctx.restore();
    }
  }

  function drawPowerupIcon(type, color) {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;

    if (type === 'shield') {
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(6, -4.4);
      ctx.lineTo(6, 1);
      ctx.quadraticCurveTo(6, 6, 0, 8.4);
      ctx.quadraticCurveTo(-6, 6, -6, 1);
      ctx.lineTo(-6, -4.4);
      ctx.closePath();
      ctx.stroke();
    } else if (type === 'speed') {
      ctx.beginPath();
      ctx.moveTo(1.5, -9);
      ctx.lineTo(-5, 1.5);
      ctx.lineTo(-0.5, 1.5);
      ctx.lineTo(-2, 9);
      ctx.lineTo(5, -2);
      ctx.lineTo(0.5, -2);
      ctx.closePath();
      ctx.fill();
    } else if (type === 'magnet') {
      ctx.beginPath();
      ctx.moveTo(-6, -7);
      ctx.lineTo(-6, 1);
      ctx.arc(0, 1, 6, Math.PI, 0, false);
      ctx.lineTo(6, -7);
      ctx.stroke();
    } else if (type === 'double') {
      ctx.font = '700 12px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('×2', 0, 0.5);
    } else if (type === 'life') {
      ctx.beginPath();
      ctx.moveTo(0, 7);
      ctx.bezierCurveTo(-9, 0, -6, -7, -1.6, -4.6);
      ctx.lineTo(0, -3);
      ctx.lineTo(1.6, -4.6);
      ctx.bezierCurveTo(6, -7, 9, 0, 0, 7);
      ctx.fill();
    }
  }

  function drawSnakes(timestamp) {
    const visuals = [...app.visuals.values()].sort((a, b) => {
      if (a.id === app.youId) return 1;
      if (b.id === app.youId) return -1;
      return a.points.length - b.points.length;
    });

    for (const visual of visuals) {
      if (!visual.points.length || visual.opacity <= 0.02) continue;

      const points = visual.points;
      const head = points[0];
      const tail = points[points.length - 1];
      const radius = visual.radius;
      const opacity = visual.opacity;

      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let index = 1; index < points.length; index++) {
        ctx.lineTo(points[index].x, points[index].y);
      }

      ctx.strokeStyle = 'rgba(0, 7, 9, .65)';
      ctx.lineWidth = radius * 2 + 6;
      ctx.stroke();

      const gradient = ctx.createLinearGradient(head.x, head.y, tail.x, tail.y);
      gradient.addColorStop(0, shade(visual.color, 22));
      gradient.addColorStop(0.55, visual.color);
      gradient.addColorStop(1, shade(visual.color, -24));

      ctx.strokeStyle = gradient;
      ctx.lineWidth = radius * 2;
      ctx.shadowColor = visual.color;
      ctx.shadowBlur = visual.boosting ? 30 : 16;
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.strokeStyle = 'rgba(255, 255, 255, .1)';
      ctx.lineWidth = radius * 0.48;
      ctx.stroke();

      ctx.fillStyle = shade(visual.color, 34);
      ctx.globalAlpha = opacity * 0.2;
      for (let index = 3; index < points.length; index += 5) {
        ctx.beginPath();
        ctx.arc(points[index].x, points[index].y, radius * 0.34, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = opacity;

      // 头部
      const angle = points.length > 2
        ? Math.atan2(head.y - points[2].y, head.x - points[2].x)
        : visual.angle;
      const headRadius = radius + 3;

      ctx.beginPath();
      ctx.fillStyle = shade(visual.color, 34);
      ctx.arc(head.x, head.y, headRadius, 0, TAU);
      ctx.fill();

      ctx.beginPath();
      ctx.strokeStyle = 'rgba(0, 8, 10, .45)';
      ctx.lineWidth = 2;
      ctx.arc(head.x, head.y, headRadius, 0, TAU);
      ctx.stroke();

      // 眼睛
      const forward = Math.cos(angle);
      const sideward = Math.sin(angle);
      const perpX = -sideward;
      const perpY = forward;

      for (const side of [-1, 1]) {
        const eyeX = head.x + forward * headRadius * 0.32 + perpX * side * headRadius * 0.42;
        const eyeY = head.y + sideward * headRadius * 0.32 + perpY * side * headRadius * 0.42;

        ctx.beginPath();
        ctx.fillStyle = '#051114';
        ctx.arc(eyeX, eyeY, headRadius * 0.27, 0, TAU);
        ctx.fill();

        ctx.beginPath();
        ctx.fillStyle = 'rgba(235, 255, 248, .92)';
        ctx.arc(eyeX + forward * headRadius * 0.1, eyeY + sideward * headRadius * 0.1, headRadius * 0.12, 0, TAU);
        ctx.fill();
      }

      if (visual.shield || visual.invuln) {
        const ringColor = visual.shield ? '#67e8f9' : '#ffd166';
        ctx.save();
        ctx.strokeStyle = ringColor;
        ctx.globalAlpha = opacity * (visual.invuln ? (0.55 + Math.sin(timestamp / 120) * 0.25) : 0.75);
        ctx.lineWidth = 2;
        ctx.setLineDash([7, 6]);
        ctx.lineDashOffset = -timestamp / 70;
        ctx.shadowColor = ringColor;
        ctx.shadowBlur = 14;
        ctx.beginPath();
        ctx.arc(head.x, head.y, headRadius + 10, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }

      if (visual.id === app.youId) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255, 255, 255, .32)';
        ctx.lineWidth = 1.2;
        ctx.arc(head.x, head.y, headRadius + 2, 0, TAU);
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  function drawParticles() {
    if (!app.particles.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const particle of app.particles) {
      const alpha = Math.max(0, particle.life / particle.maxLife);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = particle.color;
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, particle.size * (0.5 + alpha * 0.6), 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawNames() {
    ctx.save();
    ctx.font = '600 11px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const visual of app.visuals.values()) {
      if (!visual.alive || visual.opacity <= 0.05 || !visual.points.length) continue;
      const head = visual.points[0];
      const point = worldToScreen(head.x, head.y);
      if (point.x < -120 || point.x > viewW + 120 || point.y < -80 || point.y > viewH + 80) continue;

      const label = visual.name;
      const width = ctx.measureText(label).width + 18;
      const y = point.y - visual.radius * app.camera.zoom - 17;
      const mine = visual.id === app.youId;

      ctx.globalAlpha = visual.opacity;
      ctx.fillStyle = mine ? 'rgba(6, 28, 19, .82)' : 'rgba(3, 12, 14, .58)';
      roundRect(ctx, point.x - width / 2, y - 9, width, 18, 9);
      ctx.fill();

      if (mine) {
        ctx.strokeStyle = 'rgba(63, 240, 138, .4)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.fillStyle = mine ? '#c9ffdf' : 'rgba(222, 246, 236, .8)';
      ctx.fillText(label, point.x, y + 0.5);
    }

    ctx.restore();
  }

  function drawJoystick() {
    const joystick = app.joystick;
    if (!joystick) return;

    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = 'rgba(63, 240, 138, .55)';
    ctx.fillStyle = 'rgba(3, 16, 13, .35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(joystick.ox, joystick.oy, 58, 0, TAU);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = 'rgba(63, 240, 138, .7)';
    ctx.shadowColor = '#3ff08a';
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(joystick.x, joystick.y, 24, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /* ======================================================================== */
  /* 主循环                                                                   */
  /* ======================================================================== */

  function loop(timestamp) {
    requestAnimationFrame(loop);

    const dt = app.lastFrame ? Math.min((timestamp - app.lastFrame) / 1000, 0.05) : 0.016;
    app.lastFrame = timestamp;

    if (!el.gameScreen.classList.contains('hidden')) {
      if (app.solo && app.playing) updateSolo(dt);
      updateVisuals(dt);
      updateCamera(dt);
      updateAim();
      updateParticles(dt);
      drawFrame(timestamp);

      if (timestamp - app.lastHud > 90) {
        updateHUD();
        app.lastHud = timestamp;
      }
    }

    if (app.countdownActive) updateCountdownDisplay();
    if (app.resultsUntil) updateResultsCountdown();

    app.shake *= Math.exp(-dt * 7);
    if (app.shake < 0.2) app.shake = 0;
  }

  /* ======================================================================== */
  /* 初始化                                                                   */
  /* ======================================================================== */

  function buildColorPicker() {
    const saved = STORE.get('color', '');
    app.youColor = PALETTE.includes(saved) ? saved : PALETTE[0];

    const fragment = document.createDocumentFragment();
    for (const color of PALETTE) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch' + (color === app.youColor ? ' selected' : '');
      button.style.setProperty('--c', color);
      button.dataset.color = color;
      button.setAttribute('aria-label', '颜色 ' + color);
      fragment.appendChild(button);
    }
    el.colorPicker.replaceChildren(fragment);
  }

  function restorePrefs() {
    const savedName = STORE.get('name', '');
    el.nameInput.value = savedName || randomName();
    if (!sameOrigin) {
      el.serverInput.value = STORE.get('server', '');
    } else {
      el.serverInput.value = location.host;
    }
  }

  function updateTouchUI() {
    if (coarsePointer.matches) {
      el.boostBtn.classList.remove('hidden');
      el.touchHint.classList.remove('hidden');
    } else {
      el.boostBtn.classList.add('hidden');
      el.touchHint.classList.add('hidden');
    }
  }

  function bindEvents() {
    el.colorPicker.addEventListener('click', (event) => {
      const swatch = event.target.closest('.swatch');
      if (!swatch) return;
      app.youColor = swatch.dataset.color;
      for (const item of el.colorPicker.querySelectorAll('.swatch')) {
        item.classList.toggle('selected', item === swatch);
      }
      STORE.set('color', app.youColor);
    });

    el.connectBtn.addEventListener('click', connect);
    el.soloBtn.addEventListener('click', startSolo);
    el.soloExitBtn.addEventListener('click', exitSolo);
    el.soloRestartBtn.addEventListener('click', restartSolo);
    el.soloBackBtn.addEventListener('click', exitSolo);
    el.nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') connect();
    });
    el.serverInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') connect();
    });

    el.soundConnectBtn.addEventListener('click', toggleSound);
    el.soundGameBtn.addEventListener('click', toggleSound);
    el.serverPill.addEventListener('click', copyServerAddress);
    el.wanStartBtn.addEventListener('click', startPublicTunnel);
    el.wanStopBtn.addEventListener('click', stopPublicTunnel);
    el.wanCopyBtn.addEventListener('click', copyTunnelUrl);

    el.startBtn.addEventListener('click', () => {
      if (!app.ws || app.ws.readyState !== WebSocket.OPEN) return;
      el.startBtn.disabled = true;
      el.lobbyHint.textContent = '正在进入竞技场…';
      app.ws.send(JSON.stringify({ type: 'start' }));
    });

    el.leaveLobbyBtn.addEventListener('click', leaveRoom);
    el.resultsLeaveBtn.addEventListener('click', leaveRoom);
    el.reconnectBtn.addEventListener('click', () => location.reload());

    canvas.addEventListener('pointerdown', (event) => {
      unlockAudio();
      if (event.pointerType === 'mouse') {
        app.mouseSeen = true;
        app.mouseX = event.clientX;
        app.mouseY = event.clientY;
        app.boostMouse = true;
        refreshBoost();
      } else {
        startJoystick(event);
      }
    });

    canvas.addEventListener('pointermove', (event) => {
      if (event.pointerType === 'mouse') {
        app.mouseSeen = true;
        app.mouseX = event.clientX;
        app.mouseY = event.clientY;
      } else {
        moveJoystick(event);
      }
    });

    canvas.addEventListener('pointerup', (event) => {
      if (event.pointerType === 'mouse') {
        app.boostMouse = false;
        refreshBoost();
      } else {
        endJoystick(event);
      }
    });

    canvas.addEventListener('pointercancel', (event) => {
      if (event.pointerType === 'mouse') {
        app.boostMouse = false;
        refreshBoost();
      } else {
        endJoystick(event);
      }
    });

    canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    el.boostBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      unlockAudio();
      app.boostBtn = true;
      refreshBoost();
      if (el.boostBtn.setPointerCapture) {
        try {
          el.boostBtn.setPointerCapture(event.pointerId);
        } catch (_) {
          /* ignore */
        }
      }
    });

    const releaseBoostButton = () => {
      app.boostBtn = false;
      refreshBoost();
    };
    el.boostBtn.addEventListener('pointerup', releaseBoostButton);
    el.boostBtn.addEventListener('pointercancel', releaseBoostButton);
    el.boostBtn.addEventListener('lostpointercapture', releaseBoostButton);

    window.addEventListener('pointerup', (event) => {
      if (event.pointerType === 'mouse') {
        app.boostMouse = false;
        refreshBoost();
      }
    });

    window.addEventListener('keydown', (event) => {
      if (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return;

      if (event.code === 'Space' || event.key === 'Shift') {
        if (app.inGame && app.playing) {
          event.preventDefault();
          app.boostKey = true;
          refreshBoost();
        }
      }
    });

    window.addEventListener('keyup', (event) => {
      if (event.code === 'Space' || event.key === 'Shift') {
        app.boostKey = false;
        refreshBoost();
      }
    });

    window.addEventListener('blur', () => {
      app.boostMouse = false;
      app.boostKey = false;
      app.boostBtn = false;
      refreshBoost();
      endJoystick(null);
    });

    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        app.boostMouse = false;
        app.boostKey = false;
        app.boostBtn = false;
        refreshBoost();
      }
    });

    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });
    window.addEventListener('pagehide', () => {
      if (app.solo) saveSoloBest();
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && app.solo) exitSolo();
    });

    if (coarsePointer.addEventListener) {
      coarsePointer.addEventListener('change', updateTouchUI);
    }
  }

  function init() {
    buildColorPicker();
    buildOrbSprites();
    restorePrefs();
    bindEvents();
    updateSoundUI();
    updateTouchUI();
    resize();

    if (sameOrigin) {
      el.serverField.classList.add('hidden');
      document.querySelector('.form-row')?.classList.add('single');
    }

    const params = new URLSearchParams(location.search);
    if (params.get('name')) el.nameInput.value = params.get('name').slice(0, 12);
    if (params.get('server')) el.serverInput.value = params.get('server');

    requestAnimationFrame(loop);
    setInterval(sendInput, 50);
    setInterval(pingServer, 5000);
    setInterval(() => {
      if (isTunnelHost() && !el.lobbyScreen.classList.contains('hidden')) {
        refreshTunnelStatus();
      }
    }, 5000);
    updateWanVisibility();

    if (params.get('auto') === '1' && (sameOrigin || el.serverInput.value.trim())) {
      setTimeout(connect, 300);
    }
  }

  if (new URLSearchParams(location.search).get('debug') === '1') {
    window.__arenaDebug = {
      get app() {
        return app;
      },
      get solo() {
        return app.soloState;
      }
    };
  }

  init();
})();
