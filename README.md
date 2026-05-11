# Pluck

A playable plucked-string instrument in the browser. Each voice is a
Karplus-Strong string model running inside an AudioWorklet, routed
through a ConvolverNode whose impulse response is **generated at runtime**
by modal synthesis — no recorded body samples, just sums of decaying
sinusoids at each body's characteristic resonant frequencies.

## Running it

AudioWorklets cannot be loaded from `file://` origins in most browsers,
so you need a local web server. Any of these work from inside this
directory:

```bash
# Python 3
python3 -m http.server 8000

# Node (if you have it)
npx serve .

# VS Code: use the "Live Server" extension
```

Then open `http://localhost:8000/`. Click **Tune the strings** to
initialize the AudioContext (a user gesture is required), and play with
the computer keyboard or by tapping/clicking the keys.

## Playing

- **Z X C V B N M** — C, D, E, F, G, A, B in octave 3
- **Q W E R T Y U I** — C, D, E, F, G, A, B, C in octave 4
- Sharps sit on the rows above (**S D G H J** / **2 3 5 6 7**)
- Or use touch / mouse on the on-screen keyboard
- Up to as many voices as your keyboard can report simultaneously

### Controls

| Control        | What it does                                               |
| -------------- | ---------------------------------------------------------- |
| **Sustain**    | Damping coefficient. Higher = longer decay.                |
| **Brightness** | Lowpass α in the feedback loop. Lower = mellower tone.     |
| **Pluck**      | Hardness of the initial noise burst. Hard = bright attack. |
| **Body**       | Which procedural body IR to convolve with.                 |
| **Mix**        | How much of the body resonance is sent to output.          |

## Architecture

```
  keypress → noteOn(midi)
                │
                ▼
   AudioWorkletNode (karplus-strong)  ← one per simultaneous note
                │
                ▼
             voiceBus ──►   dryGain    ──┐
                  └────► ConvolverNode ──► wetGain ──┤
                                                     ▼
                                                   master ──► destination
                                                     └────► AnalyserNode (viz)
```

### The string voice (`worklet.js`)

A classical Karplus-Strong loop:

```
  buffer[N]  ← filtered noise burst (the "pluck")
  for each output sample:
      y[n] = buffer[read]
      lp   = α·y[n] + (1−α)·lp_prev      // one-pole lowpass
      buffer[read] = lp · damping        // feedback gain
      read = (read + 1) mod N
```

- `N = sampleRate / f0` sets pitch.
- `damping` (≈0.996) sets decay; dropping it to ~0.88 on release
  simulates a hand touching the string.
- `brightness` (α) sets spectral roll-off: low α → fewer harmonics
  survive each loop iteration.
- The worklet auto-terminates after ~12 render quanta below −66 dB
  and messages the main thread so the node can be disconnected.

### The body (`instrument.js`)

`generateBodyIR()` synthesizes an impulse response as the sum of
exponentially decaying sinusoids:

```
  ir(t) = Σ  amp_i · exp(−t / decay_i) · sin(2π · freq_i · t)
```

Each body preset defines ~5–7 modes (frequency / decay / amplitude).
The guitar preset loosely follows documented resonances of a classical
guitar body; the koto and banjo presets are characterful approximations
rather than measured data. A small per-channel phase offset gives a
subtle stereo spread.
