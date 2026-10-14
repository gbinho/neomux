// Minimal scrub timeline: thumbnail strip, playhead, draggable handles and shaded regions.
class Timeline {
  constructor(el, { onSeek, onChange }) {
    this.el = el;
    this.onSeek = onSeek;
    this.onChange = onChange;
    this.duration = 1;
    this.handles = {};
    this.regions = [];
    this.markers = [];
    el.innerHTML = '<div class="tl-track"><div class="tl-thumbs"></div><div class="tl-layers"></div><div class="tl-playhead"></div></div><div class="tl-ruler"></div>';
    this.track = el.querySelector('.tl-track');
    this.thumbs = el.querySelector('.tl-thumbs');
    this.layers = el.querySelector('.tl-layers');
    this.playhead = el.querySelector('.tl-playhead');
    this.ruler = el.querySelector('.tl-ruler');
    this.track.addEventListener('pointerdown', (e) => this.#down(e));
    new ResizeObserver(() => this.#ruler()).observe(el);
  }

  load({ duration, thumbs, handles = {}, regions = [], markers = [] }) {
    this.duration = Math.max(duration, 0.001);
    this.thumbs.style.backgroundImage = thumbs ? `url("${thumbs}")` : 'none';
    this.handles = handles; // { key: { t, label, cls } }
    this.regions = regions; // [{ from: key|number, to: key|number, cls, label }]
    this.markers = markers; // [{ t, cls, label }]
    this.render();
    this.#ruler();
  }

  set(key, t) {
    this.handles[key].t = this.#clamp(t);
    this.render();
    this.onChange?.(key, this.handles[key].t);
  }

  time(t) {
    this.playhead.style.left = `${(this.#clamp(t) / this.duration) * 100}%`;
  }

  render() {
    const pct = (t) => `${(this.#resolve(t) / this.duration) * 100}%`;
    const html = [];
    for (const r of this.regions) {
      const a = Math.min(this.#resolve(r.from), this.#resolve(r.to));
      const b = Math.max(this.#resolve(r.from), this.#resolve(r.to));
      html.push(`<div class="tl-region ${r.cls}" style="left:${pct(a)};width:${((b - a) / this.duration) * 100}%">${r.label ? `<span>${r.label}</span>` : ''}</div>`);
    }
    for (const m of this.markers) html.push(`<div class="tl-marker ${m.cls || ''}" style="left:${pct(m.t)}"><span>${m.label}</span></div>`);
    for (const [key, h] of Object.entries(this.handles)) {
      html.push(`<div class="tl-handle ${h.cls || ''}" data-key="${key}" style="left:${pct(h.t)}"><span>${h.label}</span></div>`);
    }
    this.layers.innerHTML = html.join('');
  }

  #resolve(t) {
    return typeof t === 'string' ? this.handles[t].t : t;
  }

  #clamp(t) {
    return Math.min(this.duration, Math.max(0, t));
  }

  #at(e) {
    const r = this.track.getBoundingClientRect();
    return this.#clamp(((e.clientX - r.left) / r.width) * this.duration);
  }

  #down(e) {
    const key = e.target.closest('.tl-handle')?.dataset.key;
    this.track.setPointerCapture(e.pointerId);
    const move = (ev) => (key ? this.set(key, this.#at(ev)) : this.onSeek?.(this.#at(ev)));
    move(e);
    const up = () => {
      this.track.removeEventListener('pointermove', move);
      this.track.removeEventListener('pointerup', up);
    };
    this.track.addEventListener('pointermove', move);
    this.track.addEventListener('pointerup', up);
  }

  #ruler() {
    const w = this.el.clientWidth || 600;
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((s) => (s / this.duration) * w >= 70) ?? 1200;
    const ticks = [];
    for (let t = 0; t <= this.duration + 1e-6; t += step) {
      ticks.push(`<span style="left:${(t / this.duration) * 100}%">${fmtTime(t, step < 1)}</span>`);
    }
    this.ruler.innerHTML = ticks.join('');
  }
}

function fmtTime(t, frac = true) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${frac ? s.toFixed(2).padStart(5, '0') : String(Math.floor(s)).padStart(2, '0')}`;
}
