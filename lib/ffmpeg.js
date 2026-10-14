const { spawn } = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

// Every process spawned while handling one request lands in that request's
// job, so cancelling the request (client aborts) can kill all of them.
const jobs = new AsyncLocalStorage();

class CancelledError extends Error {
  constructor() {
    super('Cancelado.');
    this.cancelled = true;
  }
}

function newJob() {
  const job = { children: new Set(), cancelled: false };
  job.cancel = () => {
    job.cancelled = true;
    for (const c of job.children) c.kill();
  };
  return job;
}

function run(bin, args, onLine) {
  return new Promise((resolve, reject) => {
    const job = jobs.getStore();
    if (job?.cancelled) return reject(new CancelledError());
    const p = spawn(bin, args, { windowsHide: true });
    job?.children.add(p);
    let out = '';
    let err = '';
    let partial = '';
    p.stdout.on('data', (d) => {
      if (!onLine) return void (out += d);
      const lines = (partial + d).split('\n');
      partial = lines.pop();
      lines.forEach(onLine);
    });
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      job?.children.delete(p);
      if (job?.cancelled) return reject(new CancelledError());
      code === 0 ? resolve(out) : reject(new Error(`${bin} saiu com código ${code}\n${err.slice(-2000)}`));
    });
  });
}

/**
 * With `onProgress`, ffmpeg reports through `-progress` and the callback gets
 * 0..1 based on `duration` (seconds of output expected).
 */
function ffmpeg(args, { duration, onProgress } = {}) {
  const base = ['-hide_banner', '-y', '-loglevel', 'error'];
  if (!onProgress) return run(ffmpegPath, [...base, ...args]);
  return run(ffmpegPath, [...base, '-progress', 'pipe:1', '-nostats', ...args], (line) => {
    const m = /^out_time_us=(\d+)/.exec(line);
    if (m && duration > 0) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
  }).then((out) => (onProgress(1), out));
}

const STANDARD_RATES = ['24000/1001', '24/1', '25/1', '30000/1001', '30/1', '48/1', '50/1', '60000/1001', '60/1', '120/1', '240/1'];
const toFps = (r) => {
  const [n, d] = r.split('/').map(Number);
  return d ? n / d : n;
};

/**
 * Phones record variable frame rate: the average comes out as something like
 * 29.83. Everything downstream works at a constant rate, so snap to the
 * nearest standard rate when it is close, otherwise keep the nominal rate.
 */
function constantRate(v) {
  const avg = v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate;
  const fps = toFps(avg);
  const nearest = STANDARD_RATES.reduce((a, b) => (Math.abs(toFps(b) - fps) < Math.abs(toFps(a) - fps) ? b : a));
  if (Math.abs(toFps(nearest) - fps) / fps < 0.04) return { rate: nearest, vfr: avg !== nearest && toFps(avg) !== toFps(nearest) };
  return { rate: v.r_frame_rate, vfr: avg !== v.r_frame_rate };
}

async function probe(file) {
  const json = JSON.parse(
    await run(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]),
  );
  const v = json.streams.find((s) => s.codec_type === 'video');
  if (!v) throw new Error('O arquivo não tem faixa de vídeo.');
  const { rate, vfr } = constantRate(v);
  let { width, height } = v;
  const rotation = Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.find((s) => s.rotation != null)?.rotation ?? 0));
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  return {
    duration: Number(json.format.duration ?? v.duration),
    fps: Math.round(toFps(rate) * 1000) / 1000,
    rate,
    vfr,
    // HDR (PQ or HLG, e.g. iPhone footage) must be tone-mapped or it looks washed out in 8-bit.
    hdr: ['smpte2084', 'arib-std-b67'].includes(v.color_transfer),
    width,
    height,
    codec: v.codec_name,
    bitrate: Number(v.bit_rate || json.format.bit_rate) || 0,
  };
}

module.exports = { ffmpeg, probe, ffmpegPath, jobs, newJob, CancelledError };
