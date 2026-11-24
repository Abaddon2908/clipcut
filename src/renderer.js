'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ===================== state =====================
const DEFAULT_EDIT = () => ({
  segments: [], crop: null, aspect: 'free', rot: 0, rotTurns: 0, flipH: false, flipV: false,
  speed: 1, volume: 100, mute: false, bright: 0, contrast: 0, sat: 0, fadeIn: 0, fadeOut: 0,
});
const S = {
  file: null, name: '', info: null, duration: 0, vw: 0, vh: 0, previewUrl: '',
  edit: DEFAULT_EDIT(), sel: 0,
  exp: { fmt: 'mp4', res: 0, fps: 0, interp: false, quality: 1, hw: 'auto' },
  hw: null, zoom: 1, cropEdit: false, lastOut: null, exporting: false,
};
try { Object.assign(S.exp, JSON.parse(localStorage.getItem('clipcut.exp') || '{}')); } catch (_) {}
const saveExp = () => { try { localStorage.setItem('clipcut.exp', JSON.stringify(S.exp)); } catch (_) {} };

const video = $('#video');
const thumbVideo = document.createElement('video');
thumbVideo.muted = true; thumbVideo.preload = 'auto';

// ===================== helpers =====================
function fmtTime(t, cs = true) {
  t = Math.max(0, t || 0);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const c = Math.floor((t * 100) % 100);
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  const base = h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  return cs ? `${base}.${String(c).padStart(2, '0')}` : base;
}
function fmtShort(t) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtSize(b) {
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} КБ`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(b < 100 * 1024 * 1024 ? 1 : 0)} МБ`;
  return `${(b / 1024 ** 3).toFixed(2)} ГБ`;
}
let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function busy(on, text, p) {
  $('#busy').classList.toggle('hidden', !on);
  if (text) $('#busyText').textContent = text;
  $('#busyBar').parentElement.style.display = p == null ? 'none' : '';
  if (p != null) $('#busyBar').style.width = `${Math.round(p * 100)}%`;
}
const fps = () => (S.info && S.info.fps > 1 && S.info.fps < 241 ? S.info.fps : 30);

// ===================== history =====================
let hist = [], hIdx = -1;
function snap() { return JSON.stringify(S.edit); }
function commit() {
  const s = snap();
  if (hist[hIdx] === s) return;
  hist = hist.slice(0, hIdx + 1); hist.push(s); hIdx = hist.length - 1;
  if (hist.length > 200) { hist.shift(); hIdx--; }
  updUndo();
}
function restore(s) { S.edit = JSON.parse(s); S.sel = clamp(S.sel, 0, S.edit.segments.length - 1); applyAll(); }
function undo() { if (hIdx > 0) { hIdx--; restore(hist[hIdx]); updUndo(); toast('Отменено'); } }
function redo() { if (hIdx < hist.length - 1) { hIdx++; restore(hist[hIdx]); updUndo(); toast('Повторено'); } }
function updUndo() { $('#btnUndo').disabled = hIdx <= 0; $('#btnRedo').disabled = hIdx >= hist.length - 1; }

// ===================== loading =====================
const PLAYABLE_V = ['h264', 'hevc', 'vp8', 'vp9', 'av1', 'theora'];
const PLAYABLE_A = ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_f32le', 'pcm_u8', 'pcm_s24le', 'alac'];

function waitMeta(el, timeout = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (ok) => { if (done) return; done = true; el.removeEventListener('loadeddata', onOk); el.removeEventListener('error', onErr); clearTimeout(t); resolve(ok); };
    const onOk = () => fin(el.videoWidth > 0);
    const onErr = () => fin(false);
    el.addEventListener('loadeddata', onOk); el.addEventListener('error', onErr);
    const t = setTimeout(() => fin(false), timeout);
  });
}

async function loadFile(file) {
  if (!file || S.exporting) return;
  video.pause();
  busy(true, 'Открываю видео…');
  const r = await api.loadVideo(file);
  if (!r || r.error) { busy(false); toast(r ? r.error : 'Ошибка'); return; }
  if (!r.info.hasVideo) { busy(false); toast('В файле нет видеодорожки'); return; }
  S.file = r.file; S.name = r.name; S.info = r.info; S.size = r.size;

  const needProxy = !PLAYABLE_V.includes(r.info.vcodec) || (r.info.hasAudio && !PLAYABLE_A.includes(r.info.acodec));
  let ok = false;
  if (!needProxy) { video.src = r.url; ok = await waitMeta(video); }
  if (!ok) {
    busy(true, 'Готовлю превью для этого формата…', 0);
    const px = await api.makeProxy(r.file, r.info.duration);
    if (px.error) { busy(false); toast('Не удалось открыть видео'); console.error(px.error); return; }
    video.src = px.url; ok = await waitMeta(video, 15000);
    if (!ok) { busy(false); toast('Не удалось воспроизвести видео'); return; }
  }
  S.previewUrl = video.currentSrc;
  S.duration = r.info.duration > 0 ? r.info.duration : video.duration;
  S.vw = video.videoWidth; S.vh = video.videoHeight;
  // source pixel dims, oriented as displayed
  let iw = r.info.width || S.vw, ih = r.info.height || S.vh;
  if ((iw > ih) !== (S.vw > S.vh)) [iw, ih] = [ih, iw];
  S.srcW = iw; S.srcH = ih;

  const keepExp = S.exp;
  S.edit = DEFAULT_EDIT();
  S.edit.segments = [{ s: 0, e: S.duration }];
  S.sel = 0; S.exp = keepExp; S.zoom = 1; $('#zoom').value = 1;
  hist = []; hIdx = -1; commit();

  $('#drop').classList.add('hidden');
  $('#frameWrap').classList.remove('hidden');
  $('.side').classList.remove('disabled');
  $('#btnExport').disabled = false; $('#btnExportTop').disabled = false;
  $('#fileTitle').innerHTML = '';
  const b = document.createElement('b'); b.textContent = S.name;
  $('#fileTitle').append(b, document.createTextNode(`  ·  ${S.srcW}×${S.srcH}  ·  ${Math.round(fps() * 100) / 100} fps  ·  ${fmtShort(S.duration)}  ·  ${fmtSize(S.size)}`));
  $('#aTrack').style.display = r.info.hasAudio ? '' : 'none';
  $('#wave').removeAttribute('src');
  video.currentTime = 0;
  busy(false);
  applyAll();
  requestAnimationFrame(() => { layoutFrame(); renderTimeline(); buildFilm(); });
  if (r.info.hasAudio) api.waveform(r.file).then((u) => { if (u && S.file === r.file) $('#wave').src = u; });
}

// ===================== preview frame layout =====================
function layoutFrame() {
  if (!S.vw) return;
  const st = $('#stage').getBoundingClientRect();
  const pad = 28;
  const W = st.width - pad * 2, H = st.height - pad * 2;
  const rotated = S.edit.rot % 180 !== 0;
  const bw = rotated ? S.vh : S.vw, bh = rotated ? S.vw : S.vh;
  const k = Math.min(W / bw, H / bh);
  const f = $('#frame');
  f.style.width = `${S.vw * k}px`; f.style.height = `${S.vh * k}px`;
  f.style.left = `${st.width / 2}px`; f.style.top = `${st.height / 2}px`;
  const deg = S.edit.rot + 360 * S.edit.rotTurns;
  f.style.transform = `translate(-50%,-50%) rotate(${deg}deg) scale(${S.edit.flipH ? -1 : 1},${S.edit.flipV ? -1 : 1})`;
}
new ResizeObserver(() => { layoutFrame(); renderTimeline(); }).observe($('#stage'));

function applyPreviewFilters() {
  const e = S.edit;
  const br = 1 + e.bright / 100 * 0.6, ct = 1 + e.contrast / 100, sa = 1 + e.sat / 100;
  video.style.filter = (e.bright || e.contrast || e.sat) ? `brightness(${br}) contrast(${ct}) saturate(${sa})` : '';
  video.playbackRate = e.speed;
  video.preservesPitch = true;
  video.volume = clamp(e.volume / 100, 0, 1);
  video.muted = e.mute || e.volume === 0 || S.uiMuted;
  $('#volIcon use').setAttribute('href', video.muted ? '#i-mute' : '#i-vol');
}

// ===================== crop =====================
function aspectRatio() {
  const a = S.edit.aspect;
  if (a === 'free') return null;
  const [x, y] = a.split(':').map(Number);
  return x / y;
}
// required ratio of normalized (w/h) in source space
function normRatio(A) {
  const rotated = S.edit.rot % 180 !== 0;
  const pxRatio = rotated ? 1 / A : A; // width/height in source pixels
  return pxRatio * S.vh / S.vw;
}
function fitAspect() {
  const A = aspectRatio();
  if (!A) { if (!S.edit.crop) S.edit.crop = { x: 0, y: 0, w: 1, h: 1 }; return; }
  const r = normRatio(A);
  let w = 1, h = w / r;
  if (h > 1) { h = 1; w = r; }
  const c = S.edit.crop;
  const cx = c ? c.x + c.w / 2 : 0.5, cy = c ? c.y + c.h / 2 : 0.5;
  S.edit.crop = { w, h, x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h) };
}
function cropIsFull(c) { return !c || (c.x < 0.001 && c.y < 0.001 && c.w > 0.999 && c.h > 0.999); }
function renderCrop() {
  const c = S.edit.crop || { x: 0, y: 0, w: 1, h: 1 };
  const box = $('#cropBox');
  box.style.left = `${c.x * 100}%`; box.style.top = `${c.y * 100}%`;
  box.style.width = `${c.w * 100}%`; box.style.height = `${c.h * 100}%`;
  const layer = $('#cropLayer');
  layer.classList.toggle('edit', S.cropEdit);
  layer.classList.toggle('off', cropIsFull(S.edit.crop) && !S.cropEdit);
  $('#cropShow').checked = S.cropEdit;
  if (cropIsFull(S.edit.crop)) $('#cropInfo').textContent = 'Без кадрирования';
  else {
    const [w, h] = cropPixels();
    $('#cropInfo').innerHTML = `Размер области: <b>${w}×${h}</b>`;
  }
  $$('#cropAspect button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.edit.aspect));
}
function cropPixels() {
  const c = S.edit.crop || { w: 1, h: 1 };
  let w = Math.round(S.srcW * c.w / 2) * 2, h = Math.round(S.srcH * c.h / 2) * 2;
  if (S.edit.rot % 180 !== 0) [w, h] = [h, w];
  return [w, h];
}
(function cropDrag() {
  const box = $('#cropBox');
  let drag = null;
  box.addEventListener('pointerdown', (ev) => {
    if (!S.cropEdit) return;
    ev.preventDefault(); ev.stopPropagation();
    box.setPointerCapture(ev.pointerId);
    drag = { h: ev.target.dataset.h || 'move', x: ev.clientX, y: ev.clientY, c: { ...S.edit.crop } };
  });
  box.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const f = $('#frame');
    let dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    const r = -(S.edit.rot * Math.PI) / 180;
    [dx, dy] = [dx * Math.cos(r) - dy * Math.sin(r), dx * Math.sin(r) + dy * Math.cos(r)];
    if (S.edit.flipH) dx = -dx; if (S.edit.flipV) dy = -dy;
    dx /= f.offsetWidth; dy /= f.offsetHeight;
    const o = drag.c; const MIN = 0.04;
    let { x, y, w, h } = o;
    const H = drag.h;
    if (H === 'move') { x = clamp(o.x + dx, 0, 1 - o.w); y = clamp(o.y + dy, 0, 1 - o.h); }
    else {
      let L = o.x, T = o.y, R = o.x + o.w, B = o.y + o.h;
      if (H.includes('w')) L = clamp(L + dx, 0, R - MIN);
      if (H.includes('e')) R = clamp(R + dx, L + MIN, 1);
      if (H.includes('n')) T = clamp(T + dy, 0, B - MIN);
      if (H.includes('s')) B = clamp(B + dy, T + MIN, 1);
      x = L; y = T; w = R - L; h = B - T;
      const A = aspectRatio();
      if (A) {
        const k = normRatio(A);
        if (H === 'n' || H === 's') { const nw = h * k; x = o.x + o.w / 2 - nw / 2; w = nw; }
        else if (H === 'e' || H === 'w') { const nh = w / k; y = o.y + o.h / 2 - nh / 2; h = nh; }
        else { h = w / k; if (H.includes('n')) y = B - h; }
        // shrink to fit bounds
        let s = 1;
        if (w > 1) s = Math.min(s, 1 / w); if (h > 1) s = Math.min(s, 1 / h);
        w *= s; h *= s;
        if (H.includes('w')) x = Math.min(x, R - w); if (H.includes('n') && !(H === 'n')) y = Math.min(y, B - h);
        x = clamp(x, 0, 1 - w); y = clamp(y, 0, 1 - h);
      }
    }
    S.edit.crop = { x, y, w, h };
    renderCrop(); updateSummary();
  });
  const end = () => { if (drag) { drag = null; commit(); } };
  box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
})();

// ===================== timeline =====================
const tl = { pps: 1 };
function tlWidth() { return Math.max(200, ($('#tlScroll').clientWidth - 28) * S.zoom); }
function renderTimeline() {
  if (!S.duration) return;
  const w = tlWidth();
  $('#tlInner').style.width = `${w}px`;
  tl.pps = w / S.duration;
  // ruler
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const major = steps.find((s) => s * tl.pps >= 90) || 3600;
  const minor = major / (major >= 1 && major <= 2 ? 4 : 5);
  const ruler = $('#ruler'); ruler.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let t = 0; t <= S.duration + 1e-6; t += minor) {
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    const d = document.createElement('div');
    d.className = isMajor ? 'tk' : 'tk minor';
    d.style.left = `${t * tl.pps}px`;
    if (isMajor) d.textContent = major < 1 ? fmtTime(t).replace(/0$/, '') : fmtShort(t);
    frag.appendChild(d);
  }
  ruler.appendChild(frag);
  renderSegs();
  updatePlayhead(true);
}
function renderSegs() {
  const box = $('#segs'); box.innerHTML = '';
  const segs = S.edit.segments;
  let prev = 0;
  const gap = (a, b) => { if (b - a > 1e-4) { const g = document.createElement('div'); g.className = 'gap'; g.style.left = `${a * tl.pps}px`; g.style.width = `${(b - a) * tl.pps}px`; box.appendChild(g); } };
  segs.forEach((sg, i) => {
    gap(prev, sg.s); prev = sg.e;
    const d = document.createElement('div');
    d.className = 'seg' + (i === S.sel ? ' sel' : '');
    d.style.left = `${sg.s * tl.pps}px`; d.style.width = `${Math.max(2, (sg.e - sg.s) * tl.pps)}px`;
    d.innerHTML = `<div class="grip l" data-g="l"></div><div class="grip r" data-g="r"></div><span class="lbl">${fmtShort(sg.e - sg.s)}</span>`;
    d.dataset.i = i;
    box.appendChild(d);
  });
  gap(prev, S.duration);
  $('#outDur').textContent = fmtTime(outDuration(), false);
  $('#btnDel').disabled = segs.length <= 1;
  updateSummary();
}
function outDuration() { return S.edit.segments.reduce((a, s) => a + (s.e - s.s), 0) / S.edit.speed; }
function timeAtX(clientX) {
  const r = $('#tlInner').getBoundingClientRect();
  return clamp((clientX - r.left) / tl.pps, 0, S.duration);
}
function segIndexAt(t) { return S.edit.segments.findIndex((s) => t >= s.s - 1e-6 && t <= s.e + 1e-6); }

(function timelineInput() {
  const inner = $('#tlInner');
  let mode = null;
  inner.addEventListener('pointerdown', (ev) => {
    if (!S.duration || ev.button !== 0) return;
    inner.setPointerCapture(ev.pointerId);
    const grip = ev.target.dataset.g;
    const segEl = ev.target.closest('.seg');
    if (grip && segEl) {
      const i = +segEl.dataset.i;
      S.sel = i; mode = { type: 'grip', i, side: grip };
      video.pause();
    } else {
      mode = { type: 'scrub', wasPlaying: !video.paused };
      video.pause();
      const t = timeAtX(ev.clientX);
      const si = segIndexAt(t); if (si >= 0) S.sel = si;
      seek(t);
    }
    renderSegs();
  });
  inner.addEventListener('pointermove', (ev) => {
    if (!S.duration) return;
    const t = timeAtX(ev.clientX);
    const hl = $('#hoverLine'); hl.classList.add('on');
    hl.style.left = `${t * tl.pps}px`; $('#hoverTime').textContent = fmtTime(t);
    if (!mode) return;
    if (mode.type === 'scrub') seek(t);
    else if (mode.type === 'grip') {
      const segs = S.edit.segments, sg = segs[mode.i];
      const MIN = Math.max(0.1, 2 / fps());
      if (mode.side === 'l') {
        const lo = mode.i > 0 ? segs[mode.i - 1].e : 0;
        sg.s = clamp(t, lo, sg.e - MIN); seek(sg.s);
      } else {
        const hi = mode.i < segs.length - 1 ? segs[mode.i + 1].s : S.duration;
        sg.e = clamp(t, sg.s + MIN, hi); seek(sg.e);
      }
      renderSegs();
    }
  });
  inner.addEventListener('pointerleave', () => $('#hoverLine').classList.remove('on'));
  const end = () => {
    if (mode && mode.type === 'grip') commit();
    if (mode && mode.type === 'scrub' && mode.wasPlaying) play();
    mode = null;
  };
  inner.addEventListener('pointerup', end); inner.addEventListener('pointercancel', end);
  // zoom with ctrl+wheel, scroll with wheel
  $('#tlScroll').addEventListener('wheel', (ev) => {
    if (!S.duration) return;
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      setZoom(S.zoom * (ev.deltaY < 0 ? 1.15 : 1 / 1.15), ev.clientX);
    } else if (Math.abs(ev.deltaY) > Math.abs(ev.deltaX)) {
      ev.preventDefault();
      $('#tlScroll').scrollLeft += ev.deltaY;
    }
  }, { passive: false });
})();

function setZoom(z, anchorX) {
  const sc = $('#tlScroll');
  const rect = sc.getBoundingClientRect();
  const ax = anchorX != null ? anchorX - rect.left : (playheadX() - sc.scrollLeft);
  const tAnchor = (sc.scrollLeft + ax - 14) / tl.pps;
  S.zoom = clamp(z, 1, 40); $('#zoom').value = S.zoom; fillRange($('#zoom'));
  renderTimeline();
  sc.scrollLeft = tAnchor * tl.pps + 14 - ax;
}
function playheadX() { return 14 + video.currentTime * tl.pps; }

// filmstrip
let filmToken = 0;
async function buildFilm() {
  const token = ++filmToken;
  const film = $('#film'); film.innerHTML = '';
  if (!S.previewUrl) return;
  const n = clamp(Math.round(($('#tlScroll').clientWidth - 28) / 96), 6, 24);
  thumbVideo.src = S.previewUrl;
  if (!(await waitMeta(thumbVideo, 8000))) return;
  const c = document.createElement('canvas');
  const th = 68, tw = Math.round(th * S.vw / S.vh);
  c.width = tw * 2; c.height = th * 2;
  const ctx = c.getContext('2d');
  const imgs = [];
  for (let i = 0; i < n; i++) { const im = document.createElement('img'); im.style.opacity = 0; film.appendChild(im); imgs.push(im); }
  for (let i = 0; i < n; i++) {
    if (token !== filmToken) return;
    const t = (i + 0.5) * S.duration / n;
    await new Promise((res) => { const f = () => { thumbVideo.removeEventListener('seeked', f); res(); }; thumbVideo.addEventListener('seeked', f); thumbVideo.currentTime = t; setTimeout(f, 2500); });
    ctx.drawImage(thumbVideo, 0, 0, c.width, c.height);
    imgs[i].src = c.toDataURL('image/jpeg', 0.7); imgs[i].style.opacity = 1;
  }
  thumbVideo.removeAttribute('src'); thumbVideo.load();
}

// ===================== playback =====================
function seek(t) { video.currentTime = clamp(t, 0, S.duration); updatePlayhead(); }
function play() {
  if (!S.file) return;
  const segs = S.edit.segments;
  const t = video.currentTime;
  const last = segs[segs.length - 1];
  if (t >= last.e - 0.02) video.currentTime = segs[0].s;
  else if (segIndexAt(t) < 0) { const nx = segs.find((s) => s.s > t); if (nx) video.currentTime = nx.s; }
  video.play().catch(() => {});
}
function togglePlay() { video.paused ? play() : video.pause(); }
video.addEventListener('play', () => { $('#playIcon use').setAttribute('href', '#i-pause'); });
video.addEventListener('pause', () => { $('#playIcon use').setAttribute('href', '#i-play'); });

function updatePlayhead(force) {
  const t = video.currentTime;
  $('#playhead').style.transform = `translateX(${t * tl.pps}px)`;
  $('#tcCur').textContent = fmtTime(t);
  $('#tcDur').textContent = fmtTime(S.duration);
  if (!video.paused && !force) {
    const sc = $('#tlScroll'), x = playheadX();
    if (x > sc.scrollLeft + sc.clientWidth - 40 || x < sc.scrollLeft) sc.scrollLeft = x - 60;
  }
  // fade preview
  const e = S.edit;
  let op = 0;
  if (e.fadeIn || e.fadeOut) {
    let acc = 0; let outT = -1;
    for (const s of e.segments) { if (t >= s.s && t <= s.e) { outT = acc + (t - s.s); break; } acc += s.e - s.s; }
    if (outT >= 0) {
      outT /= e.speed; const total = outDuration();
      if (e.fadeIn && outT < e.fadeIn) op = 1 - outT / e.fadeIn;
      else if (e.fadeOut && outT > total - e.fadeOut) op = (outT - (total - e.fadeOut)) / e.fadeOut;
    }
  }
  $('#fadeVeil').style.opacity = clamp(op, 0, 1);
}
function loop() {
  if (S.file && !video.paused) {
    const t = video.currentTime;
    const segs = S.edit.segments;
    const i = segIndexAt(t);
    if (i < 0) {
      const nx = segs.find((s) => s.s > t);
      if (nx) video.currentTime = nx.s; else { video.pause(); video.currentTime = segs[segs.length - 1].e; }
    } else if (t >= segs[i].e - 0.01) {
      if (i < segs.length - 1) video.currentTime = segs[i + 1].s;
      else { video.pause(); video.currentTime = segs[i].e; }
    }
  }
  if (S.file) updatePlayhead();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
video.addEventListener('ended', () => video.pause());

// ===================== edit operations =====================
function splitAt() {
  const t = video.currentTime; const segs = S.edit.segments;
  const i = segIndexAt(t);
  const MIN = Math.max(0.1, 2 / fps());
  if (i < 0 || t - segs[i].s < MIN || segs[i].e - t < MIN) { toast('Здесь нельзя разрезать'); return; }
  segs.splice(i + 1, 0, { s: t, e: segs[i].e }); segs[i].e = t;
  S.sel = i + 1; renderSegs(); commit(); toast('Разрезано');
}
function deleteSel() {
  const segs = S.edit.segments;
  if (segs.length <= 1) { toast('Нельзя удалить единственный фрагмент'); return; }
  segs.splice(S.sel, 1); S.sel = clamp(S.sel, 0, segs.length - 1);
  renderSegs(); commit(); toast('Фрагмент удалён');
}
function setIn() {
  const t = video.currentTime; const segs = S.edit.segments;
  let i = segIndexAt(t); if (i < 0) i = S.sel;
  const sg = segs[i]; const lo = i > 0 ? segs[i - 1].e : 0;
  if (t >= sg.e - 0.05) { toast('Начало должно быть раньше конца'); return; }
  sg.s = clamp(t, lo, sg.e - 0.05); S.sel = i; renderSegs(); commit();
}
function setOut() {
  const t = video.currentTime; const segs = S.edit.segments;
  let i = segIndexAt(t); if (i < 0) i = S.sel;
  const sg = segs[i]; const hi = i < segs.length - 1 ? segs[i + 1].s : S.duration;
  if (t <= sg.s + 0.05) { toast('Конец должен быть позже начала'); return; }
  sg.e = clamp(t, sg.s + 0.05, hi); S.sel = i; renderSegs(); commit();
}

// ===================== side panel controls =====================
function fillRange(el) {
  const p = ((el.value - el.min) / (el.max - el.min)) * 100;
  el.style.setProperty('--p', `${p}%`);
}
$$('input[type=range]').forEach((el) => { fillRange(el); el.addEventListener('input', () => fillRange(el)); });

function bindSeg(sel, get, set) {
  $$(`${sel} button`).forEach((b) => b.addEventListener('click', () => { set(b.dataset.v); syncUI(); }));
}
const QNAMES = ['Максимальное', 'Высокое', 'Среднее', 'Сжатое'];

function syncUI() {
  const e = S.edit, x = S.exp;
  $$('#speedSeg button').forEach((b) => b.classList.toggle('on', +b.dataset.v === e.speed));
  $('#volume').value = e.volume; $('#volumeOut').textContent = `${e.volume}%`; $('#mute').checked = e.mute;
  $('#bright').value = e.bright; $('#brightOut').textContent = e.bright;
  $('#contrast').value = e.contrast; $('#contrastOut').textContent = e.contrast;
  $('#sat').value = e.sat; $('#satOut').textContent = e.sat;
  $('#fadeIn').value = e.fadeIn; $('#fadeInOut').textContent = `${e.fadeIn} с`;
  $('#fadeOut').value = e.fadeOut; $('#fadeOutOut').textContent = `${e.fadeOut} с`;
  $('#flipH').classList.toggle('on', e.flipH); $('#flipV').classList.toggle('on', e.flipV);
  $$('#fmtCards .card').forEach((b) => b.classList.toggle('on', b.dataset.v === x.fmt));
  $$('#resSeg button').forEach((b) => b.classList.toggle('on', +b.dataset.v === x.res));
  $$('#fpsSeg button').forEach((b) => b.classList.toggle('on', +b.dataset.v === x.fps));
  $$('#hwSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === x.hw));
  $('#quality').value = x.quality; $('#qualityName').textContent = QNAMES[x.quality];
  $('#interp').checked = x.interp;
  const isAudio = x.fmt === 'mp3', isGif = x.fmt === 'gif';
  $('#grpRes').classList.toggle('hidden', isAudio);
  $('#grpFps').classList.toggle('hidden', isAudio);
  $('#grpHw').classList.toggle('hidden', isAudio || isGif || x.fmt === 'webm');
  $('#grpQuality').classList.toggle('hidden', isGif);
  $('#interpRow').classList.toggle('disabled', !x.fps || isGif);
  $$('input[type=range]').forEach(fillRange);
  applyPreviewFilters(); renderCrop(); layoutFrame(); renderSegs(); updatePlayhead(true); saveExp();
}
function applyAll() { syncUI(); }

bindSeg('#speedSeg', null, (v) => { S.edit.speed = +v; commit(); });
bindSeg('#cropAspect', null, (v) => { S.edit.aspect = v; S.cropEdit = true; fitAspect(); commit(); });
bindSeg('#resSeg', null, (v) => { S.exp.res = +v; });
bindSeg('#fpsSeg', null, (v) => { S.exp.fps = +v; });
bindSeg('#hwSeg', null, (v) => { S.exp.hw = v; });
$$('#fmtCards .card').forEach((b) => b.addEventListener('click', () => { S.exp.fmt = b.dataset.v; syncUI(); }));
$('#quality').addEventListener('input', (ev) => { S.exp.quality = +ev.target.value; syncUI(); });
$('#interp').addEventListener('change', (ev) => { S.exp.interp = ev.target.checked; syncUI(); });
$('#cropShow').addEventListener('change', (ev) => { S.cropEdit = ev.target.checked; if (S.cropEdit && !S.edit.crop) fitAspect(); syncUI(); });

const sliders = [['volume', 'volume', (v) => `${v}%`], ['bright', 'bright', String], ['contrast', 'contrast', String], ['sat', 'sat', String], ['fadeIn', 'fadeIn', (v) => `${v} с`], ['fadeOut', 'fadeOut', (v) => `${v} с`]];
sliders.forEach(([id, key, f]) => {
  const el = $(`#${id}`);
  el.addEventListener('input', () => { S.edit[key] = +el.value; $(`#${id}Out`).textContent = f(+el.value); applyPreviewFilters(); updatePlayhead(true); updateSummary(); });
  el.addEventListener('change', commit);
  el.addEventListener('dblclick', () => { S.edit[key] = 0 + (id === 'volume' ? 100 : 0); syncUI(); commit(); });
});
$('#mute').addEventListener('change', (ev) => { S.edit.mute = ev.target.checked; syncUI(); commit(); });
$('#rotL').addEventListener('click', () => rotate(-90));
$('#rotR').addEventListener('click', () => rotate(90));
function rotate(d) {
  const e = S.edit;
  let r = e.rot + d;
  if (r >= 360) { r -= 360; e.rotTurns++; } else if (r < 0) { r += 360; e.rotTurns--; }
  e.rot = r;
  if (e.aspect !== 'free' && e.crop) fitAspect();
  syncUI(); commit();
}
$('#flipH').addEventListener('click', () => { S.edit.flipH = !S.edit.flipH; syncUI(); commit(); });
$('#flipV').addEventListener('click', () => { S.edit.flipV = !S.edit.flipV; syncUI(); commit(); });
$$('[data-reset]').forEach((b) => b.addEventListener('click', () => {
  const e = S.edit, k = b.dataset.reset;
  if (k === 'crop') { e.crop = null; e.aspect = 'free'; S.cropEdit = false; }
  if (k === 'transform') { e.rot = 0; e.rotTurns = 0; e.flipH = false; e.flipV = false; }
  if (k === 'speed') e.speed = 1;
  if (k === 'audio') { e.volume = 100; e.mute = false; }
  if (k === 'color') { e.bright = 0; e.contrast = 0; e.sat = 0; }
  if (k === 'fade') { e.fadeIn = 0; e.fadeOut = 0; }
  syncUI(); commit();
}));

// tabs
$$('.tab').forEach((t, i) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
function selectTab(name) {
  $$('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  $$('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  $('#tabInk').style.transform = name === 'export' ? 'translateX(100%)' : '';
  if (name !== 'edit' && S.cropEdit) { S.cropEdit = false; renderCrop(); }
}

// ===================== export =====================
function outDims() {
  let [w, h] = cropPixels();
  const x = S.exp;
  let target = x.res;
  if (x.fmt === 'gif' && !target) target = Math.min(480, Math.min(w, h));
  if (target) {
    if (w >= h) { w = Math.round((w * target / h) / 2) * 2; h = target; }
    else { h = Math.round((h * target / w) / 2) * 2; w = target; }
  }
  return [w, h];
}
function outFps() {
  const x = S.exp;
  if (x.fmt === 'gif') return x.fps ? Math.min(x.fps, 30) : Math.min(15, fps());
  return x.fps || fps();
}
function estimateBytes() {
  const d = outDuration(); const x = S.exp;
  const audio = S.info && S.info.hasAudio && !S.edit.mute ? (x.fmt === 'webm' ? 160e3 : 192e3) : 0;
  if (x.fmt === 'mp3') return audio ? d * 190e3 / 8 : 0;
  const [w, h] = outDims(); const f = outFps();
  if (x.fmt === 'gif') return w * h * f * d * 0.12;
  const bpp = [0.16, 0.1, 0.065, 0.035][x.quality] * (x.fmt === 'hevc' ? 0.6 : x.fmt === 'webm' ? 0.65 : 1) * Math.pow(30 / f, 0.35);
  return (w * h * f * bpp * d + audio * d) / 8;
}
function updateSummary() {
  if (!S.file) { $('#summary').innerHTML = ''; return; }
  const x = S.exp; const rows = [];
  rows.push(['Длительность', fmtTime(outDuration(), false)]);
  if (x.fmt !== 'mp3') { const [w, h] = outDims(); rows.push(['Разрешение', `${w}×${h}`]); rows.push(['Кадров/с', Math.round(outFps() * 100) / 100]); }
  rows.push(['Размер файла', `≈ ${fmtSize(estimateBytes())}`]);
  $('#summary').innerHTML = rows.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join('');
}

function atempoChain(s) {
  const out = [];
  while (s > 2) { out.push('atempo=2'); s /= 2; }
  while (s < 0.5) { out.push('atempo=0.5'); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${s.toFixed(5)}`);
  return out;
}
function geomFilters() {
  const e = S.edit; const f = [];
  if (!cropIsFull(e.crop)) {
    const c = e.crop;
    f.push(`crop=trunc(iw*${c.w.toFixed(6)}/2)*2:trunc(ih*${c.h.toFixed(6)}/2)*2:trunc(iw*${c.x.toFixed(6)}):trunc(ih*${c.y.toFixed(6)})`);
  }
  if (e.flipH) f.push('hflip');
  if (e.flipV) f.push('vflip');
  if (e.rot === 90) f.push('transpose=1');
  else if (e.rot === 180) f.push('hflip', 'vflip');
  else if (e.rot === 270) f.push('transpose=2');
  if (e.bright) { const k = (1 + e.bright / 100 * 0.6).toFixed(4); f.push(`colorchannelmixer=rr=${k}:gg=${k}:bb=${k}`); }
  if (e.contrast || e.sat) f.push(`eq=contrast=${(1 + e.contrast / 100).toFixed(4)}:saturation=${(1 + e.sat / 100).toFixed(4)}`);
  return f;
}

function encoderFor(fmt, hwChoice) {
  const q = S.exp.quality; const crf = [16, 20, 23, 28][q];
  const hw = S.hw || {};
  const pick = (base) => {
    if (hwChoice !== 'auto') return null;
    for (const v of ['nvenc', 'qsv', 'amf']) if (hw[`${base}_${v}`]) return v;
    return null;
  };
  if (fmt === 'mp4' || fmt === 'hevc') {
    const base = fmt === 'mp4' ? 'h264' : 'hevc';
    const v = pick(base);
    const tag = fmt === 'hevc' ? ['-tag:v', 'hvc1'] : [];
    if (v === 'nvenc') return { name: 'NVIDIA NVENC', hw: true, args: ['-c:v', `${base}_nvenc`, '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(crf + 3), '-b:v', '0', '-pix_fmt', 'yuv420p', ...tag] };
    if (v === 'qsv') return { name: 'Intel Quick Sync', hw: true, args: ['-c:v', `${base}_qsv`, '-preset', 'medium', '-global_quality', String(crf + 3), '-pix_fmt', 'nv12', ...tag] };
    if (v === 'amf') return { name: 'AMD AMF', hw: true, args: ['-c:v', `${base}_amf`, '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(crf + 1), '-qp_p', String(crf + 3), '-pix_fmt', 'nv12', ...tag] };
    if (fmt === 'mp4') return { name: 'Процессор (x264)', args: ['-c:v', 'libx264', '-preset', q === 0 ? 'slow' : 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p'] };
    return { name: 'Процессор (x265)', args: ['-c:v', 'libx265', '-preset', 'medium', '-crf', String(crf + 4), '-pix_fmt', 'yuv420p', ...tag] };
  }
  if (fmt === 'webm') return { name: 'Процессор (VP9)', args: ['-c:v', 'libvpx-vp9', '-crf', String(crf + 11), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p'] };
  return { name: '', args: [] };
}

function buildArgs(out, hwChoice) {
  const e = S.edit, x = S.exp, info = S.info;
  const segs = e.segments;
  const hasA = info.hasAudio && !e.mute && x.fmt !== 'gif';
  const wantV = x.fmt !== 'mp3';
  const args = [];
  const N = segs.length;
  if (N === 1) args.push('-ss', segs[0].s.toFixed(4), '-t', (segs[0].e - segs[0].s).toFixed(4));
  args.push('-i', S.file);
  const g = [];
  let vin = '[0:v]', ain = '[0:a]';
  if (N > 1) {
    if (wantV) {
      g.push(`[0:v]split=${N}${segs.map((_, i) => `[sv${i}]`).join('')}`);
      segs.forEach((s, i) => g.push(`[sv${i}]trim=start=${s.s.toFixed(4)}:end=${s.e.toFixed(4)},setpts=PTS-STARTPTS[tv${i}]`));
    }
    if (hasA) {
      g.push(`[0:a]asplit=${N}${segs.map((_, i) => `[sa${i}]`).join('')}`);
      segs.forEach((s, i) => g.push(`[sa${i}]atrim=start=${s.s.toFixed(4)}:end=${s.e.toFixed(4)},asetpts=PTS-STARTPTS[ta${i}]`));
    }
    const ins = segs.map((_, i) => `${wantV ? `[tv${i}]` : ''}${hasA ? `[ta${i}]` : ''}`).join('');
    g.push(`${ins}concat=n=${N}:v=${wantV ? 1 : 0}:a=${hasA ? 1 : 0}${wantV ? '[vc]' : ''}${hasA ? '[ac]' : ''}`);
    vin = '[vc]'; ain = '[ac]';
  }
  const total = outDuration();
  if (wantV) {
    const vf = geomFilters();
    if (e.speed !== 1) vf.push(`setpts=PTS/${e.speed}`);
    const [ow, oh] = outDims();
    const [cw, ch] = cropPixels();
    if (ow !== cw || oh !== ch) vf.push(`scale=${ow}:${oh}:flags=lanczos`);
    else vf.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
    vf.push('setsar=1');
    const of = outFps();
    if (x.fps || x.fmt === 'gif') {
      if (x.interp && x.fmt !== 'gif' && x.fps > fps() * e.speed + 0.5) vf.push(`minterpolate=fps=${of}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`);
      else vf.push(`fps=${of}`);
    }
    if (e.fadeIn > 0) vf.push(`fade=t=in:st=0:d=${e.fadeIn}`);
    if (e.fadeOut > 0) vf.push(`fade=t=out:st=${Math.max(0, total - e.fadeOut).toFixed(3)}:d=${e.fadeOut}`);
    if (x.fmt === 'gif') {
      g.push(`${vin}${vf.join(',')},split[g1][g2]`);
      g.push('[g1]palettegen=stats_mode=diff:max_colors=256[pal]');
      g.push('[g2][pal]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle[vout]');
    } else g.push(`${vin}${vf.join(',')}[vout]`);
  }
  if (hasA) {
    const af = [];
    if (e.volume !== 100) af.push(`volume=${(e.volume / 100).toFixed(3)}`);
    af.push(...atempoChain(e.speed));
    if (e.fadeIn > 0) af.push(`afade=t=in:st=0:d=${e.fadeIn}`);
    if (e.fadeOut > 0) af.push(`afade=t=out:st=${Math.max(0, total - e.fadeOut).toFixed(3)}:d=${e.fadeOut}`);
    if (!af.length) af.push('anull');
    g.push(`${ain}${af.join(',')}[aout]`);
  }
  args.push('-filter_complex', g.join(';'));
  if (wantV) args.push('-map', '[vout]');
  if (hasA) args.push('-map', '[aout]');
  const enc = encoderFor(x.fmt, hwChoice);
  if (x.fmt === 'gif') args.push('-loop', '0');
  else if (x.fmt === 'mp3') args.push('-c:a', 'libmp3lame', '-q:a', String([0, 2, 4, 6][x.quality]));
  else {
    args.push(...enc.args);
    if (hasA) args.push(...(x.fmt === 'webm' ? ['-c:a', 'libopus', '-b:a', '160k'] : ['-c:a', 'aac', '-b:a', x.quality === 0 ? '320k' : '192k']));
    if (x.fmt !== 'webm') args.push('-movflags', '+faststart');
  }
  args.push('-map_metadata', '-1', '-max_muxing_queue_size', '4096', out);
  return { args, total, enc };
}

const EXT = { mp4: 'mp4', hevc: 'mp4', webm: 'webm', gif: 'gif', mp3: 'mp3' };
async function doExport() {
  if (!S.file || S.exporting) return;
  if (S.exp.fmt === 'mp3' && !S.info.hasAudio) { toast('В видео нет звука'); return; }
  video.pause();
  const ext = EXT[S.exp.fmt];
  const base = S.name.replace(/\.[^.]+$/, '');
  const out = await api.chooseOutput(`${base}_edit.${ext}`, ext);
  if (!out) return;
  if (out === S.file) { toast('Нельзя перезаписать исходный файл'); return; }
  S.exporting = true; S.lastOut = out;
  openModal();
  let job = buildArgs(out, S.exp.hw);
  $('#mSub').textContent = job.enc.name ? `Кодирование: ${job.enc.name}` : 'Обработка…';
  let r = await api.exportVideo({ args: job.args, total: job.total });
  if (!r.ok && !r.cancelled && job.enc.hw) {
    $('#mSub').textContent = 'Видеокарта не справилась — переключаюсь на процессор…';
    job = buildArgs(out, 'cpu');
    r = await api.exportVideo({ args: job.args, total: job.total });
  }
  S.exporting = false;
  finishModal(r, out);
}
function openModal() {
  const sh = $('#modal .sheet'); sh.classList.remove('done', 'fail');
  setRing(0); $('#mTitle').textContent = 'Экспорт видео'; $('#mErr').classList.add('hidden');
  $('#mActionsRun').classList.remove('hidden'); $('#mActionsDone').classList.add('hidden');
  $('#modal').classList.remove('hidden');
}
function setRing(p) {
  $('#ringFg').style.strokeDashoffset = String(326.7 * (1 - p));
  $('#ringTxt').textContent = `${Math.floor(p * 100)}%`;
}
api.onExportProgress(({ p, eta, speed }) => {
  setRing(p);
  const parts = [];
  if (eta != null && isFinite(eta)) parts.push(`осталось ~${fmtShort(Math.ceil(eta))}`);
  if (speed) parts.push(`скорость ${speed.toFixed(1)}×`);
  if (parts.length) $('#mSub').textContent = parts.join(' · ');
});
async function finishModal(r, out) {
  const sh = $('#modal .sheet');
  $('#mActionsRun').classList.add('hidden');
  if (r.ok) {
    setRing(1); sh.classList.add('done');
    const size = await api.fileSize(out);
    $('#mTitle').textContent = 'Готово!';
    $('#mSub').textContent = `${out.split(/[\\/]/).pop()} · ${fmtSize(size)}`;
    $('#mActionsDone').classList.remove('hidden');
    $('#btnPlayOut').classList.remove('hidden'); $('#btnFolder').classList.remove('hidden');
  } else if (r.cancelled) {
    $('#modal').classList.add('hidden'); toast('Экспорт отменён');
  } else {
    sh.classList.add('fail');
    $('#mTitle').textContent = 'Ошибка экспорта';
    $('#mSub').textContent = 'Попробуйте другой формат или кодирование процессором';
    $('#mErr').textContent = r.error || ''; $('#mErr').classList.remove('hidden');
    $('#mActionsDone').classList.remove('hidden');
    $('#btnPlayOut').classList.add('hidden'); $('#btnFolder').classList.add('hidden');
  }
}
$('#btnCancel').addEventListener('click', () => api.cancelExport());
$('#btnClose').addEventListener('click', () => $('#modal').classList.add('hidden'));
$('#btnFolder').addEventListener('click', () => S.lastOut && api.showInFolder(S.lastOut));
$('#btnPlayOut').addEventListener('click', () => { S.lastOut && api.openPath(S.lastOut); $('#modal').classList.add('hidden'); });

async function snapshot() {
  if (!S.file) return;
  video.pause();
  const t = video.currentTime;
  const base = S.name.replace(/\.[^.]+$/, '');
  const out = await api.chooseOutput(`${base}_${fmtShort(t).replace(/:/g, '-')}.png`, 'png');
  if (!out) return;
  const vf = geomFilters().join(',');
  const r = await api.snapshot({ file: S.file, time: t.toFixed(4), out, vf });
  if (r.ok) { toast('Кадр сохранён'); S.lastOut = out; } else toast('Не удалось сохранить кадр');
}

// ===================== hw detection =====================
api.detectHw().then((hw) => {
  S.hw = hw;
  const names = [];
  if (hw.h264_nvenc) names.push('NVIDIA NVENC');
  if (hw.h264_qsv) names.push('Intel Quick Sync');
  if (hw.h264_amf) names.push('AMD AMF');
  $('#hwInfo').innerHTML = names.length ? `Найдено: <b>${names.join(', ')}</b> — экспорт будет в разы быстрее` : 'Аппаратное ускорение не найдено — будет использован процессор';
  if (!names.length) { $('#hwSeg button[data-v=auto]').disabled = true; S.exp.hw = 'cpu'; syncUI(); }
}).catch(() => { $('#hwInfo').textContent = 'Будет использован процессор'; });

// ===================== global UI wiring =====================
$('#btnOpen').addEventListener('click', openDialog);
$('#btnOpen2').addEventListener('click', (e) => { e.stopPropagation(); openDialog(); });
$('#drop').addEventListener('click', openDialog);
async function openDialog() { const f = await api.openVideo(); if (f) loadFile(f); }
$('#btnPlay').addEventListener('click', togglePlay);
$('#btnStart').addEventListener('click', () => seek(S.edit.segments[0] ? S.edit.segments[0].s : 0));
$('#btnEnd').addEventListener('click', () => { const s = S.edit.segments; seek(s.length ? s[s.length - 1].e : S.duration); });
$('#btnPrevF').addEventListener('click', () => { video.pause(); seek(video.currentTime - 1 / fps()); });
$('#btnNextF').addEventListener('click', () => { video.pause(); seek(video.currentTime + 1 / fps()); });
$('#btnMute').addEventListener('click', () => { S.uiMuted = !S.uiMuted; applyPreviewFilters(); });
$('#btnSnap').addEventListener('click', snapshot);
$('#btnSplit').addEventListener('click', splitAt);
$('#btnDel').addEventListener('click', deleteSel);
$('#btnIn').addEventListener('click', setIn);
$('#btnOut').addEventListener('click', setOut);
$('#btnUndo').addEventListener('click', undo);
$('#btnRedo').addEventListener('click', redo);
$('#btnExport').addEventListener('click', doExport);
$('#btnExportTop').addEventListener('click', () => { selectTab('export'); doExport(); });
$('#zoom').addEventListener('input', (e) => setZoom(+e.target.value));
$('#btnZoomIn').addEventListener('click', () => setZoom(S.zoom * 1.5));
$('#btnZoomOut').addEventListener('click', () => setZoom(S.zoom / 1.5));
$('#btnKeys').addEventListener('click', () => $('#keysModal').classList.remove('hidden'));
$('#keysClose').addEventListener('click', () => $('#keysModal').classList.add('hidden'));
$('#keysModal').addEventListener('click', (e) => { if (e.target.id === 'keysModal') e.currentTarget.classList.add('hidden'); });
video.addEventListener('click', () => { if (!S.cropEdit) togglePlay(); });

// drag & drop
let dragDepth = 0;
document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#drop').classList.add('over'); });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.remove('over'); } });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('#drop').classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) loadFile(api.pathForFile(f));
});

// keyboard
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  const k = e.key.toLowerCase(); const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') { $('#keysModal').classList.add('hidden'); if (!S.exporting) $('#modal').classList.add('hidden'); if (S.cropEdit) { S.cropEdit = false; renderCrop(); } return; }
  if (ctrl && k === 'o') { e.preventDefault(); openDialog(); return; }
  if (!S.file || S.exporting) return;
  if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (ctrl && k === 'e') { e.preventDefault(); selectTab('export'); doExport(); return; }
  if (ctrl) return;
  const code = e.code;
  if (code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (code === 'ArrowLeft') { e.preventDefault(); video.pause(); seek(video.currentTime - (e.shiftKey ? 1 : 1 / fps())); }
  else if (code === 'ArrowRight') { e.preventDefault(); video.pause(); seek(video.currentTime + (e.shiftKey ? 1 : 1 / fps())); }
  else if (code === 'KeyJ') seek(video.currentTime - 5);
  else if (code === 'KeyL') seek(video.currentTime + 5);
  else if (code === 'KeyK') video.pause();
  else if (code === 'KeyI') setIn();
  else if (code === 'KeyO') setOut();
  else if (code === 'KeyS') splitAt();
  else if (code === 'KeyM') { S.uiMuted = !S.uiMuted; applyPreviewFilters(); }
  else if (code === 'Delete' || code === 'Backspace') deleteSel();
  else if (code === 'Home') seek(0);
  else if (code === 'End') seek(S.duration);
  else if (e.key === '+' || e.key === '=') setZoom(S.zoom * 1.5);
  else if (e.key === '-' || e.key === '_') setZoom(S.zoom / 1.5);
  else return;
  if (code.startsWith('Arrow') && e.target.type === 'range') e.target.blur();
});

// tooltips
(function tips() {
  const tip = $('#tip'); let timer, cur;
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el === cur) return;
    cur = el; clearTimeout(timer); tip.classList.remove('show');
    if (!el) return;
    timer = setTimeout(() => {
      tip.textContent = el.dataset.tip;
      const r = el.getBoundingClientRect();
      const tw = tip.offsetWidth;
      let x = clamp(r.left + r.width / 2 - tw / 2, 8, innerWidth - tw - 8);
      let y = r.bottom + 8; if (y + 30 > window.innerHeight) y = r.top - 34;
      tip.style.left = `${x}px`; tip.style.top = `${y}px`; tip.classList.add('show');
    }, 450);
  });
  document.addEventListener('mousedown', () => { clearTimeout(timer); tip.classList.remove('show'); });
})();

$('.side').classList.add('disabled');
syncUI();
