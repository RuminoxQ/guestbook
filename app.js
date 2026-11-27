/* Guestbook kiosk app. Plain JavaScript, no build step. */
(() => {
  'use strict';
  const C = window.GUESTBOOK_CONFIG;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const params = new URLSearchParams(location.search);
  const REMOTE = params.get('remote') === '1';
  const STORE_KEY = 'guestbook.settings.v1';

  // ---------- Settings ----------
  const base = Object.assign({}, C.defaults, {
    eventName: C.eventName, names: C.names, eventDate: C.eventDate, accent: C.accent, promptsText: C.prompts.join('\n'),
  });
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch (e) {}
  const S = Object.assign({}, base, REMOTE ? {} : saved);
  if (REMOTE) { S.kiosk = false; }
  const saveSettings = () => { if (REMOTE) return; try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) {} };

  const QUALITY = {
    saver: { long: 854, vbps: 1000000, label: 'Saver', sub: '≈6 MB/min' },
    standard: { long: 1280, vbps: 2500000, label: 'Standard', sub: '≈15 MB/min' },
    high: { long: 1920, vbps: 3500000, label: 'High', sub: '≈26 MB/min' },
  };
  const MAX_VIDEO_BYTES = 99 * 1024 * 1024; // Cloudinary free plan: 100 MB per video
  const MAX_IMAGE_BYTES = 9.5 * 1024 * 1024; // and 10 MB per image

  // ---------- Helpers ----------
  const fmt = (sec) => { const t = Math.max(0, Math.floor(sec)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
  const uid = (n = 20) => { const a = 'abcdefghijkmnpqrstuvwxyz23456789'; const r = crypto.getRandomValues(new Uint8Array(n)); return [...r].map((x) => a[x % a.length]).join(''); };
  const sizeLabel = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  const dateLabel = () => S.eventDate || new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  const todayKey = () => 'guestbook.count.' + new Date().toISOString().slice(0, 10);
  const timers = {};
  const clearTimer = (k) => { if (timers[k]) { clearTimeout(timers[k]); clearInterval(timers[k]); timers[k] = null; } };
  const ctxEsc = (v) => String(v || '').replace(/([|=\\])/g, '\\$1').slice(0, 200);
  const download = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); };
  const qrInto = (el, text) => { try { const q = qrcode(0, 'M'); q.addData(text); q.make(); el.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch (e) { el.textContent = ''; } };

  // ---------- Offline queue (IndexedDB) ----------
  const Q = (() => {
    let dbp;
    const db = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('guestbook', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('queue', { keyPath: 'id' });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const tx = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('queue', mode); const out = fn(t.objectStore('queue')); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error); }); };
    return {
      put: (item) => tx('readwrite', (s) => s.put(item)),
      del: (id) => tx('readwrite', (s) => s.delete(id)),
      all: () => tx('readonly', (s) => s.getAll()).then((x) => x || []),
    };
  })();

  // ---------- Uploader ----------
  const listeners = new Set();
  const emit = (id, status, extra) => listeners.forEach((fn) => fn(id, status, extra));
  const U = {
    busy: false,
    async kick() {
      if (U.busy) return;
      if (!navigator.onLine) { (await Q.all()).forEach((i) => i.status !== 'failed' && emit(i.id, 'waiting')); refreshStaff(); return; }
      U.busy = true;
      try {
        for (;;) {
          const items = (await Q.all()).filter((i) => i.status !== 'failed').sort((a, b) => a.createdAt - b.createdAt);
          if (!items.length) break;
          const it = items[0];
          try {
            await uploadOne(it);
            await Q.del(it.id);
            emit(it.id, 'done');
          } catch (e) {
            if (e.permanent) { it.status = 'failed'; it.error = e.message; await Q.put(it); emit(it.id, 'failed', e.message); }
            else { emit(it.id, 'waiting'); (await Q.all()).forEach((i) => i.id !== it.id && i.status !== 'failed' && emit(i.id, 'waiting')); break; }
          }
        }
      } finally { U.busy = false; refreshStaff(); }
    },
  };
  function uploadOne(it) {
    return new Promise((resolve, reject) => {
      const limit = it.rt === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
      if (it.blob.size > limit) { const e = new Error('File is larger than the upload limit (' + sizeLabel(limit) + ')'); e.permanent = true; return reject(e); }
      const fd = new FormData();
      fd.append('file', it.blob, it.id + '.' + it.ext);
      fd.append('upload_preset', C.uploadPreset);
      fd.append('public_id', it.id);
      fd.append('context', ['guest=' + ctxEsc(it.name), 'kind=' + it.kind, 'duration=' + Math.round(it.duration || 0), 'consent_share=' + (it.consent ? 'yes' : 'no'), 'event=' + ctxEsc(it.event)].join('|'));
      const x = new XMLHttpRequest();
      x.open('POST', 'https://api.cloudinary.com/v1_1/' + encodeURIComponent(C.cloudName) + '/' + it.rt + '/upload');
      x.upload.onprogress = (ev) => { if (ev.lengthComputable) emit(it.id, 'uploading', Math.round((ev.loaded / ev.total) * 100)); };
      x.onload = () => {
        if (x.status >= 200 && x.status < 300) return resolve();
        let msg = 'Upload failed (' + x.status + ')';
        try { msg = JSON.parse(x.responseText).error.message || msg; } catch (e) {}
        const e = new Error(msg);
        e.permanent = x.status >= 400 && x.status < 500 && x.status !== 408 && x.status !== 429 && !/already exists/i.test(msg);
        if (/already exists/i.test(msg)) return resolve(); // uploaded before, response was lost
        reject(e);
      };
      x.onerror = x.ontimeout = () => reject(new Error('No connection'));
      x.timeout = 10 * 60 * 1000;
      emit(it.id, 'uploading', 0);
      x.send(fd);
    });
  }
  window.addEventListener('online', () => { U.kick(); refreshStaff(); });
  window.addEventListener('offline', () => { U.kick(); refreshStaff(); });
  setInterval(() => U.kick(), 30000);

  // ---------- Sounds ----------
  let sfx = null;
  const sfxCtx = () => {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
    try { if (!sfx || sfx.state === 'closed') sfx = new AC(); if (sfx.state === 'suspended') sfx.resume().catch(() => {}); } catch (e) { return null; }
    return sfx;
  };
  const tone = (freq, dur, delay = 0, vol = 0.2, type = 'sine') => {
    const ctx = sfxCtx(); if (!ctx) return;
    const t = ctx.currentTime + delay, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + dur + 0.05);
  };
  const play = (kind, force) => {
    if (!S.sounds && !force) return;
    if (kind === 'tick') tone(880, 0.14, 0, 0.22);
    else if (kind === 'go') { tone(1320, 0.45, 0, 0.26); tone(1980, 0.3, 0, 0.06); }
    else if (kind === 'warn') { tone(660, 0.18, 0, 0.2, 'triangle'); tone(880, 0.26, 0.2, 0.2, 'triangle'); }
    else if (kind === 'final') tone(990, 0.1, 0, 0.16, 'square');
    else if (kind === 'end') { tone(1320, 0.18, 0, 0.22); tone(990, 0.18, 0.18, 0.22); tone(660, 0.4, 0.36, 0.22); }
    else if (kind === 'shutter') { tone(2200, 0.05, 0, 0.18, 'square'); tone(1200, 0.08, 0.05, 0.12, 'square'); }
    else if (kind === 'test') { tone(660, 0.25, 0, 0.25); tone(880, 0.25, 0.3, 0.25); tone(1100, 0.35, 0.6, 0.25); }
  };
  const clips = { openV: $('#clip-openV'), openA: $('#clip-openA'), closeV: $('#clip-closeV'), closeA: $('#clip-closeA') };
  let clipDone = null;
  const stopClips = () => { clearTimer('clip'); Object.values(clips).forEach((c) => { c.onended = c.onerror = null; c.pause(); }); clipDone = null; };
  const playClip = (el, done) => {
    stopClips();
    if (!S.hostMessages || !el) { done && done(); return; }
    let fin = false; const end = () => { if (fin) return; fin = true; el.onended = el.onerror = null; clearTimer('clip'); clipDone = null; done && done(); };
    clipDone = end; el.onended = end; el.onerror = end; timers.clip = setTimeout(end, 20000);
    try { el.currentTime = 0; } catch (e) {}
    const p = el.play(); if (p && p.catch) p.catch(end);
  };

  // ---------- Voice guide ----------
  let voiceOn = !!S.voiceGuide;
  const LINES = {
    welcome: 'Welcome. Tap the big button to record a video message, or choose audio only, or take a photo.',
    setup: 'You can see yourself on the screen. Type your name if you like, then tap Start recording.',
    photo: 'Choose a frame, then tap the round camera button. We will count down from three.',
    intro: 'Here is a message from the hosts. Recording starts right after.',
    countdown: 'Get ready.',
    recording: '',
    review: 'Play it back. If you are happy, tap Save to guestbook.',
    thanks: 'Thank you. Your message is saved. Scan the code with your phone to get your copy.',
  };
  const speak = (text) => {
    if (!voiceOn || !text || !window.speechSynthesis) return;
    try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 0.95; speechSynthesis.speak(u); } catch (e) {}
  };

  // ---------- Media ----------
  const M = { stream: null, camId: '', micId: '', ac: null, an: null, level: 0, heard: false };
  const live = $('#live');
  $$('.meter').forEach((m) => { for (let i = 0; i < 20; i++) m.appendChild(document.createElement('i')); });

  const needVideo = () => state.mode !== 'audio' || (S.kiosk && !REMOTE);
  const needAudio = () => state.mode !== 'photo' || (S.kiosk && !REMOTE);
  const streamOk = () => M.stream && M.stream.getTracks().every((t) => t.readyState === 'live')
    && (!needVideo() || M.stream.getVideoTracks().length || M.noCamera) && (!needAudio() || M.stream.getAudioTracks().length);

  function stopStream() {
    if (M.raf) cancelAnimationFrame(M.raf); M.raf = 0;
    if (M.ac) { M.ac.close().catch(() => {}); M.ac = null; }
    if (M.stream) M.stream.getTracks().forEach((t) => t.stop());
    M.stream = null; live.srcObject = null;
  }

  async function ensureStream(force) {
    if (!force && streamOk()) { attach(); return true; }
    stopStream();
    if (!window.isSecureContext) return fail('insecure');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return fail('unsupported');
    $('#busy').hidden = false; $('#errorLayer').hidden = true;
    const audio = needAudio() ? Object.assign({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }, M.micId ? { deviceId: { exact: M.micId } } : {}) : false;
    const video = needVideo() ? Object.assign({ width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, M.camId ? { deviceId: { exact: M.camId } } : { facingMode: 'user' }) : false;
    M.noCamera = false;
    try {
      let s;
      try { s = await navigator.mediaDevices.getUserMedia({ audio, video }); }
      catch (e) {
        if ((e.name === 'NotFoundError' || e.name === 'OverconstrainedError') && (M.camId || M.micId)) { M.camId = ''; M.micId = ''; return ensureStream(true); }
        if (e.name === 'NotFoundError' && video && audio && state.mode === 'audio') { s = await navigator.mediaDevices.getUserMedia({ audio }); M.noCamera = true; }
        else throw e;
      }
      M.stream = s;
      const vt = s.getVideoTracks()[0], at = s.getAudioTracks()[0];
      if (vt && vt.getSettings) M.camId = vt.getSettings().deviceId || M.camId;
      if (at && at.getSettings) M.micId = at.getSettings().deviceId || M.micId;
      $('#micLabel').textContent = at ? (at.label || 'microphone') : 'no microphone';
      attach(); startMeter(); listDevices();
      $('#busy').hidden = true; refresh();
      return true;
    } catch (e) {
      $('#busy').hidden = true;
      const n = e && e.name;
      return fail(n === 'NotAllowedError' || n === 'SecurityError' ? 'denied' : n === 'NotFoundError' ? 'nodevice' : n === 'NotReadableError' ? 'inuse' : 'other');
    }
  }
  function attach() { if (M.stream && live.srcObject !== M.stream) { live.srcObject = M.stream; live.muted = true; live.play().catch(() => {}); } }

  const ERRS = {
    denied: ['Camera or mic blocked', 'Access was not allowed. Open your browser’s site settings, allow the camera and microphone for this page, then try again.'],
    nodevice: ['No device found', 'No camera or microphone is connected. Plug in a webcam or external mic — it will be picked up automatically.'],
    inuse: ['Device is busy', 'Another app is using the camera or microphone. Close it, then try again.'],
    insecure: ['Secure page needed', 'Recording only works on https:// pages. Open the guestbook from its https:// address.'],
    unsupported: ['Recording not supported', 'This browser cannot record. Use a current version of Chrome, Edge, Safari or Firefox.'],
    other: ['Could not start', 'Something stopped the camera or microphone from starting. Try again or pick another device.'],
  };
  function fail(code) {
    const [t, x] = ERRS[code] || ERRS.other;
    $('#errTitle').textContent = t; $('#errText').textContent = x; $('#errorLayer').hidden = false;
    refresh(); return false;
  }

  function startMeter() {
    if (!M.stream || !M.stream.getAudioTracks().length) return;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    try {
      M.ac = new AC();
      const src = M.ac.createMediaStreamSource(M.stream); const an = M.ac.createAnalyser(); an.fftSize = 1024; src.connect(an);
      const buf = new Uint8Array(an.fftSize); let last = 0, lvl = 0;
      const bars = $$('.meter').map((m) => [...m.children]); const ring = $('#ring');
      const tick = (t) => {
        an.getByteTimeDomainData(buf);
        let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        lvl = Math.max(Math.min(1, Math.sqrt(sum / buf.length) * 4), lvl * 0.86); M.level = lvl;
        if (lvl > 0.22) M.heard = true;
        if (t - last > 70) {
          last = t; const lit = Math.round(lvl * 20);
          bars.forEach((b) => b.forEach((el, i) => { el.style.background = i < lit ? (i >= 16 ? '#D9822B' : 'var(--accent)') : '#EADBD1'; }));
          ring.style.transform = 'scale(' + (1 + lvl * 0.45).toFixed(3) + ')';
          if (!$('#checkLayer').hidden && M.heard) setCheck('mic', 'ok', (M.stream.getAudioTracks()[0].label || 'Microphone') + ' · picking up sound');
        }
        M.raf = requestAnimationFrame(tick);
      };
      M.raf = requestAnimationFrame(tick);
      if (M.ac.state === 'suspended') M.ac.resume().catch(() => {});
    } catch (e) {}
  }

  async function listDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return { cams: [], mics: [] };
    const all = await navigator.mediaDevices.enumerateDevices();
    const cams = all.filter((d) => d.kind === 'videoinput'), mics = all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
    const fill = (sel, list, label, cur) => {
      sel.innerHTML = '';
      if (!list.length) { const o = document.createElement('option'); o.textContent = 'Default ' + label.toLowerCase(); sel.appendChild(o); return; }
      list.forEach((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || label + ' ' + (i + 1); if (d.deviceId === cur) o.selected = true; sel.appendChild(o); });
    };
    fill($('#camSel'), cams, 'Camera', M.camId); fill($('#camSel2'), cams, 'Camera', M.camId); fill($('#micSel'), mics, 'Microphone', M.micId);
    return { cams, mics };
  }
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      const { cams, mics } = await listDevices();
      if (state.screen === 'recording') return;
      const camGone = M.camId && !cams.some((c) => c.deviceId === M.camId), micGone = M.micId && !mics.some((m) => m.deviceId === M.micId);
      if (camGone) M.camId = ''; if (micGone) M.micId = '';
      if (camGone || micGone || (!M.stream && ['setup', 'photo'].includes(state.screen))) ensureStream(true);
    });
  }
  ['#camSel', '#camSel2'].forEach((s) => $(s).addEventListener('change', (e) => { M.camId = e.target.value; ensureStream(true); }));
  $('#micSel').addEventListener('change', (e) => { M.micId = e.target.value; ensureStream(true); });

  // ---------- Screens ----------
  const state = { screen: 'welcome', mode: 'both', frame: S.photoFrame || 'classic', blob: null, url: '', ext: 'webm', duration: 0, lastId: null, promptIdx: 0 };
  const TITLES = {
    welcome: 'Leave us a <em>little</em> love note', setup: 'Ready when <em>you</em> are', photo: 'Strike a <em>pose</em>',
    intro: 'A message from the <em>hosts</em>', countdown: 'Get <em>ready</em>', recording: 'You’re <em>recording</em>',
    review: 'How does it <em>look?</em>', thanks: 'All <em>saved</em>',
  };
  const STEP = { welcome: 0, setup: 0, photo: 0, intro: 1, countdown: 1, recording: 1, review: 2, thanks: 3 };

  function show(screen) {
    state.screen = screen;
    document.body.dataset.screen = screen;
    $('#title').innerHTML = TITLES[screen] || '';
    speak(LINES[screen]);
    refresh();
  }
  function refresh() {
    const sc = state.screen, mode = state.mode;
    $$('[data-show]').forEach((el) => { el.hidden = !el.dataset.show.split(' ').includes(sc); });
    $$('[data-need]').forEach((el) => { const n = el.dataset.need; el.hidden = n === 'video' ? mode === 'audio' : mode === 'photo'; });
    $$('[data-mode-btn]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.modeBtn === mode ? 'true' : 'false'));
    $$('[data-frame]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.frame === state.frame ? 'true' : 'false'));
    $$('#steps li').forEach((li, i) => { li.className = i === STEP[sc] ? 'on' : i < STEP[sc] ? 'done' : ''; if (i < STEP[sc]) li.firstChild.textContent = '✓'; else li.firstChild.textContent = String(i + 1); if (i === STEP[sc]) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); });
    const liveScreen = ['setup', 'photo', 'intro', 'countdown', 'recording'].includes(sc);
    const hasVideo = !!(M.stream && M.stream.getVideoTracks().length);
    live.hidden = !(liveScreen && mode !== 'audio' && hasVideo);
    $('#audioViz').hidden = !(liveScreen && mode === 'audio' && M.stream);
    $('#playVideo').hidden = !(sc === 'review' && mode === 'both');
    $('#playAudioWrap').hidden = !(sc === 'review' && mode === 'audio');
    $('#playPhoto').hidden = !(sc === 'review' && mode === 'photo');
    $('#photoFrame').hidden = !(mode === 'photo' && liveScreen && state.frame !== 'none');
    $('#photoFrame').className = 'photo-frame' + (state.frame === 'floral' ? ' floral' : '');
    $('#brandPreview').hidden = !(S.overlay && liveScreen && mode !== 'audio' && hasVideo);
    $('#introPill').hidden = sc !== 'intro';
    $('#recPill').hidden = sc !== 'recording';
    $('#countdown').hidden = sc !== 'countdown';
    if (sc !== 'recording') { $('#warnBanner').hidden = true; $('#finalNum').hidden = true; }
    if (!liveScreen) $('#errorLayer').hidden = true;
    $('#promptCard').hidden = !S.prompts || !prompts().length;
    $('#startBtn').disabled = !M.stream; $('#shutterBtn').disabled = !hasVideo;
    const nm = (state.name || '').trim();
    $('#caption').textContent = nm ? 'From ' + nm : mode === 'photo' ? 'Photo for the hosts' : 'A note for the hosts';
    const max = S.maxSeconds;
    $('#limitHint').textContent = 'Up to ' + (max >= 60 ? (Math.round(max / 6) / 10) + ' min' : max + ' s') + (S.remindAt > 0 && S.remindAt < max ? ' · reminder at ' + S.remindAt + ' s left' : '');
  }

  function applyBranding() {
    document.documentElement.style.setProperty('--accent', S.accent);
    $$('[data-bind="eventName"]').forEach((el) => { el.textContent = S.eventName; });
    $$('[data-bind="names"]').forEach((el) => { el.textContent = S.names; });
    $$('[data-bind="date"]').forEach((el) => { el.textContent = dateLabel(); });
    document.title = S.eventName + ' · Guestbook';
    document.body.classList.toggle('kiosk', !!S.kiosk && !REMOTE);
  }

  async function choose(mode) {
    sfxCtx();
    state.mode = mode;
    show(mode === 'photo' ? 'photo' : 'setup');
    await ensureStream();
    refresh();
  }
  $('#chooseBoth').addEventListener('click', () => choose('both'));
  $('#chooseAudio').addEventListener('click', () => choose('audio'));
  $('#choosePhoto').addEventListener('click', () => choose('photo'));
  $$('[data-mode-btn]').forEach((b) => b.addEventListener('click', () => choose(b.dataset.modeBtn)));
  $$('[data-frame]').forEach((b) => b.addEventListener('click', () => { state.frame = b.dataset.frame; refresh(); }));
  ['#guestName', '#guestName2'].forEach((s) => $(s).addEventListener('input', (e) => { state.name = e.target.value; $('#guestName').value = $('#guestName2').value = e.target.value; refresh(); }));
  $('#retryBtn').addEventListener('click', () => { M.camId = ''; M.micId = ''; ensureStream(true); });
  $$('[data-act="reset"]').forEach((b) => b.addEventListener('click', () => reset()));
  $$('[data-act="cancel"]').forEach((b) => b.addEventListener('click', () => { clearTimer('cd'); stopClips(); show(state.mode === 'photo' ? 'photo' : 'setup'); }));

  // ---------- Prompts ----------
  const prompts = () => String(S.promptsText || '').split('\n').map((s) => s.trim()).filter(Boolean);
  function renderPrompt() {
    const list = prompts(); if (!list.length) return;
    state.promptIdx = ((state.promptIdx % list.length) + list.length) % list.length;
    $('#promptText').textContent = list[state.promptIdx];
    const n = Math.min(list.length, 6), on = state.promptIdx % n;
    $('#promptDots').innerHTML = Array.from({ length: n }, (_, i) => '<i' + (i === on ? ' class="on"' : '') + '></i>').join('');
  }
  $('#nextPrompt').addEventListener('click', () => { state.promptIdx++; renderPrompt(); });

  // ---------- Countdown & host message ----------
  function countdown(text, then) {
    show('countdown');
    $('#countdownText').textContent = text;
    let n = 3; $('#countdown').textContent = n; play('tick');
    clearTimer('cd');
    timers.cd = setInterval(() => {
      n -= 1;
      if (n <= 0) { clearTimer('cd'); play(state.mode === 'photo' ? 'shutter' : 'go'); then(); }
      else { $('#countdown').textContent = n; play('tick'); }
    }, 1000);
  }
  $('#startBtn').addEventListener('click', () => {
    sfxCtx();
    if (!M.stream) return;
    if (S.hostMessages) {
      show('intro');
      playClip(state.mode === 'audio' ? clips.openA : clips.openV, () => { if (state.screen === 'intro') countdown('Get ready… look at the camera and smile.', record); });
    } else countdown('Get ready… look at the camera and smile.', record);
  });
  $('#skipIntro').addEventListener('click', () => { stopClips(); countdown('Get ready… look at the camera and smile.', record); });

  // ---------- Recording ----------
  function pickType(mode) {
    if (!window.MediaRecorder) return null;
    const list = mode === 'audio' ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
      : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'];
    for (const t of list) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
    return '';
  }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function drawBrand(ctx, w, h, centred) {
    if (!S.overlay) return;
    const u = Math.min(w, h) / 100;
    const nameFont = 'italic 600 ' + (u * 5.2).toFixed(1) + 'px "Cormorant Garamond", Georgia, serif';
    const dateFont = '500 ' + (u * 2.6).toFixed(1) + 'px "DM Sans", system-ui, sans-serif';
    ctx.save();
    ctx.font = nameFont; const nw = ctx.measureText(S.names).width;
    ctx.font = dateFont; const dl = dateLabel(); const dw = ctx.measureText(dl).width;
    const heart = u * 3, pad = u * 2.2, gap = u * 1.4;
    const bw = pad + heart + gap + nw + gap + dw + pad, bh = u * 8.4;
    const x = centred ? (w - bw) / 2 : u * 3, y = h - bh - (centred ? u * 5 : u * 3);
    roundRect(ctx, x, y, bw, bh, u * 1.6);
    ctx.fillStyle = centred ? 'rgba(251,246,240,0.94)' : 'rgba(43,34,32,0.55)'; ctx.fill();
    ctx.textBaseline = 'middle';
    ctx.fillStyle = centred ? S.accent : '#E9B872'; ctx.font = (heart * 1.25).toFixed(1) + 'px sans-serif'; ctx.fillText('♥', x + pad, y + bh / 2);
    ctx.fillStyle = centred ? '#2B2220' : '#FBF6F0'; ctx.font = nameFont; ctx.fillText(S.names, x + pad + heart + gap, y + bh / 2);
    ctx.fillStyle = centred ? '#6E5A54' : 'rgba(251,246,240,0.9)'; ctx.font = dateFont; ctx.fillText(dl, x + pad + heart + gap + nw + gap, y + bh / 2 + u * 0.3);
    ctx.restore();
  }
  function startCompositor() {
    const q = QUALITY[S.quality] || QUALITY.standard;
    const vw = live.videoWidth || 1280, vh = live.videoHeight || 720;
    const sc = Math.min(1, q.long / Math.max(vw, vh));
    const w = Math.round((vw * sc) / 2) * 2, h = Math.round((vh * sc) / 2) * 2;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    let on = true;
    const draw = () => { if (!on) return; try { ctx.drawImage(live, 0, 0, w, h); drawBrand(ctx, w, h, false); } catch (e) {} };
    const rafLoop = () => { draw(); if (on) M.compRaf = requestAnimationFrame(rafLoop); };
    M.compRaf = requestAnimationFrame(rafLoop);
    M.compInt = setInterval(() => { if (document.hidden) draw(); }, 66); // keeps frames coming if the page is briefly hidden
    const stream = cv.captureStream ? cv.captureStream(30) : null;
    M.compStop = () => { on = false; cancelAnimationFrame(M.compRaf); clearInterval(M.compInt); if (stream) stream.getTracks().forEach((t) => t.stop()); };
    return stream;
  }

  function record() {
    const mode = state.mode;
    const type = pickType(mode);
    if (type === null) { show('setup'); fail('unsupported'); return; }
    let rs;
    if (mode === 'both') {
      const cs = startCompositor();
      const vtracks = cs ? cs.getVideoTracks() : M.stream.getVideoTracks();
      rs = new MediaStream([...vtracks, ...M.stream.getAudioTracks()]);
    } else rs = new MediaStream(M.stream.getAudioTracks());
    const q = QUALITY[S.quality] || QUALITY.standard;
    let rec;
    try { rec = new MediaRecorder(rs, Object.assign({ audioBitsPerSecond: 128000 }, mode === 'both' ? { videoBitsPerSecond: q.vbps } : {}, type ? { mimeType: type } : {})); }
    catch (e) { if (M.compStop) M.compStop(); show('setup'); fail('unsupported'); return; }
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      if (M.compStop) { M.compStop(); M.compStop = null; }
      const mt = rec.mimeType || type || (mode === 'audio' ? 'audio/webm' : 'video/webm');
      state.blob = new Blob(chunks, { type: mt });
      state.ext = mt.includes('mp4') ? (mode === 'audio' ? 'm4a' : 'mp4') : mt.includes('ogg') ? 'ogg' : 'webm';
      state.duration = (Date.now() - state.t0) / 1000;
      toReview();
    };
    M.rec = rec;
    rec.start(1000);
    state.t0 = Date.now(); state.warned = false; state.lastFinal = 0;
    state.promptIdx = Math.floor(Math.random() * Math.max(1, prompts().length)); renderPrompt();
    show('recording');
    const max = S.maxSeconds;
    const ui = () => {
      const el = (Date.now() - state.t0) / 1000, left = Math.max(0, max - el), sec = Math.ceil(left);
      const warn = S.remindAt > 0 && S.remindAt < max && left <= S.remindAt;
      $('#timer').textContent = fmt(el); $('#recPillText').textContent = 'REC ' + fmt(el);
      $('#remaining').textContent = fmt(left) + ' left';
      $('#timer').classList.toggle('warn', warn); $('#remaining').classList.toggle('warn', warn); $('#progress').classList.toggle('warn', warn);
      $('#progress > div').style.width = Math.min(100, (el / max) * 100).toFixed(1) + '%';
      $('#warnBanner').hidden = !warn; $('#warnText').textContent = sec === 1 ? '1 second left' : sec + ' seconds left · time to wrap up';
      if (warn && !state.warned) { state.warned = true; if (S.remindAt > 3) play('warn'); }
      const fin = left > 0 && sec <= 3; $('#finalNum').hidden = !fin; $('#finalNum').textContent = sec;
      if (fin && sec !== state.lastFinal) { state.lastFinal = sec; play('final'); }
      if (el >= max) stopRec();
    };
    ui(); clearTimer('rec'); timers.rec = setInterval(ui, 200);
  }
  function stopRec() { clearTimer('rec'); if (M.rec && M.rec.state !== 'inactive') { M.rec.stop(); play('end'); } }
  $('#stopBtn').addEventListener('click', stopRec);

  // ---------- Photo ----------
  $('#shutterBtn').addEventListener('click', () => { sfxCtx(); countdown('Smile!', capturePhoto); });
  function capturePhoto() {
    const vw = live.videoWidth, vh = live.videoHeight;
    if (!vw) { show('photo'); return; }
    const cv = document.createElement('canvas'); cv.width = vw; cv.height = vh;
    const ctx = cv.getContext('2d'); ctx.drawImage(live, 0, 0, vw, vh);
    const u = Math.min(vw, vh) / 100;
    if (state.frame !== 'none') {
      ctx.save(); ctx.lineWidth = u * 0.5;
      ctx.strokeStyle = state.frame === 'floral' ? 'rgba(233,184,114,0.95)' : 'rgba(251,246,240,0.92)';
      if (state.frame === 'floral') ctx.setLineDash([u * 2.2, u * 1.4]);
      roundRect(ctx, u * 3, u * 3, vw - u * 6, vh - u * 6, u * 1.2); ctx.stroke(); ctx.restore();
      if (state.frame === 'floral') { ctx.save(); ctx.fillStyle = '#E9B872'; ctx.font = (u * 6).toFixed(1) + 'px sans-serif'; ctx.textBaseline = 'top'; ctx.fillText('♥', u * 5, u * 4.5); ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText('♥', vw - u * 5, vh - u * 4.5); ctx.restore(); }
    }
    drawBrand(ctx, vw, vh, state.frame !== 'none');
    const fl = $('#flash'); fl.classList.add('on'); setTimeout(() => fl.classList.remove('on'), 60);
    cv.toBlob((b) => { state.blob = b; state.ext = 'jpg'; state.duration = 0; toReview(); }, 'image/jpeg', 0.9);
  }

  // ---------- Review ----------
  function toReview() {
    if (state.url) URL.revokeObjectURL(state.url);
    state.url = URL.createObjectURL(state.blob);
    if (state.mode === 'both') $('#playVideo').src = state.url;
    else if (state.mode === 'audio') $('#playAudio').src = state.url;
    else $('#playPhoto').src = state.url;
    $('#reviewText').textContent = state.mode === 'photo' ? 'Love it? Add it to the guestbook.' : 'Play it back. Happy with it? Add it to the guestbook.';
    $('#againLabel').textContent = state.mode === 'photo' ? 'Retake photo' : 'Record again';
    $('#reviewMeta').textContent = (state.mode === 'photo' ? 'Photo' : fmt(state.duration)) + ' · ' + sizeLabel(state.blob.size) + ' · .' + state.ext;
    show('review');
  }
  $('#againBtn').addEventListener('click', async () => { $('#playVideo').pause(); $('#playAudio').pause(); show(state.mode === 'photo' ? 'photo' : 'setup'); await ensureStream(); refresh(); });

  // ---------- Save & thanks ----------
  $('#saveBtn').addEventListener('click', async () => {
    $('#playVideo').pause(); $('#playAudio').pause();
    const kind = state.mode === 'both' ? 'video' : state.mode;
    const item = { id: uid(20), blob: state.blob, kind, rt: kind === 'photo' ? 'image' : 'video', ext: state.ext, name: (state.name || '').trim(), consent: $('#consentShare').checked, duration: state.duration, createdAt: Date.now(), event: S.eventName };
    try { await Q.put(item); } catch (e) { download(item.blob, 'guestbook-' + item.id + '.' + item.ext); }
    try { localStorage.setItem(todayKey(), String((+localStorage.getItem(todayKey()) || 0) + 1)); } catch (e) {}
    state.lastId = item.id;
    const link = new URL('copy.html', location.href);
    link.search = new URLSearchParams({ i: item.id, r: item.rt, f: item.ext, k: kind, n: item.name }).toString();
    qrInto($('#copyQr'), link.toString());
    $('#thanksTitle').textContent = item.name ? 'Thank you, ' + item.name + '!' : 'Thank you!';
    setUpload(navigator.onLine ? 'uploading' : 'waiting', 0);
    if (!S.kiosk || REMOTE) stopStream();
    show('thanks');
    U.kick();
    let closingDone = !S.hostMessages;
    playClip(kind === 'audio' ? clips.closeA : clips.closeV, () => { closingDone = true; });
    let left = S.thanksSeconds;
    const tick = () => {
      $('#backIn').textContent = 'Back to the start in ' + left + ' second' + (left === 1 ? '' : 's');
      if (left <= 0 && closingDone) reset(); else left = Math.max(0, left - 1);
    };
    tick(); clearTimer('home'); timers.home = setInterval(tick, 1000);
  });
  function setUpload(status, extra) {
    const card = $('#uploadCard'), use = $('#uploadIcon use');
    card.className = 'status-card';
    if (status === 'done') { card.classList.add('ok'); use.setAttribute('href', '#i-cloud'); $('#uploadTitle').textContent = 'Uploaded to the hosts'; $('#uploadText').textContent = 'Your message is in the guestbook.'; }
    else if (status === 'waiting') { card.classList.add('warn'); use.setAttribute('href', '#i-wifioff'); $('#uploadTitle').textContent = 'Saved safely on this device'; $('#uploadText').textContent = 'No Wi-Fi right now. It uploads to the hosts automatically when the connection is back — your QR code will work then.'; }
    else if (status === 'failed') { card.classList.add('warn'); use.setAttribute('href', '#i-alert'); $('#uploadTitle').textContent = 'Saved on this device'; $('#uploadText').textContent = 'It couldn’t be uploaded (' + (extra || 'error') + '). Staff can still save it from the staff panel.'; }
    else { use.setAttribute('href', '#i-up'); $('#uploadTitle').textContent = 'Uploading to the hosts… ' + (extra || 0) + '%'; $('#uploadText').textContent = 'You can scan the code already — it opens once the upload finishes.'; }
  }
  listeners.add((id, status, extra) => { if (id === state.lastId && state.screen === 'thanks') setUpload(status, extra); });

  function reset() {
    ['cd', 'rec', 'home'].forEach(clearTimer); stopClips();
    if (M.rec && M.rec.state !== 'inactive') { M.rec.onstop = null; M.rec.stop(); }
    if (M.compStop) { M.compStop(); M.compStop = null; }
    $('#playVideo').pause(); $('#playAudio').pause(); $('#playVideo').removeAttribute('src'); $('#playAudio').removeAttribute('src');
    if (state.url) { URL.revokeObjectURL(state.url); state.url = ''; }
    state.blob = null; state.name = ''; state.mode = 'both'; state.frame = S.photoFrame || 'classic';
    $('#guestName').value = $('#guestName2').value = ''; $('#consentShare').checked = false;
    if (!S.kiosk || REMOTE) stopStream();
    show('welcome');
  }

  // ---------- Accessibility ----------
  $('#bigBtn').addEventListener('click', () => { const on = !document.body.classList.contains('big'); document.body.classList.toggle('big', on); $('#bigBtn').setAttribute('aria-pressed', String(on)); });
  $('#voiceBtn').addEventListener('click', () => { voiceOn = !voiceOn; $('#voiceBtn').setAttribute('aria-pressed', String(voiceOn)); if (voiceOn) speak(LINES[state.screen]); else if (window.speechSynthesis) speechSynthesis.cancel(); });

  // ---------- Kiosk behaviour ----------
  let lastTap = Date.now();
  const onTap = () => { lastTap = Date.now(); };
  const goFull = () => {
    if (S.kiosk && !REMOTE && !document.fullscreenElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    wake();
  };
  document.addEventListener('pointerdown', onTap, true); document.addEventListener('keydown', onTap, true);
  document.addEventListener('click', goFull, true);
  setInterval(() => {
    if (!S.kiosk || REMOTE) return;
    if (['setup', 'photo', 'review', 'intro'].includes(state.screen) && $('#staffLayer').hidden && Date.now() - lastTap > S.idleSeconds * 1000) reset();
  }, 5000);
  window.addEventListener('beforeunload', (e) => { if (S.kiosk && !REMOTE) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('contextmenu', (e) => { if (S.kiosk && !REMOTE) e.preventDefault(); });
  let lock = null;
  async function wake() { if (!S.kiosk || REMOTE || !navigator.wakeLock || lock) return; try { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } catch (e) {} }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });

  // ---------- Staff unlock ----------
  let pin = '';
  const corner = $('#staffCorner');
  if (REMOTE) corner.remove();
  else {
    const cancel = () => clearTimer('corner');
    corner.addEventListener('pointerdown', () => { clearTimer('corner'); timers.corner = setTimeout(openPin, 3000); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => corner.addEventListener(ev, cancel));
  }
  function openPin() { if (state.screen === 'recording') return; pin = ''; drawPin(); $('#pinLayer').hidden = false; }
  function drawPin() { $$('#pinDots i').forEach((d, i) => d.classList.toggle('on', i < pin.length)); }
  $('#keypad').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.key === 'cancel') { $('#pinLayer').hidden = true; return; }
    if (b.dataset.key === 'del') { pin = pin.slice(0, -1); drawPin(); return; }
    if (pin.length < 4) pin += b.textContent.trim();
    drawPin();
    if (pin.length === 4) {
      if (pin === String(S.pin)) { $('#pinLayer').hidden = true; openStaff(); }
      else { const d = $('#pinDots'); d.classList.add('shake'); setTimeout(() => { d.classList.remove('shake'); pin = ''; drawPin(); }, 350); }
    }
  });

  // ---------- Staff panel ----------
  const SEGS = {
    maxSeconds: [[30, '30 s'], [60, '1 min'], [90, '1.5 min'], [120, '2 min'], [180, '3 min']],
    remindAt: [[0, 'Off'], [5, '5 s'], [10, '10 s'], [15, '15 s'], [30, '30 s']],
    quality: Object.entries(QUALITY).map(([k, q]) => [k, q.label + '<small style="display:block;font-weight:500;font-size:11px">' + q.sub + '</small>']),
    idleSeconds: [[45, '45 s'], [90, '1.5 min'], [180, '3 min']],
    thanksSeconds: [[15, '15 s'], [25, '25 s'], [40, '40 s']],
  };
  const SWATCHES = [['rose', '#A8473C'], ['sage', '#5E7A5F'], ['navy', '#3E5A7A'], ['plum', '#7A4A6B']];
  function buildStaff() {
    $$('[data-seg]').forEach((el) => {
      const k = el.dataset.seg;
      el.setAttribute('role', 'group');
      el.innerHTML = SEGS[k].map(([v, l]) => '<button type="button" data-v="' + v + '">' + l + '</button>').join('');
      el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; const v = b.dataset.v; S[k] = isNaN(+v) ? v : +v; saveSettings(); renderStaff(); refresh(); });
    });
    $('#swatches').innerHTML = SWATCHES.map(([n, c]) => '<button type="button" aria-label="' + n + '" data-c="' + c + '" style="background:' + c + '"></button>').join('');
    $('#swatches').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.accent = b.dataset.c; saveSettings(); applyBranding(); renderStaff(); });
    $$('[data-set]').forEach((el) => el.addEventListener('input', () => { S[el.dataset.set] = el.value; saveSettings(); applyBranding(); refresh(); }));
    $$('[data-toggle]').forEach((el) => el.addEventListener('click', () => { const k = el.dataset.toggle; S[k] = !S[k]; if (k === 'voiceGuide') { voiceOn = S[k]; $('#voiceBtn').setAttribute('aria-pressed', String(voiceOn)); } saveSettings(); applyBranding(); renderStaff(); refresh(); }));
    $('#savePin').addEventListener('click', () => { const v = $('#newPin').value; if (!/^\d{4}$/.test(v)) { $('#pinMsg').textContent = 'The PIN must be exactly 4 digits.'; return; } S.pin = v; saveSettings(); $('#newPin').value = ''; $('#pinMsg').textContent = 'PIN changed on this device.'; });
    $('#uploadNow').addEventListener('click', async () => { (await Q.all()).forEach((i) => { if (i.status === 'failed') { i.status = ''; Q.put(i); } }); setTimeout(() => U.kick(), 100); });
    $('#closeStaff').addEventListener('click', () => { $('#staffLayer').hidden = true; });
    $('#openCheck').addEventListener('click', openCheck);
  }
  function openStaff() { $('#staffLayer').hidden = false; renderStaff(); }
  async function renderStaff() {
    if ($('#staffLayer').hidden) return;
    $$('[data-seg]').forEach((el) => $$('button', el).forEach((b) => b.setAttribute('aria-pressed', String(String(S[el.dataset.seg]) === b.dataset.v))));
    $$('#swatches button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.c.toLowerCase() === String(S.accent).toLowerCase())));
    $$('[data-set]').forEach((el) => { if (document.activeElement !== el) el.value = S[el.dataset.set] || ''; });
    $$('[data-toggle]').forEach((el) => el.setAttribute('aria-pressed', String(!!S[el.dataset.toggle])));
    $('#statToday').textContent = localStorage.getItem(todayKey()) || '0';
    const items = (await Q.all()).sort((a, b) => a.createdAt - b.createdAt);
    const failed = items.filter((i) => i.status === 'failed').length;
    $('#statQueue').textContent = String(items.length);
    $('#statQueueLabel').textContent = failed ? 'waiting · ' + failed + ' could not upload' : 'waiting to upload';
    $('#statQueueBox').classList.toggle('warn', items.length > 0);
    $('#statNet').textContent = navigator.onLine ? 'Online' : 'Offline';
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate(); const free = Math.max(0, (est.quota || 0) - (est.usage || 0));
      const q = QUALITY[S.quality] || QUALITY.standard; const minutes = free / ((q.vbps + 128000) / 8 * 60);
      $('#statStore').textContent = sizeLabel(free);
      $('#statStoreLabel').textContent = 'free · about ' + (minutes > 120 ? Math.round(minutes / 60) + ' h' : Math.round(minutes) + ' min') + ' of video';
      const low = free < 1024 * 1048576; $('#lowStorage').hidden = !low; $('#statStoreBox').classList.toggle('warn', low);
    }
    const ul = $('#queueList'); ul.innerHTML = '';
    if (!items.length) { ul.innerHTML = '<li><div>Nothing waiting — everything is uploaded.</div></li>'; return; }
    items.forEach((i) => {
      const li = document.createElement('li');
      const when = new Date(i.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      li.innerHTML = '<div><b></b><small></small></div>';
      li.querySelector('b').textContent = (i.name || 'Unnamed guest') + ' · ' + i.kind;
      li.querySelector('small').textContent = when + ' · ' + sizeLabel(i.blob.size) + ' · ' + (i.status === 'failed' ? 'could not upload: ' + i.error : navigator.onLine ? 'uploading soon' : 'waiting for Wi-Fi');
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn secondary sm'; b.textContent = 'Save file';
      b.addEventListener('click', () => download(i.blob, 'guestbook-' + (i.name || 'guest').replace(/[^\w-]+/g, '-') + '-' + i.id.slice(0, 6) + '.' + i.ext));
      li.appendChild(b); ul.appendChild(li);
    });
  }
  function refreshStaff() { renderStaff(); }

  // ---------- Device check ----------
  function setCheck(k, st, text) { const li = $('#ck-' + k); if (!li) return; li.className = st || ''; li.querySelector('.ic').textContent = st === 'ok' ? '✓' : st === 'warn' ? '!' : '·'; li.querySelector('small').textContent = text; summary(); }
  function summary() {
    const lis = $$('.checks li'); const ok = lis.filter((l) => l.className === 'ok').length, warn = lis.filter((l) => l.className === 'warn').length, todo = lis.length - ok - warn;
    const s = $('#checkSummary'); s.className = 'notice ' + (warn ? 'warn' : 'ok');
    s.textContent = (warn ? warn + ' warning' + (warn > 1 ? 's' : '') : 'Ready to record') + (todo ? ' · ' + todo + ' to check' : '') + (warn ? '' : ' ✓');
  }
  async function openCheck() { $('#checkLayer').hidden = false; await runCheck(); }
  async function runCheck() {
    ['camera', 'mic', 'speaker', 'storage', 'net', 'upload', 'rec'].forEach((k) => setCheck(k, '', k === 'speaker' ? 'Play the test sound and check you can hear it' : k === 'upload' ? 'Sends a tiny test image (deleted after 24 hours)' : 'Checking…'));
    const t = pickType('both'), ta = pickType('audio');
    setCheck('rec', t || ta ? 'ok' : 'warn', t ? 'This browser can record video (' + t.split(';')[0] + ')' : 'This browser cannot record video. Use current Chrome, Edge, Safari or Firefox.');
    const prev = state.mode; state.mode = 'both'; M.heard = false;
    const ok = await ensureStream(true); state.mode = prev;
    if (ok && M.stream) {
      const vt = M.stream.getVideoTracks()[0], at = M.stream.getAudioTracks()[0];
      if (vt) { const s = vt.getSettings ? vt.getSettings() : {}; setCheck('camera', 'ok', (vt.label || 'Camera') + (s.width ? ' · ' + s.width + '×' + s.height + (s.frameRate ? ' · ' + Math.round(s.frameRate) + ' fps' : '') : '')); }
      else setCheck('camera', 'warn', 'No camera found');
      setCheck('mic', at ? '' : 'warn', at ? (at.label || 'Microphone') + ' · say something to test' : 'No microphone found');
    } else { setCheck('camera', 'warn', $('#errText').textContent || 'Could not start the camera'); setCheck('mic', 'warn', 'Could not start the microphone'); }
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate(); const free = Math.max(0, (est.quota || 0) - (est.usage || 0));
      const q = QUALITY[S.quality] || QUALITY.standard; const hours = free / ((q.vbps + 128000) / 8 * 3600);
      setCheck('storage', free < 1024 * 1048576 ? 'warn' : 'ok', sizeLabel(free) + ' free · about ' + (hours >= 1 ? Math.round(hours) + ' hours' : Math.round(hours * 60) + ' minutes') + ' at ' + q.label + ' quality');
      if (navigator.storage.persist) navigator.storage.persist().catch(() => {});
    } else setCheck('storage', 'ok', 'Storage check not available in this browser');
    try {
      if (!navigator.onLine) throw new Error('offline');
      await fetch('https://res.cloudinary.com/' + encodeURIComponent(C.cloudName) + '/image/list/connection-check.json?t=' + Date.now(), { cache: 'no-store' });
      setCheck('net', 'ok', 'Online · can reach the upload service');
    } catch (e) { setCheck('net', 'warn', 'Offline · messages will be kept on this device and uploaded later'); }
  }
  $('#runCheck').addEventListener('click', runCheck);
  $('#closeCheck').addEventListener('click', () => { $('#checkLayer').hidden = true; refresh(); renderStaff(); });
  $('#playTest').addEventListener('click', () => { play('test', true); setCheck('speaker', '', 'Did you hear three rising notes? Tap “I heard it”.'); });
  $('#heardYes').addEventListener('click', () => setCheck('speaker', 'ok', 'Speaker works'));
  $('#testUpload').addEventListener('click', async () => {
    setCheck('upload', '', 'Uploading a tiny test image…');
    try {
      const fd = new FormData();
      fd.append('file', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=');
      fd.append('upload_preset', C.uploadPreset); fd.append('public_id', 'device-check-' + uid(8)); fd.append('context', 'kind=check');
      const r = await fetch('https://api.cloudinary.com/v1_1/' + encodeURIComponent(C.cloudName) + '/image/upload', { method: 'POST', body: fd });
      const j = await r.json();
      if (r.ok) setCheck('upload', 'ok', 'Upload works · test image saved (deleted after 24 hours)');
      else setCheck('upload', 'warn', 'Upload refused: ' + ((j.error && j.error.message) || r.status));
    } catch (e) { setCheck('upload', 'warn', 'Could not reach the upload service · check the internet'); }
  });

  // ---------- Start ----------
  function init() {
    applyBranding(); buildStaff();
    if (voiceOn) $('#voiceBtn').setAttribute('aria-pressed', 'true');
    if (REMOTE) $('#remoteQrCard').hidden = true;
    else { const u = new URL(location.href); u.search = '?remote=1'; u.hash = ''; qrInto($('#remoteQr'), u.toString()); }
    show('welcome');
    U.kick();
    // Kiosk: warm up the camera straight away if access was already allowed on this device.
    if (S.kiosk && !REMOTE && navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'camera' }).then((p) => { if (p.state === 'granted') ensureStream(); }).catch(() => {});
    }
  }
  init();
})();
