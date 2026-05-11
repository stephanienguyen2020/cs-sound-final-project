/**
 * Pluck — a Karplus-Strong instrument with procedural body resonance.
 *
 * Signal flow:
 *
 *   (keypress) → noteOn(midi)
 *                   ↓
 *          AudioWorkletNode (string voice)
 *                   ↓
 *                voiceBus ──► dryGain ──┐
 *                    └──► ConvolverNode → wetGain ┤
 *                                                 ↓
 *                                              master → destination
 *                                                    └→ AnalyserNode (viz)
 *
 * The ConvolverNode holds an impulse response generated at runtime by
 * modal synthesis — summing a handful of exponentially decaying sinusoids
 * at measured resonant mode frequencies of real instrument bodies. This
 * is the "technique not covered in class": we're using convolution (which
 * *was* covered) but generating the IR ourselves from first principles
 * rather than loading a recorded one.
 */

// ── Body preset data ────────────────────────────────────────────────────
// Each mode is [frequency Hz, decay time seconds, amplitude].
// Frequencies are loose approximations of documented resonant modes of
// real instrument bodies — the goal is characterful, not museum-accurate.
const BODY_PRESETS = {
  // Mode frequencies follow the well-documented resonance pattern of a
  // classical (nylon-string) guitar body. Real values vary a few Hz from
  // instrument to instrument, but the *structure* — Helmholtz around
  // 100 Hz, two strong coupled modes around 200 and 285 Hz, then higher
  // top-plate modes — is what makes this sound like a guitar.
  guitar: {
    label: 'Classical Guitar',
    durationSeconds: 0.9,
    modes: [
      // [freq Hz, decay s, amp]   role
      [ 100, 0.55, 1.00],         // Helmholtz "air mode" — soundhole resonance
      [ 196, 0.32, 0.82],         // T(1,1)₂  — top plate, coupled to air
      [ 285, 0.24, 0.70],         // T(1,1)₃  — back plate, coupled
      [ 425, 0.16, 0.50],         // higher top-plate mode
      [ 610, 0.12, 0.36],         // upper coupled mode
      [ 880, 0.09, 0.24],         // body brilliance
      [1350, 0.06, 0.16],         // wood/string-bridge sparkle
    ],
  },
  koto: {
    label: 'Koto-like',
    durationSeconds: 1.2,
    modes: [
      [80, 0.90, 0.50],
      [160, 0.70, 0.40],
      [240, 0.55, 0.70],
      [360, 0.45, 0.55],
      [510, 0.35, 0.35],
      [720, 0.25, 0.22],
    ],
  },
  banjo: {
    label: 'Banjo-like',
    durationSeconds: 0.4,
    modes: [
      [150, 0.20, 0.30],
      [310, 0.15, 0.75],
      [620, 0.10, 0.80],
      [980, 0.08, 0.55],
      [1500, 0.06, 0.35],
      [2100, 0.04, 0.20],
    ],
  },
  none: {
    label: 'Raw String',
    durationSeconds: 0.02,
    // A single short, non-resonant pulse: effectively bypasses body colouring.
    modes: [[2000, 0.005, 1.0]],
  },
};

/**
 * Render an impulse response by summing decaying sinusoids at each mode.
 * Small per-channel phase offset gives a subtle stereo spread.
 */
function generateBodyIR(audioContext, preset) {
  const sampleRate = audioContext.sampleRate;
  const length = Math.floor(sampleRate * preset.durationSeconds);
  const buffer = audioContext.createBuffer(2, length, sampleRate);

  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    const phaseJitter = channel === 1 ? 0.15 : 0;

    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      data[i] = sumModesAt(preset.modes, t, phaseJitter);
    }
  }

  normalizeBuffer(buffer, 0.9);
  return buffer;
}

function sumModesAt(modes, t, phaseJitter) {
  let sample = 0;
  for (const [freq, decay, amp] of modes) {
    sample += amp * Math.exp(-t / decay) *
              Math.sin(2 * Math.PI * freq * t + phaseJitter);
  }
  return sample;
}

function normalizeBuffer(buffer, targetPeak) {
  let peak = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const abs = Math.abs(data[i]);
      if (abs > peak) peak = abs;
    }
  }
  if (peak === 0) return;
  const scale = targetPeak / peak;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) data[i] *= scale;
  }
}

// ── MIDI helpers ────────────────────────────────────────────────────────
function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function midiToNoteName(midi) {
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const octave = Math.floor(midi / 12) - 1;
  return `${names[midi % 12]}${octave}`;
}

// QWERTY → MIDI. Lower two rows cover octaves 3–4, just over an octave each.
const KEY_TO_MIDI = Object.freeze({
  'KeyZ': 48, 'KeyS': 49, 'KeyX': 50, 'KeyD': 51, 'KeyC': 52,
  'KeyV': 53, 'KeyG': 54, 'KeyB': 55, 'KeyH': 56, 'KeyN': 57,
  'KeyJ': 58, 'KeyM': 59,
  'KeyQ': 60, 'Digit2': 61, 'KeyW': 62, 'Digit3': 63, 'KeyE': 64,
  'KeyR': 65, 'Digit5': 66, 'KeyT': 67, 'Digit6': 68, 'KeyY': 69,
  'Digit7': 70, 'KeyU': 71, 'KeyI': 72,
});

// Reverse lookup for drawing keycap hints on the keyboard
const MIDI_TO_KEY = (() => {
  const map = {};
  for (const [code, midi] of Object.entries(KEY_TO_MIDI)) {
    const label = code.replace('Key', '').replace('Digit', '');
    map[midi] = label;
  }
  return map;
})();

// ── The instrument itself ───────────────────────────────────────────────
class StringInstrument {
  constructor(audioContext) {
    this.audioContext = audioContext;
    this.voices = new Map(); // midi → { node, dampingParam }

    this.damping = 0.996;
    this.brightness = 0.6;
    this.pluckHardness = 0.55;

    this.#buildSignalChain();
    this.setBody('guitar');
    this.setBodyMix(0.55);
  }

  #buildSignalChain() {
    const ctx = this.audioContext;

    this.voiceBus = ctx.createGain();
    this.voiceBus.gain.value = 0.55;

    this.bodyConvolver = ctx.createConvolver();
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();
    this.master = ctx.createGain();
    this.master.gain.value = 0.55;

    // Parallel dry + wet send from the voice bus
    this.voiceBus.connect(this.dryGain);
    this.voiceBus.connect(this.bodyConvolver);
    this.bodyConvolver.connect(this.wetGain);
    this.dryGain.connect(this.master);
    this.wetGain.connect(this.master);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.master.connect(this.analyser);
    this.master.connect(ctx.destination);
  }

  setBody(presetName) {
    const preset = BODY_PRESETS[presetName];
    this.bodyConvolver.buffer = generateBodyIR(this.audioContext, preset);
  }

  setBodyMix(wet) {
    // Keep at least some dry signal present so transients stay crisp.
    this.dryGain.gain.value = Math.max(0.35, 1 - wet);
    // Wet is boosted to compensate for the energy loss through convolution.
    this.wetGain.gain.value = wet * 1.6;
  }

  setDamping(value)       { this.damping = value; }
  setBrightness(value)    { this.brightness = value; }
  setPluckHardness(value) { this.pluckHardness = value; }

  noteOn(midi) {
    if (this.voices.has(midi)) this.noteOff(midi); // retrigger

    const frequency = midiToFrequency(midi);
    const node = new AudioWorkletNode(this.audioContext, 'karplus-strong', {
      processorOptions: {
        frequency,
        pluckHardness: this.pluckHardness,
      },
    });

    const dampingParam = node.parameters.get('damping');
    const brightnessParam = node.parameters.get('brightness');
    dampingParam.value = this.damping;
    brightnessParam.value = this.brightness;

    // Clean up when the worklet reports it has self-terminated. We compare
    // by identity because the midi slot may already hold a newer voice.
    node.port.onmessage = (event) => {
      if (event.data?.type !== 'done') return;
      try { node.disconnect(); } catch { /* already disconnected */ }
      const current = this.voices.get(midi);
      if (current && current.node === node) this.voices.delete(midi);
    };

    node.connect(this.voiceBus);
    this.voices.set(midi, { node, dampingParam });
  }

  noteOff(midi) {
    const voice = this.voices.get(midi);
    if (!voice) return;

    // On release, drop damping aggressively — physically this is like
    // touching the string to mute it. The worklet self-terminates once
    // the signal falls below its silence floor, so there's no manual
    // disconnect needed here.
    const now = this.audioContext.currentTime;
    voice.dampingParam.cancelScheduledValues(now);
    voice.dampingParam.setTargetAtTime(0.88, now, 0.03);
    this.voices.delete(midi);
  }
}

// ── UI wiring ───────────────────────────────────────────────────────────
const LOWEST_MIDI = 48;   // C3
const HIGHEST_MIDI = 72;  // C5
const WHITE_KEY_PATTERN = [true, false, true, false, true, true, false, true, false, true, false, true];

function isWhiteKey(midi) {
  return WHITE_KEY_PATTERN[midi % 12];
}

function buildKeyboard(container, onPress, onRelease) {
  container.innerHTML = '';

  const whiteKeys = [];
  for (let m = LOWEST_MIDI; m <= HIGHEST_MIDI; m++) {
    if (isWhiteKey(m)) whiteKeys.push(m);
  }

  const whiteLayer = document.createElement('div');
  whiteLayer.className = 'keys-white';
  const blackLayer = document.createElement('div');
  blackLayer.className = 'keys-black';

  const whiteKeyWidthPct = 100 / whiteKeys.length;

  // Draw white keys first (baseline)
  whiteKeys.forEach((midi, index) => {
    const key = createKeyElement(midi, onPress, onRelease);
    key.style.width = `${whiteKeyWidthPct}%`;
    whiteLayer.appendChild(key);
    key.dataset.whiteIndex = String(index);
  });

  // Overlay black keys, absolutely positioned between white neighbors
  for (let m = LOWEST_MIDI; m <= HIGHEST_MIDI; m++) {
    if (isWhiteKey(m)) continue;
    const leftWhiteIndex = whiteKeys.findIndex((w) => w === m - 1);
    if (leftWhiteIndex < 0) continue;
    const key = createKeyElement(m, onPress, onRelease);
    key.style.left = `calc(${(leftWhiteIndex + 1) * whiteKeyWidthPct}% - ${whiteKeyWidthPct * 0.3}%)`;
    key.style.width = `${whiteKeyWidthPct * 0.6}%`;
    blackLayer.appendChild(key);
  }

  container.appendChild(whiteLayer);
  container.appendChild(blackLayer);
}

function createKeyElement(midi, onPress, onRelease) {
  const key = document.createElement('button');
  key.type = 'button';
  key.className = isWhiteKey(midi) ? 'key key-white' : 'key key-black';
  key.dataset.midi = String(midi);
  key.setAttribute('aria-label', midiToNoteName(midi));

  const label = document.createElement('span');
  label.className = 'key-label';
  label.textContent = MIDI_TO_KEY[midi] ?? '';
  key.appendChild(label);

  const note = document.createElement('span');
  note.className = 'key-note';
  note.textContent = midiToNoteName(midi);
  key.appendChild(note);

  let pointerActive = false;
  key.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    key.setPointerCapture(e.pointerId);
    pointerActive = true;
    onPress(midi);
  });
  const end = (e) => {
    if (!pointerActive) return;
    pointerActive = false;
    try { key.releasePointerCapture(e.pointerId); } catch {}
    onRelease(midi);
  };
  key.addEventListener('pointerup', end);
  key.addEventListener('pointercancel', end);
  key.addEventListener('pointerleave', (e) => { if (pointerActive) end(e); });

  return key;
}

function highlightKey(midi, active) {
  const el = document.querySelector(`.key[data-midi="${midi}"]`);
  if (el) el.classList.toggle('is-active', active);
}

// ── Visualizer ──────────────────────────────────────────────────────────
function startVisualizer(canvas, analyser) {
  const ctx = canvas.getContext('2d');
  const buffer = new Float32Array(analyser.fftSize);

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  function frame() {
    analyser.getFloatTimeDomainData(buffer);
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    // Subtle midline
    ctx.strokeStyle = 'rgba(168, 154, 130, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    // Waveform
    ctx.strokeStyle = '#d4a254';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const step = buffer.length / w;
    for (let x = 0; x < w; x++) {
      const sample = buffer[Math.floor(x * step)];
      const y = h / 2 + sample * (h * 0.45);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    requestAnimationFrame(frame);
  }
  frame();
}

// ── Control panel wiring ────────────────────────────────────────────────
function wireControls(instrument) {
  const sliders = [
    { id: 'damping', readout: 'dampingReadout',
      get: () => instrument.damping,
      apply: (v) => instrument.setDamping(v),
      format: (v) => v.toFixed(4) },
    { id: 'brightness', readout: 'brightnessReadout',
      get: () => instrument.brightness,
      apply: (v) => instrument.setBrightness(v),
      format: (v) => v.toFixed(2) },
    { id: 'pluck', readout: 'pluckReadout',
      get: () => instrument.pluckHardness,
      apply: (v) => instrument.setPluckHardness(v),
      format: (v) => v.toFixed(2) },
    { id: 'mix', readout: 'mixReadout',
      get: () => parseFloat(document.getElementById('mix').value),
      apply: (v) => instrument.setBodyMix(v),
      format: (v) => `${Math.round(v * 100)}%` },
  ];

  for (const s of sliders) {
    const input = document.getElementById(s.id);
    const readout = document.getElementById(s.readout);
    input.value = String(s.get());
    readout.textContent = s.format(parseFloat(input.value));
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      s.apply(v);
      readout.textContent = s.format(v);
    });
  }

  const bodyButtons = document.getElementById('bodyOptions');
  bodyButtons.innerHTML = '';
  for (const [key, preset] of Object.entries(BODY_PRESETS)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'body-option';
    btn.dataset.preset = key;
    btn.textContent = preset.label;
    if (key === 'guitar') btn.classList.add('is-selected');
    btn.addEventListener('click', () => {
      instrument.setBody(key);
      document.querySelectorAll('.body-option').forEach((b) =>
        b.classList.toggle('is-selected', b === btn));
    });
    bodyButtons.appendChild(btn);
  }
}

// ── Boot ────────────────────────────────────────────────────────────────
async function boot() {
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  await audioContext.audioWorklet.addModule('worklet.js');

  const instrument = new StringInstrument(audioContext);

  // Reveal the stage *before* measuring the canvas, otherwise
  // getBoundingClientRect() returns 0×0 and the visualizer never draws.
  document.getElementById('startOverlay').hidden = true;
  document.getElementById('stage').hidden = false;

  const keyboardEl = document.getElementById('keyboard');
  buildKeyboard(
    keyboardEl,
    (midi) => { instrument.noteOn(midi); highlightKey(midi, true); },
    (midi) => { instrument.noteOff(midi); highlightKey(midi, false); },
  );

  // Computer keyboard input — ignore auto-repeat and already-held keys
  const heldKeys = new Set();
  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const midi = KEY_TO_MIDI[e.code];
    if (midi === undefined) return;
    if (heldKeys.has(midi)) return;
    heldKeys.add(midi);
    instrument.noteOn(midi);
    highlightKey(midi, true);
  });
  document.addEventListener('keyup', (e) => {
    const midi = KEY_TO_MIDI[e.code];
    if (midi === undefined) return;
    heldKeys.delete(midi);
    instrument.noteOff(midi);
    highlightKey(midi, false);
  });

  wireControls(instrument);
  startVisualizer(document.getElementById('waveform'), instrument.analyser);
}

document.getElementById('startButton').addEventListener('click', () => {
  boot().catch((err) => {
    console.error(err);
    alert('Could not start audio: ' + err.message);
  });
});
