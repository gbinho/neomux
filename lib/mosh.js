// Datamosh at the bitstream level, the same trick Avidemux users do by hand:
// encode both sides of the cut as MPEG-4 Part 2 (Xvid-style) with a single
// keyframe each, then splice B onto A *without* B's keyframe. B's P-frames
// (motion vectors + residuals) are then applied to A's last picture, which
// smears A's image along B's motion.
//
// Raw .m4v streams are a sequence of units that each start with 00 00 01 xx.
// MPEG-4 Part 2 forbids start-code emulation inside payloads, so splitting on
// every 00 00 01 is safe. VOPs (frames) use code 0xB6, and the two bits after
// the start code give the coding type: 0 = I, 1 = P, 2 = B, 3 = S.

const VOP = 0xb6;
const VOP_I = 0;

function splitUnits(buf) {
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      starts.push(i);
      i += 2;
    }
  }
  return starts.map((start, k) => ({
    code: buf[start + 3],
    start,
    end: k + 1 < starts.length ? starts[k + 1] : buf.length,
  }));
}

function vops(buf) {
  return splitUnits(buf)
    .filter((u) => u.code === VOP)
    .map((u) => buf.subarray(u.start, u.end));
}

const vopType = (vop) => vop[4] >> 6;

/**
 * @param {Buffer} a  full .m4v stream of the clip before the cut (headers + VOPs)
 * @param {Buffer} b  .m4v stream of the clip after the cut, same encode settings
 * @param {{bloomAt?: number, bloomRepeat?: number}} opts
 *   bloom: repeat one of B's P-frames so its motion keeps accumulating.
 * @returns {{stream: Buffer, aFrames: number, totalFrames: number, droppedKeyframes: number}}
 */
function mosh(a, b, { bloomAt = 0, bloomRepeat = 0 } = {}) {
  const aFrames = vops(a).length;
  const bVops = vops(b);

  let dropped = 0;
  while (bVops.length && vopType(bVops[0]) === VOP_I) {
    bVops.shift();
    dropped++;
  }
  if (bloomRepeat > 0 && bVops[bloomAt]) {
    bVops.splice(bloomAt + 1, 0, ...Array(bloomRepeat).fill(bVops[bloomAt]));
  }

  return {
    stream: Buffer.concat([a, ...bVops]),
    aFrames,
    totalFrames: aFrames + bVops.length,
    droppedKeyframes: dropped,
  };
}

module.exports = { mosh, splitUnits, vops, vopType };
