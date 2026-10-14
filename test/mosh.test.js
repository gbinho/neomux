// End-to-end check: synthetic two-scene clip -> mosh across the scene cut -> render every format.
const assert = require('assert');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { ffmpeg, probe, jobs, newJob } = require('../lib/ffmpeg');
const { vops, vopType } = require('../lib/mosh');
const { prepareSource, moshCut, render, FORMATS } = require('../lib/pipeline');

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neomux-'));
  const src = path.join(dir, 'source.mp4');
  // Scene 1: static test card. Scene 2: a moving zoom — strong motion vectors to smear.
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3',
    '-f', 'lavfi', '-i', 'mandelbrot=size=640x360:rate=30,trim=duration=3',
    '-filter_complex', '[0][1]concat=n=2:v=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src,
  ]);

  const info = await prepareSource(dir, src);
  assert.ok(Math.abs(info.duration - 6) < 0.1, `duration ${info.duration}`);
  assert.ok(info.bitrate > 0, 'source bitrate probed');

  // Effect ends with a clean keyframe 1 s after the cut.
  let meta = await moshCut(dir, src, info, { cutIn: 2, cutOut: 3.2, preRoll: 1, postRoll: 2, effectLength: 1, blockSize: 'classic' });
  let types = vops(await fs.readFile(path.join(dir, 'moshed.m4v'))).map(vopType);
  const keyframes = types.flatMap((t, i) => (t === 0 ? [i] : []));
  assert.deepStrictEqual(keyframes, [0, 30 + 30 - 1], `keyframes at ${keyframes}`);

  for (const blockSize of ['xl', 'classic', 'fine', 'ultra']) {
    meta = await moshCut(dir, src, info, { cutIn: 2, cutOut: 3.2, preRoll: 1, postRoll: 1.5, bloomAt: 5, bloomRepeat: 10, blockSize, smoothing: 3, persistence: 6 });
    types = vops(await fs.readFile(path.join(dir, 'moshed.m4v'))).map(vopType);
    assert.strictEqual(types.filter((t) => t === 0).length, 1, 'only the first keyframe survives');
    assert.strictEqual(meta.frames, 30 + 45 - 1 + 10, `frames ${meta.frames}`);
    console.log(`ok mosh ${blockSize}: working copy ${meta.working.w}x${meta.working.h}`);
  }

  for (const [format, f] of Object.entries(FORMATS)) {
    for (const quality of Object.keys(f.qualities)) {
      const file = await render(dir, src, info, meta, { trimIn: 0.5, trimOut: 2, format, quality, height: quality === 'low' ? 240 : 0 });
      const out = await probe(file);
      assert.ok(Math.abs(out.duration - 1.5) < 0.1, `${format}/${quality} duration ${out.duration}`);
      console.log(`ok ${format}/${quality}: ${out.width}x${out.height} ${out.codec}`);
    }
  }

  // Frames before the mosh point come from the original: a lossless render must match it.
  const lossless = await render(dir, src, info, meta, { trimIn: 0, trimOut: 0.9, format: 'ffv1', quality: 'lossless' });
  const md5 = async (file, vf) =>
    (await ffmpeg(['-i', file, '-vf', `${vf}format=gray`, '-fps_mode', 'passthrough', '-f', 'framemd5', '-']))
      .split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());
  const rendered = await md5(lossless, '');
  const original = await md5(src, 'select=between(n\\,30\\,56),');
  assert.deepStrictEqual(rendered, original.slice(0, rendered.length), 'pre-mosh frames are bit-identical to the original');
  console.log(`ok lossless: ${rendered.length} quadros antes do mosh idênticos ao original`);

  // Phone-style footage: 10-bit HDR (PQ) with a jittery, variable frame rate.
  const phone = path.join(dir, 'phone.mp4');
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4',
    '-vf', "setpts='N/30/TB+0.004*sin(N)/TB'", '-fps_mode', 'vfr',
    '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-x265-params', 'log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
    phone,
  ]);
  const pdir = await fs.mkdtemp(path.join(os.tmpdir(), 'neomux-phone-'));
  const pinfo = await prepareSource(pdir, phone);
  assert.ok(pinfo.hdr, 'HDR detected');
  assert.strictEqual(pinfo.rate, '30/1', `rate snapped to ${pinfo.rate}`);
  const pmeta = await moshCut(pdir, phone, pinfo, { cutIn: 1.5, cutOut: 2.5, preRoll: 1, postRoll: 1 });
  const pfile = await render(pdir, phone, pinfo, pmeta, { trimIn: 0, format: 'h264', quality: 'medium' });
  console.log(`ok HDR/VFR: ${pinfo.fps} fps → ${(await probe(pfile)).duration.toFixed(2)} s`);

  // Cancelling a job kills ffmpeg and leaves no half-written export.
  const job = newJob();
  const outDir = path.join(dir, 'cancel');
  await assert.rejects(
    jobs.run(job, () => render(dir, src, info, meta, { format: 'png', quality: 'lossless' }, { outDir, report: (p) => p > 0 && job.cancel() })),
    (e) => e.cancelled,
  );
  assert.deepStrictEqual(await fs.readdir(outDir), [], 'partial export removed');
  console.log('ok cancel');
  await Promise.all([dir, pdir].map((d) => fs.rm(d, { recursive: true, force: true })));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
