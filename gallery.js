(() => {
  'use strict';
  const C = window.GUESTBOOK_CONFIG;
  const $ = (s) => document.querySelector(s);
  const KEY = 'guestbook.galleryCode';
  const DAY = 24 * 3600 * 1000;
  let items = [], filter = 'all', code = '';
  document.documentElement.style.setProperty('--accent', C.accent);
  $('#eventName').textContent = C.eventName;

  const tagFor = (c) => (c.startsWith('guestbook-') ? c : 'guestbook-' + c).trim();
  const safe = (s) => String(s || '').normalize('NFKD').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'guest';
  const sizeLabel = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  const fmtDur = (s) => { s = Math.round(+s || 0); return s ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : ''; };
  const leftLabel = (created) => { const ms = created + DAY - Date.now(); if (ms <= 0) return 'Deleting soon'; const h = Math.floor(ms / 3600000); return h >= 1 ? 'Deletes in ' + h + ' h' : 'Deletes in ' + Math.max(1, Math.round(ms / 60000)) + ' min'; };

  async function list(rt, tag) {
    const r = await fetch('https://res.cloudinary.com/' + encodeURIComponent(C.cloudName) + '/' + rt + '/list/' + encodeURIComponent(tag) + '.json?t=' + Date.now(), { cache: 'no-store' });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error('List failed (' + r.status + ')');
    const j = await r.json();
    return (j.resources || []).map((x) => Object.assign(x, { rt }));
  }

  async function load() {
    const tag = tagFor(code);
    const [v, i] = await Promise.all([list('video', tag), list('image', tag)]);
    items = v.concat(i).map((x) => {
      const ctx = (x.context && x.context.custom) || {};
      const kind = ctx.kind || (x.rt === 'image' ? 'photo' : (x.width ? 'video' : 'audio'));
      return {
        id: x.public_id, rt: x.rt, format: x.format, kind, guest: ctx.guest || '', duration: ctx.duration || '', consent: ctx.consent_share === 'yes',
        created: Date.parse(x.created_at), bytes: x.bytes || 0, w: x.width || 0,
        url: 'https://res.cloudinary.com/' + C.cloudName + '/' + x.rt + '/upload/v' + x.version + '/' + x.public_id + '.' + x.format,
      };
    }).filter((x) => x.kind !== 'check' && !x.id.startsWith('device-check-') && !(x.rt === 'image' && x.w <= 1));
    render();
  }

  function fileName(it) {
    const d = new Date(it.created);
    const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + '_' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
    return stamp + '_' + safe(it.guest) + '_' + it.kind + '_' + it.id.slice(0, 5) + '.' + it.format;
  }
  async function fetchBlob(url) { const r = await fetch(url); if (!r.ok) throw new Error('Download failed (' + r.status + ')'); return r.blob(); }
  function save(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }

  function visible() {
    const q = $('#search').value.trim().toLowerCase();
    return items.filter((x) => (filter === 'all' || x.kind === filter) && (!q || x.guest.toLowerCase().includes(q)))
      .sort((a, b) => ($('#sort').value === 'old' ? a.created - b.created : b.created - a.created));
  }

  function render() {
    const n = { video: 0, audio: 0, photo: 0 }; items.forEach((x) => { n[x.kind] = (n[x.kind] || 0) + 1; });
    $('#counts').textContent = items.length + ' message' + (items.length === 1 ? '' : 's') + ' · ' + n.video + ' video' + (n.video === 1 ? '' : 's') + ' · ' + n.audio + ' voice note' + (n.audio === 1 ? '' : 's') + ' · ' + n.photo + ' photo' + (n.photo === 1 ? '' : 's');
    const oldest = items.reduce((m, x) => Math.min(m, x.created), Infinity);
    $('#oldest').textContent = isFinite(oldest) ? 'Oldest: ' + leftLabel(oldest).toLowerCase() : '';
    const fl = [['all', 'All · ' + items.length], ['video', 'Video · ' + n.video], ['audio', 'Audio · ' + n.audio], ['photo', 'Photos · ' + n.photo]];
    $('#filters').innerHTML = fl.map(([k, l]) => '<button type="button" data-f="' + k + '" aria-pressed="' + (k === filter) + '">' + l + '</button>').join('');
    const grid = $('#grid'); grid.innerHTML = '';
    const list = visible();
    $('#empty').hidden = list.length > 0;
    $('#empty').textContent = items.length ? 'No messages match.' : 'No messages yet. If you expected some, check the gallery code — or wait a minute for new uploads to appear.';
    $('#zipBtn').disabled = !list.length;
    list.forEach((it) => {
      const card = document.createElement('article'); card.className = 'gcard';
      const media = document.createElement('div'); media.className = 'media' + (it.kind === 'audio' ? ' audio' : '');
      const chip = document.createElement('span'); chip.className = 'chip'; chip.textContent = leftLabel(it.created); media.appendChild(chip);
      if (it.kind === 'photo') { const img = document.createElement('img'); img.src = it.url; img.alt = 'Photo from ' + (it.guest || 'a guest'); img.loading = 'lazy'; media.appendChild(img); }
      else if (it.kind === 'audio') { const au = document.createElement('audio'); au.controls = true; au.preload = 'none'; au.src = it.url; media.appendChild(au); }
      else { const v = document.createElement('video'); v.controls = true; v.preload = 'metadata'; v.playsInline = true; v.src = it.url + '#t=0.5'; media.appendChild(v); }
      const body = document.createElement('div'); body.className = 'body';
      const when = new Date(it.created).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      body.innerHTML = '<div><div class="name"></div><div class="meta"></div></div><div class="row"><span class="meta"></span></div>';
      body.querySelector('.name').textContent = it.guest || 'Unnamed guest';
      body.querySelector('.meta').textContent = when + ' · ' + (it.kind === 'photo' ? 'Photo' : it.kind === 'audio' ? 'Audio' : 'Video') + (fmtDur(it.duration) ? ' · ' + fmtDur(it.duration) : '') + (it.bytes ? ' · ' + sizeLabel(it.bytes) : '');
      body.querySelector('.row .meta').textContent = it.consent ? 'OK to share publicly' : 'Hosts only';
      const dl = document.createElement('button'); dl.type = 'button'; dl.className = 'btn secondary sm'; dl.textContent = 'Download';
      dl.addEventListener('click', async () => { dl.disabled = true; dl.textContent = 'Downloading…'; try { save(await fetchBlob(it.url), fileName(it)); dl.textContent = 'Download'; } catch (e) { dl.textContent = 'Try again'; } dl.disabled = false; });
      body.querySelector('.row').appendChild(dl);
      card.appendChild(media); card.appendChild(body); grid.appendChild(card);
    });
  }

  $('#filters').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; filter = b.dataset.f; render(); });
  $('#search').addEventListener('input', render);
  $('#sort').addEventListener('change', render);
  $('#refreshBtn').addEventListener('click', () => load().catch(showErr));
  $('#lockBtn').addEventListener('click', () => { sessionStorage.removeItem(KEY); code = ''; items = []; $('#main').hidden = true; $('#gate').hidden = false; $('#code').value = ''; });
  $('#zipBtn').addEventListener('click', async () => {
    const list = visible(); if (!list.length || !window.JSZip) return;
    const msg = $('#zipMsg'); msg.hidden = false; msg.className = 'notice ok'; $('#zipBtn').disabled = true;
    try {
      const zip = new JSZip();
      for (let i = 0; i < list.length; i++) {
        msg.textContent = 'Adding ' + (i + 1) + ' of ' + list.length + '…';
        zip.file(fileName(list[i]), await fetchBlob(list[i].url), { binary: true });
      }
      msg.textContent = 'Creating the zip file…';
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      save(blob, 'guestbook-' + safe(C.eventName) + '-' + new Date().toISOString().slice(0, 10) + '.zip');
      msg.textContent = 'Downloaded ' + list.length + ' message' + (list.length === 1 ? '' : 's') + ' (' + sizeLabel(blob.size) + ').';
    } catch (e) { msg.className = 'notice warn'; msg.textContent = 'Download all stopped: ' + e.message + '. Try again, or download messages one by one.'; }
    $('#zipBtn').disabled = false;
  });
  function showErr(e) { $('#zipMsg').hidden = false; $('#zipMsg').className = 'notice warn'; $('#zipMsg').textContent = 'Could not load messages: ' + e.message; }

  async function open(c) {
    code = c;
    try { await load(); } catch (e) { $('#gateMsg').textContent = 'Could not reach the gallery. Check the internet connection and try again.'; return; }
    sessionStorage.setItem(KEY, c);
    $('#gate').hidden = true; $('#main').hidden = false;
  }
  $('#gateForm').addEventListener('submit', (e) => { e.preventDefault(); $('#gateMsg').textContent = ''; open($('#code').value.trim()); });
  setInterval(() => { if (code && !$('#main').hidden) load().catch(() => {}); }, 60000);
  const savedCode = sessionStorage.getItem(KEY); if (savedCode) open(savedCode);
})();
