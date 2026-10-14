const $ = (id) => document.getElementById(id);
const video = $('video');
const state = { project: null, mosh: null, step: 'cut' };

const timeline = new Timeline($('timeline'), {
  onSeek: (t) => (video.currentTime = t),
  onChange: (key, t) => {
    video.currentTime = t;
    if (key === 'cutIn' || key === 'cutOut') updateCutHint();
  },
});

// ---------- import ----------
$('pickBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => e.target.files[0] && importFile(e.target.files[0]);
$('newBtn').onclick = () => $('fileInput').click();
for (const ev of ['dragover', 'drop']) {
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'drop' && e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]);
  });
}
document.addEventListener('dragenter', () => $('drop').classList.add('over'));
document.addEventListener('dragleave', (e) => !e.relatedTarget && $('drop').classList.remove('over'));

async function importFile(file) {
  $('drop').classList.remove('over');
  const info = await busy(`Importando ${file.name}`, (progress) =>
    job('/api/import', file, progress, {
      'x-filename': encodeURIComponent(file.name),
      'x-replace': state.project?.id ?? '',
      'Content-Type': 'application/octet-stream',
    }),
  );
  if (!info) return;
  state.project = info;
  state.mosh = null;
  $('fileName').textContent = [info.name, `${info.width}×${info.height}`, `${info.fps} fps`, info.vfr && 'VFR→CFR', info.hdr && 'HDR→SDR'].filter(Boolean).join(' · ');
  $('drop').hidden = true;
  $('editor').hidden = false;
  $('newBtn').hidden = false;
  $('renders').innerHTML = '';
  enterCut({ cutIn: info.duration * 0.4, cutOut: info.duration * 0.5 });
}

// ---------- step 1: cut ----------
function enterCut(cut) {
  state.step = 'cut';
  const p = state.project;
  setSource(`/media/${p.id}/source-preview.mp4`, 'Original');
  timeline.load({
    duration: p.duration,
    thumbs: `/media/${p.id}/source-thumbs.jpg`,
    handles: {
      cutIn: { t: cut.cutIn, label: 'corte', cls: 'h-in' },
      cutOut: { t: cut.cutOut, label: 'volta', cls: 'h-out' },
    },
    regions: [{ from: 'cutIn', to: 'cutOut', cls: 'r-removed', label: 'removido' }],
  });
  markButtons([
    ['Início do corte', 'I', () => timeline.set('cutIn', video.currentTime)],
    ['Fim do corte', 'O', () => timeline.set('cutOut', video.currentTime)],
  ]);
  $('cutPanel').hidden = false;
  $('exportPanel').hidden = true;
  updateCutHint();
  steps();
}

function updateCutHint() {
  const { cutIn, cutOut } = timeline.handles;
  const gap = Math.abs(cutOut.t - cutIn.t);
  $('hint').innerHTML = `O vídeo pula de <b>${fmtTime(Math.min(cutIn.t, cutOut.t))}</b> para <b>${fmtTime(Math.max(cutIn.t, cutOut.t))}</b> (${gap.toFixed(2)} s removidos). O movimento depois do corte vai “escorrer” sobre a imagem de antes. Cortes entre cenas diferentes rendem o efeito mais forte.`;
}

const SMOOTH_LABELS = ['desligada', 'leve', 'média', 'forte', 'máxima'];
const SLIDERS = {
  preRoll: (v) => `${v} s`,
  postRoll: (v) => `${v} s`,
  bloom: (v) => (+v ? `${v}×` : 'desligado'),
  bloomAt: (v) => `${v} quadros após o corte`,
  smoothing: (v) => SMOOTH_LABELS[v],
  persistence: (v) => `${v}/10`,
  effectLength: (v) => (+v ? `após ${v} s` : 'até o fim do trecho'),
};
const syncSlider = (id) => ($(`${id}Out`).textContent = SLIDERS[id]($(id).value));
for (const id of Object.keys(SLIDERS)) {
  $(id).oninput = () => syncSlider(id);
  syncSlider(id);
}

const PRESETS = {
  smooth: { blockSize: 'ultra', refined: true, smoothing: 2, persistence: 2, effectLength: 0, bloom: 0 },
  melt: { blockSize: 'fine', refined: true, smoothing: 2, persistence: 7, effectLength: 0, bloom: 20, postRoll: 10 },
  classic: { blockSize: 'classic', refined: false, smoothing: 0, persistence: 1, effectLength: 0, bloom: 0 },
  chunky: { blockSize: 'xl', refined: false, smoothing: 0, persistence: 4, effectLength: 0, bloom: 10 },
};
$('presets').onclick = (e) => {
  const p = PRESETS[e.target.dataset.preset];
  if (!p) return;
  for (const [k, v] of Object.entries(p)) {
    if (k === 'refined') $(k).checked = v;
    else $(k).value = v;
    if (SLIDERS[k]) syncSlider(k);
  }
  for (const b of $('presets').children) b.classList.toggle('on', b === e.target);
};

$('moshBtn').onclick = async () => {
  const { cutIn, cutOut } = timeline.handles;
  const cut = { cutIn: cutIn.t, cutOut: cutOut.t };
  const meta = await busy('Gerando datamosh', (progress) =>
    job('/api/mosh', JSON.stringify({
      id: state.project.id, ...cut,
      preRoll: +$('preRoll').value, postRoll: +$('postRoll').value,
      bloomAt: +$('bloomAt').value, bloomRepeat: +$('bloom').value,
      blockSize: $('blockSize').value, refined: $('refined').checked,
      smoothing: +$('smoothing').value, persistence: +$('persistence').value,
      effectLength: +$('effectLength').value,
    }), progress),
  );
  if (!meta) return;
  state.mosh = { ...meta, cut };
  enterTrim();
};

// ---------- step 2/3: trim + export ----------
function enterTrim() {
  state.step = 'trim';
  const p = state.project;
  const m = state.mosh;
  setSource(`/media/${p.id}/moshed-preview.mp4?v=${m.version}`, 'Datamosh');
  timeline.load({
    duration: m.duration,
    thumbs: `/media/${p.id}/moshed-thumbs.jpg?v=${m.version}`,
    handles: {
      trimIn: { t: Math.max(0, m.moshAt - 0.5), label: 'entrada', cls: 'h-trim' },
      trimOut: { t: m.duration, label: 'saída', cls: 'h-trim' },
    },
    regions: [{ from: 'trimIn', to: 'trimOut', cls: 'r-keep' }],
    markers: [{ t: m.moshAt, label: 'mosh', cls: 'm-mosh' }],
  });
  markButtons([
    ['Entrada', 'I', () => timeline.set('trimIn', video.currentTime)],
    ['Saída', 'O', () => timeline.set('trimOut', video.currentTime)],
  ]);
  $('hint').innerHTML = 'Arraste <b>entrada</b> e <b>saída</b> para deixar só a transição. A reprodução fica em loop dentro do trecho.';
  $('cutPanel').hidden = true;
  $('exportPanel').hidden = false;
  video.currentTime = timeline.handles.trimIn.t;
  steps();
}

// Formats and qualities come from the server so the two never drift apart.
const QUALITY_NOTES = {
  lossless: 'Matematicamente sem perdas: nenhum detalhe é descartado. Arquivo grande.',
  source: 'Usa o mesmo bitrate do vídeo importado.',
};
fetch('/api/formats').then((r) => r.json()).then((formats) => {
  state.formats = formats;
  $('format').innerHTML = formats.map((f) => `<option value="${f.id}">${f.label}</option>`).join('');
  $('format').onchange = () => {
    const f = formats.find((x) => x.id === $('format').value);
    const prev = $('quality').value;
    $('quality').innerHTML = f.qualities.map((q) => `<option value="${q.id}">${q.label}</option>`).join('');
    if (f.qualities.some((q) => q.id === prev)) $('quality').value = prev;
    else if (f.qualities.some((q) => q.id === 'high')) $('quality').value = 'high';
    $('quality').onchange();
  };
  $('quality').onchange = () => {
    const near = ['prores', 'dnxhr'].includes($('format').value) && $('quality').value === 'lossless';
    $('qualityNote').textContent = near ? 'Qualidade visual máxima (praticamente sem perdas), aceita em qualquer editor.' : QUALITY_NOTES[$('quality').value] || '';
  };
  $('format').onchange();
});

$('backBtn').onclick = () => enterCut(state.mosh.cut);

$('renderBtn').onclick = async () => {
  const { trimIn, trimOut } = timeline.handles;
  state.step = 'export';
  steps();
  const out = await busy('Exportando vídeo', (progress) =>
    job('/api/render', JSON.stringify({
      id: state.project.id,
      trimIn: Math.min(trimIn.t, trimOut.t), trimOut: Math.max(trimIn.t, trimOut.t),
      format: $('format').value, quality: $('quality').value,
      height: +$('height').value, fps: +$('fps').value,
      name: `${state.project.name}_mosh`,
    }), progress),
  );
  state.step = 'trim';
  steps();
  if (!out) return;
  const li = document.createElement('li');
  li.innerHTML = `<span class="r-name"></span><span class="r-size">${(out.size / 1048576).toFixed(1)} MB</span>
    <a class="ghost btn" href="${out.url}?download">Baixar</a><button class="ghost">Mostrar na pasta</button>`;
  li.querySelector('.r-name').textContent = out.file;
  li.querySelector('button').onclick = () => api('/api/reveal', JSON.stringify({ file: out.file }));
  li.title = `Salvo em ${out.folder}`;
  $('renders').prepend(li);
  toast(`Pronto! Salvo em ${out.folder}`);
};

// ---------- player ----------
function setSource(src, badge) {
  video.pause();
  video.src = src;
  $('stageBadge').textContent = badge;
  $('stageBadge').className = `stage-badge ${badge === 'Datamosh' ? 'hot' : ''}`;
}

$('playBtn').onclick = togglePlay;
video.onclick = togglePlay;
function togglePlay() {
  if (video.paused) {
    if (state.step !== 'cut') {
      const { trimIn, trimOut } = timeline.handles;
      const [a, b] = [Math.min(trimIn.t, trimOut.t), Math.max(trimIn.t, trimOut.t)];
      if (video.currentTime < a || video.currentTime >= b - 0.05) video.currentTime = a;
    }
    video.play();
  } else video.pause();
}
video.onplay = () => ($('playBtn').textContent = '❚❚');
video.onpause = () => ($('playBtn').textContent = '▶');

(function tick() {
  timeline.time(video.currentTime);
  $('timecode').textContent = fmtTime(video.currentTime);
  if (state.step !== 'cut' && !video.paused) {
    const { trimIn, trimOut } = timeline.handles;
    const [a, b] = [Math.min(trimIn.t, trimOut.t), Math.max(trimIn.t, trimOut.t)];
    if (video.currentTime >= b) video.currentTime = a;
  }
  requestAnimationFrame(tick);
})();

function markButtons(items) {
  $('markButtons').innerHTML = '';
  state.keys = {};
  for (const [label, key, fn] of items) {
    const b = document.createElement('button');
    b.className = 'ghost';
    b.innerHTML = `${label} <kbd>${key}</kbd>`;
    b.onclick = fn;
    $('markButtons').append(b);
    state.keys[key.toLowerCase()] = fn;
  }
}

document.addEventListener('keydown', (e) => {
  if (!state.project || /INPUT|SELECT/.test(e.target.tagName) || !$('busy').hidden) return;
  const k = e.key.toLowerCase();
  const frame = 1 / state.project.fps;
  if (k === ' ') togglePlay();
  else if (k === 'arrowleft') video.currentTime -= e.shiftKey ? 1 : frame;
  else if (k === 'arrowright') video.currentTime += e.shiftKey ? 1 : frame;
  else if (state.keys?.[k]) state.keys[k]();
  else return;
  e.preventDefault();
});

// ---------- helpers ----------
function steps() {
  const order = ['cut', 'trim', 'export'];
  const i = order.indexOf(state.step);
  for (const li of $('steps').children) {
    const j = order.indexOf(li.dataset.step);
    li.className = j === i ? 'active' : j < i ? 'done' : '';
  }
}

async function api(url, body, headers = { 'Content-Type': 'application/json' }) {
  const res = await fetch(url, { method: 'POST', body, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

/**
 * Long job with live progress: XHR so the upload can be measured, then the
 * server's NDJSON lines ({progress,label} … {result}|{error}) as they arrive.
 */
function job(url, body, progress, headers = { 'Content-Type': 'application/json' }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    state.xhr = xhr;
    xhr.open('POST', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    if (body instanceof Blob) {
      xhr.upload.onprogress = (e) => e.lengthComputable && progress(e.loaded / e.total, 'Enviando arquivo…', `${mb(e.loaded)} de ${mb(e.total)}`);
      xhr.upload.onload = () => progress(0, 'Lendo o vídeo…');
    }
    let seen = 0;
    let settled = false;
    const consume = () => {
      const lines = xhr.responseText.slice(seen).split('\n');
      const rest = lines.pop();
      seen = xhr.responseText.length - rest.length;
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if ('progress' in msg) progress(msg.progress, msg.label);
        else if (!settled) {
          settled = true;
          msg.error ? reject(new Error(msg.error)) : resolve(msg.result);
        }
      }
    };
    xhr.onprogress = consume;
    xhr.onload = () => {
      consume();
      if (!settled) reject(new Error(xhr.status >= 400 ? `Erro ${xhr.status}` : 'Resposta incompleta do servidor.'));
    };
    xhr.onerror = () => reject(new Error('Falha de conexão com o NeoMux.'));
    xhr.onabort = () => reject(Object.assign(new Error('Operação cancelada.'), { cancelled: true }));
    xhr.send(body);
  });
}

const mb = (b) => `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`;

async function busy(title, fn) {
  $('busyTitle').textContent = title;
  let label = null;
  let started = performance.now();
  let from = 0;
  let last = 0;
  const set = (p, text, detail) => {
    if (text) label = text;
    if (p < last - 0.05) {
      // A new phase restarted the bar: measure the ETA from here.
      started = performance.now();
      from = p;
    }
    last = p;
    const pct = Math.max(0, Math.min(100, p * 100));
    const elapsed = (performance.now() - started) / 1000;
    const rate = (p - from) / elapsed;
    const eta = p - from > 0.03 && p < 1 && elapsed > 1 ? `falta ~${fmtEta((1 - p) / rate)}` : '';
    $('busyLabel').textContent = label ?? '';
    $('busyBar').style.width = `${pct}%`;
    $('busyPct').textContent = `${Math.floor(pct)}%`;
    $('busyDetail').textContent = [detail, eta].filter(Boolean).join(' · ');
  };
  set(0, 'Iniciando…');
  $('busy').hidden = false;
  try {
    return await fn(set);
  } catch (e) {
    toast(e.message, !e.cancelled && e.message !== 'Cancelado.');
  } finally {
    state.xhr = null;
    $('busy').hidden = true;
  }
}

function fmtEta(sec) {
  return sec < 60 ? `${Math.ceil(sec)} s` : `${Math.floor(sec / 60)} min ${String(Math.round(sec % 60)).padStart(2, '0')} s`;
}

function toast(msg, error) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${error ? 'error' : ''}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), error ? 7000 : 3500);
}

// Cancel aborts the request; the server notices and kills its ffmpeg processes.
$('cancelBtn').onclick = () => state.xhr?.abort();
document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('busy').hidden && state.xhr?.abort());

// Imports and intermediates only live while the window is open: tell the server when it closes.
window.addEventListener('pagehide', () => {
  if (state.project) navigator.sendBeacon('/api/close', new Blob([JSON.stringify({ id: state.project.id })], { type: 'application/json' }));
});
