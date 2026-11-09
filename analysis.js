// BPM & key detection. JavaScript port of the analysis in server.py; both must give the same results.
// Input: mono Float32Array at SR (22050 Hz). Works in the browser and in Node (for testing).
(function (root) {
  const SR = 22050;
  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
  // Key profiles (major, minor): Krumhansl-Kessler, Temperley, and Faraldo's EDM profile. Scores are summed.
  const PROFILES = [
    [[6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
     [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]],
    [[5, 2, 3.5, 2, 4.5, 4, 2, 4.5, 2, 3.5, 1.5, 4],
     [5, 2, 3.5, 4.5, 2, 4, 2, 4.5, 3.5, 2, 1.5, 4]],
    [[.1652, .0475, .0829, .0669, .0999, .0927, .0529, .1316, .0522, .0744, .0694, .0643],
     [.1724, .0400, .0761, .1210, .0534, .0937, .0513, .1347, .0941, .0387, .0765, .0482]],
  ];
  const BASS_WEIGHT = 0.6;    // extra weight of notes under 250 Hz (bass / 808) in the key profile match
  const THIRD_WEIGHT = 0.02;  // how much the minor-vs-major third evidence nudges near ties
  const UNSURE_MARGIN = 0.05;

  // ---------- FFT ----------
  const tables = {};
  function fftTables(n) {
    if (tables[n]) return tables[n];
    const bits = Math.log2(n), rev = new Uint32Array(n), win = new Float64Array(n);
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
      win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));  // same as numpy.hanning
    }
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
    return (tables[n] = { rev, win, cos, sin, re: new Float64Array(n), im: new Float64Array(n) });
  }

  // Magnitude spectrogram: array of frames, each Float64Array of n/2+1 bins (like numpy rfft)
  function stftMag(x, n, hop) {
    const { rev, win, cos, sin, re, im } = fftTables(n);
    const frames = 1 + Math.floor((x.length - n) / hop), out = [];
    for (let f = 0; f < frames; f++) {
      const start = f * hop;
      for (let i = 0; i < n; i++) { re[rev[i]] = x[start + i] * win[i]; im[rev[i]] = 0; }
      for (let size = 2; size <= n; size *= 2) {
        const half = size / 2, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = 0; j < half; j++) {
            const k = j * step, a = i + j, b = a + half;
            const tr = re[b] * cos[k] - im[b] * sin[k], ti = re[b] * sin[k] + im[b] * cos[k];
            re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          }
        }
      }
      const mag = new Float64Array(n / 2 + 1);
      for (let i = 0; i <= n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
      out.push(mag);
    }
    return out;
  }

  // ---------- Tempo ----------
  function detectBpm(x) {
    const n = 1024, hop = 256, fps = SR / hop;
    const mag = stftMag(x, n, hop);
    const logmag = mag.map(m => m.map(v => Math.log1p(100 * v)));
    const flux = new Float64Array(logmag.length - 1);
    for (let f = 1; f < logmag.length; f++) {
      let s = 0;
      for (let k = 0; k < logmag[f].length; k++) { const d = logmag[f][k] - logmag[f - 1][k]; if (d > 0) s += d; }
      flux[f - 1] = s;
    }
    // Remove slow trend (local mean over ~0.5 s) and half-wave rectify
    const w = Math.floor(fps * 0.5) | 1, h = (w - 1) / 2, env = new Float64Array(flux.length);
    for (let i = 0; i < flux.length; i++) {
      let s = 0;
      for (let j = Math.max(0, i - h); j <= Math.min(flux.length - 1, i + h); j++) s += flux[j];
      env[i] = Math.max(0, flux[i] - s / w);
    }
    // Autocorrelation of the onset envelope
    const maxLag = Math.min(Math.floor(fps * 60 / 40) * 4 + 2, env.length);
    const acf = new Float64Array(maxLag);
    for (let lag = 0; lag < maxLag; lag++) {
      let s = 0;
      for (let i = 0; i + lag < env.length; i++) s += env[i] * env[i + lag];
      acf[lag] = s;
    }
    const at = (l) => {
      if (l >= maxLag - 1) return acf[maxLag - 1];
      const i = Math.floor(l), t = l - i;
      return acf[i] * (1 - t) + acf[i + 1] * t;
    };
    // Score candidate tempos with a comb over beat multiples, weighted by a tempo prior around 120 BPM
    let best = 0, bestScore = -Infinity;
    for (let i = 0; i <= 1400; i++) {
      const bpm = 60 + 0.1 * i, lag = fps * 60 / bpm;
      let s = 0;
      for (let k = 1; k <= 4; k++) s += at(k * lag);
      s *= Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
      if (s > bestScore) { bestScore = s; best = bpm; }
    }
    return Math.round(best);
  }

  // ---------- Key ----------
  function median31(row, k, buf) {
    // Median of row[k-15 .. k+15] with edge padding
    const last = row.length - 1;
    for (let j = 0; j < 31; j++) buf[j] = row[Math.min(last, Math.max(0, k - 15 + j))];
    buf.sort();
    return buf[15];
  }

  // Pitch-class energy from tonal spectral peaks only (drums/noise mostly ignored), tuning-corrected
  function tonalChroma(x) {
    const n = 8192, hop = 2048;
    const mag = stftMag(x, n, hop);
    const midis = [], weights = [], freqs = [];
    const buf = new Float64Array(31);
    for (const row of mag) {
      for (let k = 1; k < row.length - 1; k++) {
        const f = k * SR / n;
        if (f < 50 || f > 3000) continue;
        if (!(row[k] > row[k - 1] && row[k] >= row[k + 1])) continue;
        const med = median31(row, k, buf);
        if (!(row[k] > 3 * med)) continue;
        // Parabolic interpolation for a precise peak frequency
        const a = Math.log(row[k - 1] + 1e-9), b = Math.log(row[k] + 1e-9), c = Math.log(row[k + 1] + 1e-9);
        const freq = (k + 0.5 * (a - c) / (a - 2 * b + c)) * SR / n;
        freqs.push(freq);
        midis.push(69 + 12 * Math.log2(freq / 440));
        weights.push(Math.log1p(row[k] / med));
      }
    }
    // Songs are not always tuned to A=440; estimate the offset and compensate
    let sr = 0, si = 0;
    for (let i = 0; i < midis.length; i++) {
      const d = 2 * Math.PI * (midis[i] - Math.round(midis[i]));
      sr += weights[i] * Math.cos(d); si += weights[i] * Math.sin(d);
    }
    const tuning = Math.atan2(si, sr) / (2 * Math.PI);
    const full = new Float64Array(12), bass = new Float64Array(12);
    for (let i = 0; i < midis.length; i++) {
      const pc = ((Math.round(midis[i] - tuning) % 12) + 12) % 12;
      full[pc] += weights[i];
      if (freqs[i] < 250) bass[pc] += weights[i];
    }
    const norm = (v) => { const s = v.reduce((a, b) => a + b, 0); return v.map(e => e / Math.max(s, 1e-9)); };
    return [norm(full), norm(bass)];
  }

  function pearson(a, b) {
    const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return num / Math.sqrt(da * db);
  }

  function keyName(tonic, minor) {
    return minor
      ? [`${NOTES[tonic]} minor`, `${CAMELOT_MAJOR[(tonic + 3) % 12]}A`]
      : [`${NOTES[tonic]} major`, `${CAMELOT_MAJOR[tonic]}B`];
  }

  function detectKey(x) {
    const [full, bass] = tonalChroma(x);
    const chroma = full.map((v, i) => v + BASS_WEIGHT * bass[i]);
    const thirdSrc = full.map((v, i) => v + bass[i]);
    const scores = [];  // index = tonic * 2 + (0 major / 1 minor)
    for (let tonic = 0; tonic < 12; tonic++) {
      const rotated = Array.from({ length: 12 }, (_, i) => chroma[(i + tonic) % 12]);
      let major = 0, minor = 0;
      for (const [M, m] of PROFILES) { major += pearson(rotated, M); minor += pearson(rotated, m); }
      // Minor third vs major third above the tonic decides close major/minor calls
      const m3 = thirdSrc[(tonic + 3) % 12], M3 = thirdSrc[(tonic + 4) % 12];
      const nudge = THIRD_WEIGHT * (m3 - M3) / Math.max(m3 + M3, 1e-9);
      scores.push(major - nudge, minor + nudge);
    }
    const order = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a]);
    const [key, camelot] = keyName(order[0] >> 1, order[0] & 1);
    const result = { key, camelot };
    if (scores[order[0]] - scores[order[1]] < UNSURE_MARGIN) result.alt = keyName(order[1] >> 1, order[1] & 1)[0];
    return result;
  }

  function analyzeSamples(x) {
    return { bpm: detectBpm(x), ...detectKey(x) };
  }

  const api = { SR, analyzeSamples, detectBpm, detectKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Analysis = api;
})(this);
