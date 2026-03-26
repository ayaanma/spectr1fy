'use strict';

/* ──────────────────────────────────────────────────────────
   RATE LIMITING
   ────────────────────────────────────────────────────────── */
const MIN_POLL_INTERVAL_MS = 10000; // Last.fm: poll every 10 s
let   lastPollTime         = 0;

const BASE_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS  = 60000;
let   backoffMs       = 0;
let   backoffUntil    = 0;

function isBackingOff() { return Date.now() < backoffUntil; }
function applyBackoff() {
  backoffMs    = backoffMs === 0 ? BASE_BACKOFF_MS : Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  backoffUntil = Date.now() + backoffMs;
}
function resetBackoff() { backoffMs = 0; backoffUntil = 0; }

/* ──────────────────────────────────────────────────────────
   LAST.FM AUTH
   ────────────────────────────────────────────────────────── */
function login() {
  window.location.href = '/api/lastfm/login';
}

async function lastfmExchangeToken(token) {
  let res;
  try {
    res = await fetch('/api/lastfm/session?token=' + encodeURIComponent(token));
  } catch {
    return false;
  }

  if (!res.ok) return false;

  const data = await res.json().catch(() => null);
  if (data?.session?.key) {
    localStorage.setItem('lfm_sk', data.session.key);
    localStorage.setItem('lfm_user', data.session.name);
    window.history.replaceState({}, '', window.location.pathname);
    return true;
  }
  return false;
}

function isLoggedIn() {
  return !!localStorage.getItem('lfm_sk');
}

function logout() {
  localStorage.removeItem('lfm_sk');
  localStorage.removeItem('lfm_user');
  location.reload();
}

/* ──────────────────────────────────────────────────────────
   COLOR HELPERS
   ────────────────────────────────────────────────────────── */
function parseRgb(str) {
  if (!str) return '128,128,128';
  if (str.startsWith('#')) {
    let h = str.slice(1);
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    return [
      parseInt(h.slice(0,2), 16),
      parseInt(h.slice(2,4), 16),
      parseInt(h.slice(4,6), 16),
    ].join(',');
  }
  const m = str.match(/\d+/g);
  return m ? m.slice(0,3).join(',') : '128,128,128';
}

/* ──────────────────────────────────────────────────────────
   PALETTE EXTRACTION
   Reads pixel data from the album art canvas to derive a
   4-color palette that drives the wave colours.
   ────────────────────────────────────────────────────────── */
let palette = [
  'rgb(167,139,250)',
  'rgb(96,165,250)',
  'rgb(52,211,153)',
  'rgb(244,114,182)',
];

function extractPalette(img) {
  try {
    const SZ = 80;
    const c  = Object.assign(document.createElement('canvas'), { width: SZ, height: SZ });
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0, SZ, SZ);
    const { data } = cx.getImageData(0, 0, SZ, SZ);

    let totalSat = 0, count = 0;
    const all = [];

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
      if (a < 200) continue;
      const mx  = Math.max(r,g,b)/255, mn = Math.min(r,g,b)/255;
      const sat = mx === 0 ? 0 : (mx-mn)/mx;
      const lum = (mx+mn)/2;
      totalSat += sat; count++;
      all.push({ r, g, b, sat, lum });
    }

    if (!count) return;
    const avgSat = totalSat / count;
    const avgLum = all.reduce((s, p) => s + p.lum, 0) / count;

    // ── Pure black cover ─────────────────────────────────────────────────────
    if (avgLum < 0.04 && avgSat < 0.04) {
      palette = [
        'rgb(210,210,210)',
        'rgb(150,150,150)',
        'rgb(90,90,90)',
        'rgb(50,50,50)',
      ];
      return;
    }

    // ── Greyscale / monochrome cover ─────────────────────────────────────────
    if (avgSat < 0.09) {
      all.sort((a,b) => b.lum - a.lum);
      const n = all.length;
      palette = [0.05, 0.28, 0.55, 0.80].map(t => {
        const p = all[Math.floor(t * n)] || all[n-1];
        const v = Math.max(70, Math.round((p.r+p.g+p.b)/3));
        return `rgb(${v},${v},${v})`;
      });
      return;
    }

    // ── Color cover ─────────────────────────────────────────────────────────
    const col = all.filter(p => p.sat >= 0.10 && p.lum >= 0.03 && p.lum <= 0.97);
    if (!col.length) {
      palette = ['rgb(190,190,190)', 'rgb(130,130,130)', 'rgb(80,80,80)', 'rgb(45,45,45)'];
      return;
    }
    col.sort((a,b) => b.sat - a.sat);

    const chosen = [];
    for (const p of col) {
      if (chosen.length >= 4) break;
      if (chosen.every(c => {
        const dr = c.r-p.r, dg = c.g-p.g, db = c.b-p.b;
        return Math.sqrt(dr*dr + dg*dg + db*db) > 55;
      })) chosen.push(p);
    }
    while (chosen.length < 4) chosen.push(col[chosen.length % col.length]);
    palette = chosen.map(({ r, g, b }) => `rgb(${r},${g},${b})`);
  } catch(e) {
    // Palette extraction is non-critical; default palette remains.
  }
}

/* ──────────────────────────────────────────────────────────
   REAL-TIME FFT ENGINE  (Web Audio API)

   Signal chain:
     [System audio OR Microphone]
       → MediaStreamSource
       → AnalyserNode (fftSize=2048, 1024 bins)
       → frequency data polled every animation frame

   Frequency → Bin mapping (dynamic, uses actual sample rate):
     binHz   = sampleRate / fftSize   (~21.5 Hz/bin at 44100)
     subBass : 20 – 80 Hz   → kick drum punch
     bass    : 80 – 250 Hz  → low-end body
     lowMid  : 250 – 500 Hz → warmth
     mid     : 500–2000 Hz  → vocals / melody
     treble  : 2000–8000 Hz → brightness / hi-hats
     vocal   : 300–3500 Hz  → full vocal range (fundamentals + formants)

   Beat detection:
     Rolling RMS of sub-bass over BEAT_HISTORY frames.
     Fires when instant energy > BEAT_THRESHOLD × rolling average
     AND a BEAT_COOLDOWN_MS cooldown has elapsed.
   ────────────────────────────────────────────────────────── */

let audioCtx  = null;
let analyser  = null;
let fftData   = null;   // Uint8Array[1024]
let audioLive = false;

// Frequency band bin ranges — populated once AudioContext is ready.
let B = {};

function computeBandRanges() {
  const binHz = audioCtx.sampleRate / analyser.fftSize;
  const toBin = hz => Math.max(1, Math.min(
    Math.round(hz / binHz),
    analyser.frequencyBinCount - 1
  ));
  B = {
    subBass : [toBin(20),   toBin(80)  ],
    bass    : [toBin(80),   toBin(250) ],
    lowMid  : [toBin(250),  toBin(500) ],
    mid     : [toBin(500),  toBin(2000)],
    treble  : [toBin(2000), toBin(8000)],
    vocal   : [toBin(300),  toBin(3500)],
  };
}

/** Average magnitude of FFT bins in [lo, hi] → 0..1. */
function bandAvg(lo, hi) {
  if (!fftData || hi <= lo) return 0;
  let sum = 0;
  for (let i = lo; i <= hi; i++) sum += fftData[i];
  return sum / ((hi - lo + 1) * 255);
}

/**
 * Spectral centroid — energy-weighted average bin within 60–8000 Hz,
 * re-normalised so the output spans the full [0, 1] range for real music.
 * Returns 0 when signal is below the noise gate.
 */
function spectralCentroid() {
  if (!fftData || !audioCtx) return 0;
  const binHz = audioCtx.sampleRate / analyser.fftSize;
  const loB   = Math.max(1, Math.round(60   / binHz));
  const hiB   = Math.min(analyser.frequencyBinCount - 1, Math.round(8000 / binHz));

  let weightedSum = 0, totalMag = 0;
  for (let i = loB; i <= hiB; i++) {
    weightedSum += i * fftData[i];
    totalMag    += fftData[i];
  }

  // Noise gate: average bin magnitude below ~2% of full scale → silence.
  if (totalMag / (hiB - loB + 1) < 5) return 0;

  const raw = weightedSum / totalMag;
  return Math.max(0, Math.min(1, (raw - loB) / (hiB - loB)));
}

/* Beat detection state */
const BEAT_HISTORY     = 60;   // frames  (~1 s at 60 fps)
const BEAT_THRESHOLD   = 1.45; // energy must exceed this × average to trigger
const BEAT_COOLDOWN_MS = 220;  // minimum ms between beat triggers
const beatHistory      = new Float32Array(BEAT_HISTORY);
let   beatHistoryIdx   = 0;
let   lastBeatTime     = 0;
let   beatFlash        = 0;    // 1.0 on hit, decays each frame

function detectBeat(subBassEnergy) {
  beatHistory[beatHistoryIdx % BEAT_HISTORY] = subBassEnergy;
  beatHistoryIdx++;
  let avg = 0;
  for (let i = 0; i < BEAT_HISTORY; i++) avg += beatHistory[i];
  avg /= BEAT_HISTORY;
  const now = performance.now();
  if (subBassEnergy > BEAT_THRESHOLD * avg && now - lastBeatTime > BEAT_COOLDOWN_MS) {
    lastBeatTime = now;
    beatFlash    = 1.0;
  }
}

/**
 * Single FFT pass returning both master (whole-spectrum) and per-band values.
 * Master drives the background waves; per-band drives component waves.
 */
function getMasterSignal() {
  if (!audioLive || !fftData) {
    return { master:0, energy:0, bass:0, beat:0, vocal:0, mid:0, treble:0, pitch:0 };
  }

  analyser.getByteFrequencyData(fftData);

  // Broadband RMS
  const N = analyser.frequencyBinCount;
  let rmsSum = 0;
  for (let i = 1; i < N; i++) rmsSum += fftData[i] * fftData[i];
  const rms = Math.sqrt(rmsSum / N) / 255;

  const centroid = spectralCentroid();

  const subBass = bandAvg(...B.subBass);
  const bass    = bandAvg(...B.bass);
  const lowMid  = bandAvg(...B.lowMid);
  const mid     = bandAvg(...B.mid);
  const treble  = bandAvg(...B.treble);
  const vocal   = bandAvg(...B.vocal);

  detectBeat(subBass + bass * 0.5);
  beatFlash *= 0.82;

  // Master: broadband RMS boosted and brightness-modulated by centroid.
  const brightnessMod = 0.8 + centroid * 0.4;
  const master = Math.min(1, rms * 8.5 * brightnessMod + beatFlash * 0.35);

  return {
    master,
    energy  : rms,
    // Bass boost intentionally conservative (1.4×) to prevent saturation.
    bass    : Math.min(1, (subBass * 0.5 + bass * 0.5) * 2.8),
    beat    : beatFlash,
    vocal   : Math.min(1, vocal  * 7.5),
    mid     : Math.min(1, (lowMid * 0.4 + mid * 0.6) * 6.0),
    treble  : Math.min(1, treble * 7.5),
    pitch   : Math.min(1, centroid * 1.4),
  };
}

/* ──────────────────────────────────────────────────────────
   AUDIO CAPTURE
   ────────────────────────────────────────────────────────── */

function setupAnalyserFromStream(stream, label) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  analyser = audioCtx.createAnalyser();
  analyser.fftSize               = 2048;
  analyser.smoothingTimeConstant = 0.75;
  analyser.minDecibels           = -70;
  analyser.maxDecibels           = -10;

  fftData = new Uint8Array(analyser.frequencyBinCount);
  computeBandRanges();
  audioCtx.createMediaStreamSource(stream).connect(analyser);
  audioLive = true;
}

/** Show the audio prompt overlay. */
function showAudioPrompt() {
  document.getElementById('audio-prompt').classList.remove('hidden');
}

async function startCapture() {
  document.getElementById('audio-prompt').classList.add('hidden');

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { systemAudio: 'include', suppressLocalAudioPlayback: false },
    });
    stream.getVideoTracks().forEach(t => t.stop());
    if (stream.getAudioTracks().length > 0) {
      setupAnalyserFromStream(stream, 'System Audio');
      // When the user stops sharing, re-show the prompt automatically.
      stream.getAudioTracks()[0].addEventListener('ended', () => {
        audioLive = false;
        showAudioPrompt();
      });
    } else {
      // Dialog completed but no audio track — user didn't tick system audio.
      showAudioPrompt();
    }
  } catch {
    // User cancelled — re-show so they can try again.
    showAudioPrompt();
  }
}

/* ──────────────────────────────────────────────────────────
   CANVAS
   ────────────────────────────────────────────────────────── */

const canvas = document.getElementById('wave-canvas');
const ctx    = canvas.getContext('2d');

function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = canvas.offsetHeight || (window.innerHeight - 88);
}
window.addEventListener('resize', resizeCanvas);

/* ──────────────────────────────────────────────────────────
   WAVE LAYER DEFINITIONS

   LAYERS: 8 master waves, all driven by bands.master (whole-spectrum).
     L0: bass-dedicated (uses bassRaw, ceil capped to avoid saturation).
     L1–L7: master signal with staggered ceilings for visual depth.

   STROKES: 3 bright crest lines (always backed by a filled layer).

   BAND_LAYERS: 6 component-specific waves (bass/beat/vocal/mid/treble/pitch).
     Each uses its own frequency band for independent reactivity.

   wAmp formula: (FLOOR + signal × ceil) × H, hard-capped at MAX_AMP × H.
   ────────────────────────────────────────────────────────── */

const FLOOR   = 0.08;  
const MAX_AMP = 0.75;

const LAYERS = [
  // Back — bass-driven (ceil capped so bass doesn't saturate)
  { fq:0.0007, ph:0.00, ci:0, ceil:0.62, fn: b => b.bassRaw },
  // Master waves — staggered ceilings (tallest in back, shorter in front)
  { fq:0.0011, ph:2.20, ci:1, ceil:0.72 },
  { fq:0.0015, ph:4.50, ci:2, ceil:0.65 },
  { fq:0.0019, ph:1.10, ci:3, ceil:0.60 },
  { fq:0.0023, ph:5.80, ci:0, ceil:0.55 },
  { fq:0.0028, ph:3.30, ci:1, ceil:0.50 },
  { fq:0.0033, ph:6.90, ci:2, ceil:0.45 },
  { fq:0.0039, ph:0.70, ci:3, ceil:0.40 },
];

const STROKES = [
  { fq:0.0019, ph:0.95, ci:0, ceil:0.68 },
  { fq:0.0013, ph:2.75, ci:1, ceil:0.58 },
  { fq:0.0028, ph:5.40, ci:2, ceil:0.46 },
];

const FLOOR_B = 0.06;  
const RANGE_B = 0.90;  

const BAND_LAYERS = [
  { fq:0.0012, ph:0.50, ci:0, fn: b => b.bass,   rangeMult:1.00 },
  { fq:0.0020, ph:3.10, ci:1, fn: b => b.beat,   rangeMult:1.00 },
  { fq:0.0016, ph:5.60, ci:2, fn: b => b.vocal,  rangeMult:1.00 },
  { fq:0.0025, ph:1.80, ci:3, fn: b => b.mid,    rangeMult:1.00 },
  { fq:0.0034, ph:4.30, ci:0, fn: b => b.treble, rangeMult:1.00 },
  { fq:0.0029, ph:7.50, ci:1, fn: b => b.pitch,  rangeMult:1.00 },
];

/* ──────────────────────────────────────────────────────────
   WAVE MATH
   3 normalised harmonics summing to 1.0 max displacement.
   Normalised weights prevent wAmp from being exceeded.
   ────────────────────────────────────────────────────────── */

function waveY(x, phase, fq, sp, ph, wAmp) {
  const W = canvas.width, H = canvas.height;
  // Weights 0.645 + 0.226 + 0.129 = 1.000 (normalised from 1 + 0.35 + 0.20 = 1.55)
  const raw = Math.sin(x * fq        + phase * sp        + ph)       * 0.645
            + Math.sin(x * fq * 2.1  + phase * sp * 0.6  + ph * 0.7) * 0.226
            + Math.sin(x * fq * 0.38 + phase * sp * 0.22 + ph * 1.5) * 0.129;
  const env = 0.60 + 0.40 * Math.sin(Math.PI * x / W); // Taper at edges
  return H - wAmp * raw * env;
}

function drawWaves(phase, bands) {
  const W = canvas.width, H = canvas.height;
  if (!W || !H) return;
  ctx.clearRect(0, 0, W, H);
  const baseY = H;

  // ── Filled master layers ──
  for (let i = LAYERS.length - 1; i >= 0; i--) {
    const { fq, ph, ci, ceil, fn } = LAYERS[i];
    const rgb  = parseRgb(palette[ci % palette.length]);
    const sig  = fn ? Math.max(0, Math.min(1, fn(bands))) : bands.master;
    const wAmp = Math.min((FLOOR + sig * ceil) * H, MAX_AMP * H);

    ctx.beginPath(); ctx.moveTo(0, baseY);
    for (let x = 0; x <= W; x += 3) ctx.lineTo(x, waveY(x, phase, fq, 0, ph, wAmp));
    ctx.lineTo(W, baseY); ctx.closePath();

    const t      = (LAYERS.length - 1 - i) / (LAYERS.length - 1);
    const alpha  = 0.14 + t * 0.22;
    const crestY = baseY - wAmp * 0.88;
    const grad   = ctx.createLinearGradient(0, crestY, 0, baseY);
    grad.addColorStop(0,    `rgba(${rgb},${alpha.toFixed(2)})`);
    grad.addColorStop(0.65, `rgba(${rgb},${(alpha * 0.32).toFixed(2)})`);
    grad.addColorStop(1,    `rgba(${rgb},0)`);
    ctx.fillStyle = grad; ctx.fill();
  }

  // ── Stroke lines ──
  for (const { fq, ph, ci, ceil } of STROKES) {
    const rgb  = parseRgb(palette[ci % palette.length]);
    const wAmp = Math.min((FLOOR + bands.master * ceil) * H, MAX_AMP * H);
    ctx.beginPath();
    for (let x = 0; x <= W; x += 3) {
      const y = waveY(x, phase, fq, 0, ph, wAmp);
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgba(${rgb},0.14)`; ctx.lineWidth = 8;   ctx.stroke();
    ctx.strokeStyle = `rgba(${rgb},0.88)`; ctx.lineWidth = 1.5; ctx.stroke();
  }

  // ── Component-specific band waves ──
  for (let i = BAND_LAYERS.length - 1; i >= 0; i--) {
    const { fq, ph, ci, fn, rangeMult } = BAND_LAYERS[i];
    const rgb     = parseRgb(palette[ci % palette.length]);
    const bandVal = Math.max(0, Math.min(1, fn(bands)));
    const wAmp    = Math.min((FLOOR_B + bandVal * RANGE_B * rangeMult) * H, MAX_AMP * H);

    ctx.beginPath(); ctx.moveTo(0, baseY);
    for (let x = 0; x <= W; x += 3) ctx.lineTo(x, waveY(x, phase, fq, 0, ph, wAmp));
    ctx.lineTo(W, baseY); ctx.closePath();

    const crestY = baseY - wAmp * 0.88;
    const grad   = ctx.createLinearGradient(0, crestY, 0, baseY);
    grad.addColorStop(0,    `rgba(${rgb},0.38)`);
    grad.addColorStop(0.65, `rgba(${rgb},0.10)`);
    grad.addColorStop(1,    `rgba(${rgb},0)`);
    ctx.fillStyle = grad; ctx.fill();

    ctx.beginPath();
    for (let x = 0; x <= W; x += 3) {
      const y = waveY(x, phase, fq, 0, ph, wAmp);
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgba(${rgb},0.18)`; ctx.lineWidth = 7;   ctx.stroke();
    ctx.strokeStyle = `rgba(${rgb},0.92)`; ctx.lineWidth = 1.5; ctx.stroke();
  }
}

/* ──────────────────────────────────────────────────────────
   ANIMATION LOOP
   ────────────────────────────────────────────────────────── */

let progressMs = 0, durationMs = 1, isPlaying = false, pollTimestamp = 0;
let rafId = null, wavePhase = 0;

// Smoothed band values — each decays to 0 when audio stops.
let sMaster = 0, sBassRaw = 0;
let sBass = 0, sBeat = 0, sVocal = 0, sMid = 0, sTreble = 0, sPitch = 0;

function frame() {
  rafId = requestAnimationFrame(frame);

  const live = getMasterSignal();

  if (audioLive && isPlaying) {
    sMaster  += (live.master - sMaster)  * 0.55;
    sBassRaw += (live.bass   - sBassRaw) * 0.65;
    sBass    += (live.bass   - sBass)    * 0.55;
    sBeat    += (live.beat   - sBeat)    * 0.70;
    sVocal   += (live.vocal  - sVocal)   * 0.55;
    sMid     += (live.mid    - sMid)     * 0.55;
    sTreble  += (live.treble - sTreble)  * 0.60;
    sPitch   += (live.pitch  - sPitch)   * 0.50;
  } else {
    // Decay toward 0 when paused / no audio
    sMaster  += (0 - sMaster)  * 0.12;
    sBassRaw += (0 - sBassRaw) * 0.12;
    sBass    += (0 - sBass)    * 0.12;
    sBeat    += (0 - sBeat)    * 0.12;
    sVocal   += (0 - sVocal)   * 0.12;
    sMid     += (0 - sMid)     * 0.12;
    sTreble  += (0 - sTreble)  * 0.12;
    sPitch   += (0 - sPitch)   * 0.30;
  }

  drawWaves(wavePhase, {
    master: sMaster, bassRaw: sBassRaw,
    bass: sBass, beat: sBeat, vocal: sVocal,
    mid: sMid, treble: sTreble, pitch: sPitch,
  });
}

/* ──────────────────────────────────────────────────────────
   PALETTE
   ────────────────────────────────────────────────────────── */

function applyPalette() {
  const c0 = parseRgb(palette[0]);
  const c1 = parseRgb(palette[1] || palette[0]);
  const c2 = parseRgb(palette[2] || palette[0]);

  document.getElementById('bg-glow').style.background = [
    `radial-gradient(ellipse 75% 55% at 20% 35%, rgba(${c0},0.16) 0%, transparent 70%)`,
    `radial-gradient(ellipse 65% 50% at 80% 65%, rgba(${c1},0.12) 0%, transparent 70%)`,
    `radial-gradient(ellipse 50% 40% at 50% 80%, rgba(${c2},0.08) 0%, transparent 70%)`,
  ].join(',');

  document.getElementById('album-art').style.boxShadow =
    `0 28px 72px rgba(0,0,0,0.88), 0 0 80px rgba(${c0},0.35)`;
  // Full-width progress bar — gradient from album palette, always 100% wide
  document.getElementById('progress-fill').style.background =
    `linear-gradient(to right, rgba(${c0},0.9), rgba(${c1},0.9), rgba(${c2},0.9))`;
}

/* ──────────────────────────────────────────────────────────
   LAST.FM POLLING
   Polls user.getRecentTracks every 10 s. When the track changes,
   fetches track.getInfo for duration and higher-quality art.
   yes i know this isn't the greatest strategy. none of this is. blame spotify.
   ────────────────────────────────────────────────────────── */

let currentTrackKey = null; // 'artist||track' — changes on new song

/** Get the best available image URL from a Last.fm image array */
function bestImage(images) {
  if (!Array.isArray(images)) return '';
  // Prefer extralarge → large → medium
  const order = ['extralarge', 'large', 'medium', 'small'];
  for (const size of order) {
    const img = images.find(i => i.size === size);
    if (img?.['#text']) return img['#text'];
  }
  return images[images.length - 1]?.['#text'] || '';
}

/** Fetch extended track info (duration + better art) from Last.fm */
async function getTrackInfo(artist, track) {
  try {
    const res = await fetch(
      '/api/lastfm/track?' + new URLSearchParams({ artist, track })
    );
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data?.track || null;
  } catch {
    return null;
  }
}

async function pollLastFm() {
  const now = Date.now();
  if (now - lastPollTime < MIN_POLL_INTERVAL_MS) return;
  if (isBackingOff()) return;
  lastPollTime = now;

  const username = localStorage.getItem('lfm_user');
  if (!username) { showLogin(); return; }

  let res;
  try {
    res = await fetch(
      '/api/lastfm/recent?' + new URLSearchParams({ user: username })
    );
  } catch { applyBackoff(); return; }

  if (res.status === 429) { applyBackoff(); return; }
  if (!res.ok) { applyBackoff(); return; }
  resetBackoff();

  const data = await res.json().catch(() => null);
  const track = data?.recenttracks?.track?.[0];
  if (!track) { setIdle(); return; }

  // Only react to a track that is actively now playing
  const isNowPlaying = track['@attr']?.nowplaying === 'true';
  if (!isNowPlaying) { setIdle(); return; }

  isPlaying = true;
  setActive();

  const artist    = track.artist?.['#text'] || '';
  const trackName = track.name            || '';
  const trackKey  = `${artist}||${trackName}`;

  // Update text immediately
  document.getElementById('track-name').textContent  = trackName;
  document.getElementById('artist-name').textContent = artist;

  // Only fetch full info when the track actually changes
  if (trackKey !== currentTrackKey) {
    currentTrackKey = trackKey;

    // Quick art from recenttracks while getInfo loads
    const quickArt = bestImage(track.image);
    if (quickArt) updateAlbumArt(quickArt);

    // Full info: duration + higher-quality art
    const info = await getTrackInfo(artist, trackName);
    if (info) {
      const durationMs = parseInt(info.duration || '0');
      if (durationMs > 0) {
        document.getElementById('time-total').textContent = fmtMs(durationMs);
      }
      const betterArt = bestImage(info.album?.image);
      if (betterArt) updateAlbumArt(betterArt);
    }
  }
}

function updateAlbumArt(url) {
  const img       = document.getElementById('album-art');
  img.crossOrigin = 'anonymous';
  img.onload      = () => { extractPalette(img); applyPalette(); };
  img.onerror     = () => { applyPalette(); };
  img.src         = url;
}

/* ──────────────────────────────────────────────────────────
   UI STATE HELPERS
   ────────────────────────────────────────────────────────── */

function setActive() {
  const s = document.getElementById('album-section');
  s.style.display = 'flex';
  requestAnimationFrame(() => s.classList.add('visible'));
  document.getElementById('idle-state').style.display = 'none';
}

function setIdle() {
  const s = document.getElementById('album-section');
  s.classList.remove('visible');
  s.style.display = 'none';
  document.getElementById('idle-state').style.display = 'block';
  isPlaying = false;
}

function showLogin() {
  document.getElementById('login-screen').style.display      = 'flex';
  document.getElementById('visualizer-screen').style.display = 'none';
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

function showVisualizer() {
  document.getElementById('login-screen').style.display      = 'none';
  document.getElementById('visualizer-screen').style.display = 'block';
  resizeCanvas(); // Must call after display:block so offsetHeight is valid.
  if (!rafId) rafId = requestAnimationFrame(frame);
}

function fmtMs(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ──────────────────────────────────────────────────────────
   FULLSCREEN IMPLEMENTATION
   ────────────────────────────────────────────────────────── */

function updateFullscreenIcon() {
  const isFs = !!(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement
  );

  const expand   = document.getElementById('icon-expand');
  const compress = document.getElementById('icon-compress');
  if (expand)   expand.style.display   = isFs ? 'none'  : 'block';
  if (compress) compress.style.display = isFs ? 'block' : 'none';
}

function toggleFullscreen() {
  if (
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement
  ) {
    // Exit fullscreen
    (document.exitFullscreen ||
     document.webkitExitFullscreen ||
     document.mozCancelFullScreen
    ).call(document);
  } else {
    // Enter fullscreen on the root element
    const el = document.documentElement;
    (el.requestFullscreen ||
     el.webkitRequestFullscreen ||
     el.mozRequestFullScreen
    ).call(el);
  }
}

// Keep icon in sync when the user presses Escape or uses browser controls.
document.addEventListener('fullscreenchange',       updateFullscreenIcon);
document.addEventListener('webkitfullscreenchange', updateFullscreenIcon);
document.addEventListener('mozfullscreenchange',    updateFullscreenIcon);

/* ──────────────────────────────────────────────────────────
   EVENT WIRING
   All onclick attributes removed from HTML; handlers attached here.
   ────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-btn')?.addEventListener('click', login);
  document.getElementById('logout-btn')?.addEventListener('click', logout);
  document.getElementById('grant-audio-btn')?.addEventListener('click', startCapture);
  document.getElementById('fullscreen-btn')?.addEventListener('click', toggleFullscreen);
  updateFullscreenIcon();
});

/* ──────────────────────────────────────────────────────────
   BOOT
   ────────────────────────────────────────────────────────── */

async function init() {
  const token = new URLSearchParams(window.location.search).get('token');

  if (token) {
    const ok = await lastfmExchangeToken(token);
    if (!ok) {
      showLogin();
      return;
    }
  }

  if (!isLoggedIn()) {
    showLogin();
    return;
  }

  showVisualizer();
  await pollLastFm();
  setInterval(pollLastFm, MIN_POLL_INTERVAL_MS);
}
init();
