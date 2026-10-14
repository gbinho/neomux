const fs = require('fs/promises');
const path = require('path');
const { ffmpeg, probe } = require('./ffmpeg');
const { mosh } = require('./mosh');

const THUMBS = 40;
const PREVIEW_HEIGHT = 540;
const MAX_INTERMEDIATE = 4096; // longest side of the MPEG-4 working copy

// Block size: MPEG-4 moves 16×16 (or 8×8 with mv4) pixel blocks. Encoding the
// working copy bigger than the source makes those blocks proportionally
// smaller once scaled back down, which is what makes the smear look smooth
// instead of chunky. Smaller than 1 exaggerates the classic blocky look.
const BLOCK_SCALE = { xl: 0.5, classic: 1, fine: 1.5, ultra: 2 };

// Persistence = quantizer of the clip after the cut. Coarser residuals rebuild
// the new image more slowly, so the old picture sticks around for longer.
const PERSISTENCE_Q = [2, 3, 4, 5, 7, 9, 12, 15, 19, 24, 31];

// Smoothing runs on the working copy (where the blocks are) before scaling.
const SMOOTH = [
  null,
  'deblock=filter=weak:block=8',
  'deblock=filter=strong:block=8',
  'deblock=filter=strong:block=8,spp=quality=4',
  'deblock=filter=strong:block=16,spp=quality=6,gblur=sigma=0.8',
];

async function thumbs(input, duration, out, inputArgs = [], vf = '') {
  const rate = Math.max(THUMBS / Math.max(duration, 0.1), 0.01);
  await ffmpeg([...inputArgs, '-i', input, '-vf', `${vf}fps=${rate},scale=-2:72,tile=${THUMBS}x1`, '-frames:v', '1', '-q:v', '5', out]);
}

async function preview(input, out, inputArgs = [], vf = '', progress) {
  await ffmpeg([
    ...inputArgs, '-i', input, '-an',
    '-vf', `${vf}scale=-2:'min(${PREVIEW_HEIGHT},ih)'`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-g', '10', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', out,
  ], progress);
}

const noop = () => {};

// PQ/HLG → SDR BT.709 before anything touches 8-bit, so phone HDR clips keep their colours.
const toSdr = (info) =>
  info.hdr
    ? 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,'
    : '';

/** Probes an imported file and builds the browser-friendly proxy + thumbnail strip. */
async function prepareSource(dir, sourceFile, report = noop) {
  const info = await probe(sourceFile);
  report(0, 'Preparando pré-visualização…');
  await Promise.all([
    preview(sourceFile, path.join(dir, 'source-preview.mp4'), [], toSdr(info), {
      duration: info.duration,
      onProgress: (p) => report(p, 'Preparando pré-visualização…'),
    }),
    thumbs(sourceFile, info.duration, path.join(dir, 'source-thumbs.jpg'), [], toSdr(info)),
  ]);
  await fs.writeFile(path.join(dir, 'source.json'), JSON.stringify(info));
  return info;
}

function workingSize(info, blockSize) {
  let scale = BLOCK_SCALE[blockSize] ?? 1;
  scale = Math.min(scale, MAX_INTERMEDIATE / Math.max(info.width, info.height));
  const even = (n) => Math.max(16, Math.round((n * scale) / 2) * 2);
  return { w: even(info.width), h: even(info.height) };
}

function mpeg4Args({ q, refined, keyframeAt }) {
  return [
    '-an', '-c:v', 'mpeg4', '-qmin', '1', '-q:v', String(q),
    '-bf', '0', '-g', '100000', '-sc_threshold', '1000000000',
    // mv4 = one vector per 8×8 block instead of 16×16; qpel = quarter-pixel vectors.
    ...(refined ? ['-flags', '+mv4+qpel', '-mbd', 'rd', '-trellis', '1', '-cmp', 'rd', '-subcmp', 'rd'] : []),
    ...(keyframeAt ? ['-force_key_frames', keyframeAt.toFixed(3)] : []),
    '-pix_fmt', 'yuv420p', '-f', 'm4v',
  ];
}

async function encodeSegment(src, info, size, start, end, out, opts, onProgress) {
  await ffmpeg([
    '-ss', start.toFixed(3), '-i', src, '-t', (end - start).toFixed(3),
    '-vf', `${toSdr(info)}fps=${info.rate},scale=${size.w}:${size.h}:flags=bicubic,setsar=1`,
    ...mpeg4Args(opts), out,
  ], { duration: end - start, onProgress });
}

/**
 * A = [cutIn - preRoll, cutIn], B = [cutOut, cutOut + postRoll]. Everything
 * between cutIn and cutOut is removed and B's keyframe is dropped at the join.
 */
async function moshCut(dir, sourceFile, info, opts, report = noop) {
  let { cutIn, cutOut } = opts;
  const {
    preRoll = 2, postRoll = 4, bloomAt = 0, bloomRepeat = 0,
    blockSize = 'fine', refined = true, persistence = 2, smoothing = 1, effectLength = 0,
  } = opts;
  cutIn = clamp(cutIn, 0, info.duration);
  cutOut = clamp(cutOut, 0, info.duration);
  if (cutOut < cutIn) [cutIn, cutOut] = [cutOut, cutIn];
  const aStart = Math.max(0, cutIn - preRoll);
  const bEnd = Math.min(info.duration, cutOut + postRoll);
  const minLen = 2 / info.fps;
  if (cutIn - aStart < minLen) throw new Error('Deixe pelo menos alguns quadros antes do corte.');
  if (bEnd - cutOut < minLen) throw new Error('Deixe pelo menos alguns quadros depois do corte.');

  const size = workingSize(info, blockSize);
  const aFile = path.join(dir, 'a.m4v');
  const bFile = path.join(dir, 'b.m4v');
  const bQ = PERSISTENCE_Q[clamp(Math.round(persistence), 0, PERSISTENCE_Q.length - 1)];
  // A keyframe inside B ends the effect cleanly after `effectLength` seconds.
  const keyframeAt = effectLength > 0 && effectLength < bEnd - cutOut ? effectLength : 0;
  // Progress: encoding both sides is the first half, building the preview the second.
  const done = [0, 0];
  const lens = [cutIn - aStart, bEnd - cutOut];
  const encoded = (i) => (p) => {
    done[i] = p;
    report((0.5 * (done[0] * lens[0] + done[1] * lens[1])) / (lens[0] + lens[1]), 'Codificando os dois lados do corte…');
  };
  await Promise.all([
    encodeSegment(sourceFile, info, size, aStart, cutIn, aFile, { q: 1, refined }, encoded(0)),
    encodeSegment(sourceFile, info, size, cutOut, bEnd, bFile, { q: bQ, refined, keyframeAt }, encoded(1)),
  ]);
  const result = mosh(await fs.readFile(aFile), await fs.readFile(bFile), { bloomAt, bloomRepeat });
  if (!result.droppedKeyframes) throw new Error('Não encontrei o quadro-chave do segundo trecho.');
  const moshed = path.join(dir, 'moshed.m4v');
  await fs.writeFile(moshed, result.stream);

  const smooth = SMOOTH[clamp(Math.round(smoothing), 0, SMOOTH.length - 1)];
  const vf = smooth ? `${smooth},` : '';
  const rawIn = ['-f', 'm4v', '-r', info.rate];
  const duration = result.totalFrames / info.fps;
  await Promise.all([
    preview(moshed, path.join(dir, 'moshed-preview.mp4'), rawIn, vf, {
      duration,
      onProgress: (p) => report(0.5 + 0.5 * p, 'Montando a pré-visualização do mosh…'),
    }),
    thumbs(moshed, duration, path.join(dir, 'moshed-thumbs.jpg'), rawIn, vf),
  ]);
  const meta = {
    duration, frames: result.totalFrames, moshAt: result.aFrames / info.fps, aStart,
    fps: info.fps, rate: info.rate, smooth, working: size, version: Date.now(),
  };
  await fs.writeFile(path.join(dir, 'moshed.json'), JSON.stringify(meta));
  return meta;
}

// Each quality maps to encoder args. `source` targets the original file's bitrate.
const FORMATS = {
  h264: {
    label: 'MP4 · H.264', ext: 'mp4',
    qualities: {
      lossless: ['Sem perdas (H.264 4:4:4)', () => ['-c:v', 'libx264', '-preset', 'slow', '-qp', '0', '-pix_fmt', 'yuv444p']],
      source: ['Bitrate do original', (br) => ['-c:v', 'libx264', '-preset', 'slow', ...vbr(br), '-pix_fmt', 'yuv420p']],
      high: ['Alta', () => ['-c:v', 'libx264', '-preset', 'slow', '-crf', '12', '-pix_fmt', 'yuv420p']],
      medium: ['Média', () => ['-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p']],
      low: ['Leve', () => ['-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p']],
    },
    extra: ['-movflags', '+faststart'],
  },
  prores: {
    label: 'MOV · ProRes', ext: 'mov',
    qualities: {
      lossless: ['4444 XQ (máxima)', () => ['-c:v', 'prores_ks', '-profile:v', '5', '-pix_fmt', 'yuv444p10le']],
      high: ['422 HQ', () => ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le']],
      medium: ['422', () => ['-c:v', 'prores_ks', '-profile:v', '2', '-pix_fmt', 'yuv422p10le']],
      low: ['422 LT', () => ['-c:v', 'prores_ks', '-profile:v', '1', '-pix_fmt', 'yuv422p10le']],
    },
    extra: ['-vendor', 'apl0'],
  },
  dnxhr: {
    label: 'MOV · DNxHR', ext: 'mov',
    qualities: {
      lossless: ['444 (máxima)', () => ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_444', '-pix_fmt', 'yuv444p10le']],
      high: ['HQ', () => ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_hq', '-pix_fmt', 'yuv422p']],
      medium: ['SQ', () => ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_sq', '-pix_fmt', 'yuv422p']],
      low: ['LB', () => ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_lb', '-pix_fmt', 'yuv422p']],
    },
  },
  png: {
    label: 'MOV · PNG (sem perdas)', ext: 'mov',
    qualities: { lossless: ['Sem perdas (RGB)', () => ['-c:v', 'png', '-pix_fmt', 'rgb24']] },
  },
  ffv1: {
    label: 'MKV · FFV1 (sem perdas)', ext: 'mkv',
    qualities: { lossless: ['Sem perdas', () => ['-c:v', 'ffv1', '-level', '3', '-g', '1', '-slicecrc', '1', '-pix_fmt', 'yuv444p']] },
  },
  vp9: {
    label: 'WebM · VP9', ext: 'webm',
    qualities: {
      lossless: ['Sem perdas', () => ['-c:v', 'libvpx-vp9', '-lossless', '1', '-row-mt', '1', '-pix_fmt', 'yuv444p']],
      source: ['Bitrate do original', (br) => ['-c:v', 'libvpx-vp9', ...vbr(br), '-row-mt', '1', '-pix_fmt', 'yuv420p']],
      high: ['Alta', () => ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '18', '-row-mt', '1', '-pix_fmt', 'yuv420p']],
      medium: ['Média', () => ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '28', '-row-mt', '1', '-pix_fmt', 'yuv420p']],
    },
  },
};

function vbr(br) {
  const b = Math.max(1e6, Number(br) || 20e6);
  return ['-b:v', String(Math.round(b)), '-maxrate', String(Math.round(b * 1.5)), '-bufsize', String(Math.round(b * 2))];
}

const formatCatalog = () =>
  Object.entries(FORMATS).map(([id, f]) => ({
    id, label: f.label,
    qualities: Object.entries(f.qualities).map(([q, [label]]) => ({ id: q, label })),
  }));

/**
 * Frames before the mosh point are taken straight from the original file, so
 * only the moshed part goes through the MPEG-4 working copy.
 */
async function render(dir, sourceFile, info, meta, opts, { report = noop, outDir = path.join(dir, 'renders') } = {}) {
  let { trimIn = 0, trimOut } = opts;
  const { format = 'h264', quality = 'high', height = 0, fps = 0, name = 'neomux' } = opts;
  const fmt = FORMATS[format];
  const q = fmt?.qualities[quality];
  if (!q) throw new Error('Formato de saída inválido.');
  trimIn = clamp(trimIn, 0, meta.duration);
  trimOut = clamp(trimOut ?? meta.duration, trimIn, meta.duration);
  if (trimOut - trimIn < 1 / meta.fps) throw new Error('O trecho aparado está vazio.');

  const outH = Number(height) || info.height;
  const outW = Math.round((info.width * outH) / info.height / 2) * 2;
  const fit = `scale=${outW}:${outH}:flags=lanczos,setsar=1`;
  const smooth = meta.smooth ? `${meta.smooth},` : '';
  const moshStart = Math.max(trimIn, meta.moshAt);
  const fromSource = meta.moshAt - trimIn > 0.5 / meta.fps;

  const inputs = [];
  const graph = [];
  if (fromSource) {
    inputs.push('-ss', (meta.aStart + trimIn).toFixed(3), '-t', (Math.min(meta.moshAt, trimOut) - trimIn).toFixed(3), '-i', sourceFile);
    graph.push(`[0:v]${toSdr(info)}fps=${meta.rate},${fit},format=yuv444p[a]`);
  }
  const m = fromSource ? 1 : 0;
  inputs.push('-f', 'm4v', '-r', meta.rate, '-i', path.join(dir, 'moshed.m4v'));
  if (trimOut > moshStart) {
    graph.push(`[${m}:v]trim=start=${moshStart.toFixed(4)}:end=${trimOut.toFixed(4)},setpts=PTS-STARTPTS,${smooth}${fit},format=yuv444p[b]`);
  }
  const parts = [fromSource && '[a]', trimOut > moshStart && '[b]'].filter(Boolean);
  const post = fps ? `,fps=${Number(fps)}` : '';
  graph.push(parts.length > 1 ? `${parts.join('')}concat=n=2:v=1:a=0${post}[out]` : `${parts[0]}null${post}[out]`);

  await fs.mkdir(outDir, { recursive: true });
  const safe = String(name).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'neomux';
  const file = path.join(outDir, `${safe}_${quality}_${stamp()}.${fmt.ext}`);
  try {
    await ffmpeg([
      ...inputs, '-filter_complex', graph.join(';'), '-map', '[out]',
      '-an', ...q[1](info.bitrate), ...(fmt.extra ?? []), file,
    ], { duration: trimOut - trimIn, onProgress: (p) => report(p, `Renderizando ${fmt.label}…`) });
  } catch (e) {
    await fs.rm(file, { force: true }); // never leave a half-written export behind
    throw e;
  }
  return file;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

module.exports = { prepareSource, moshCut, render, formatCatalog, FORMATS };
