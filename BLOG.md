---

## A guitar is two things

A guitar is just a string and a box. Pluck the string and it vibrates. Without the box, you just get a thin buzzing tone that dies in a second. The wooden body does the heavy lifting. The string provides the energy, and the body acts as the loudspeaker, EQ, and reverb. I wanted to build a guitar in the browser using 100% synthesis. No recorded samples allowed. That meant building both halves from scratch. The string needs to vibrate and the body needs to ring. The string part is a solved problem. Karplus-Strong has been the go-to algorithm since 1983. On the web, you can drop it into an `AudioWorklet` in a few hundred lines. The body is the interesting part, which is what we will focus on.

## Karplus-Strong, briefly

For completeness, since not everyone has touched it: Karplus-Strong is a circular buffer of length N, where N = sampleRate / f₀. You fill it once with noise, then in the inner loop you read the oldest sample out, run it through a one-pole lowpass, multiply by a damping coefficient just under 1, and write the result back to the head of the buffer.

```
y[n] = buffer[read]
lp   = α·y[n] + (1 − α)·lp_prev      // one-pole lowpass
buffer[read] = lp · damping          // feedback gain
read = (read + 1) mod N
```

That's the whole algorithm. The lowpass in the feedback path is what makes it sound like a plucked string: high frequencies lose more energy per loop iteration than low frequencies, exactly the way they do on a real string. The damping coefficient sets the overall decay time. The initial noise contents become the (extremely rich) harmonic spectrum of the pluck.

I implemented this as an `AudioWorkletProcessor`. There's a tempting alternative: wire a `DelayNode` into a `BiquadFilter` with the output fed back through a gain, but it fails on a fundamental point: `DelayNode` has a minimum delay of one render quantum (128 samples), which at 44.1 kHz pins your lowest _playable_ pitch to about 344 Hz. That's the E above middle C. Anything below that just doesn't tune. The worklet lets the delay line be as short as 2 samples, which covers anything we'd ever ask the instrument to play.

The processor is small. Stripped of the parameter descriptors and bookkeeping:

```javascript
process(_inputs, outputs, parameters) {
  const channel = outputs[0][0];
  const damping = parameters.damping[0];
  const brightness = parameters.brightness[0];

  for (let i = 0; i < channel.length; i++) {
    const current = this.delayLine[this.readIndex];

    this.lowpassState =
      brightness * current + (1 - brightness) * this.lowpassState;

    const feedback = this.lowpassState * damping;

    channel[i] = current;
    this.delayLine[this.readIndex] = feedback;
    this.readIndex = (this.readIndex + 1) % this.bufferSize;
  }
  return true;
}
```

A few details that matter in practice:

**Pluck shaping.** A purely white noise burst sounds too bright and a little metallic. I expose a "pluck hardness" parameter that smooths the noise with a one-pole IIR before it goes into the delay line: coefficient tracking `(1 − hardness)`. Hard plucks stay near-white, soft plucks roll off the highs and sound like a thumb pluck instead of a fingernail. Then I subtract the mean of the burst so the attack doesn't have a DC thud.

**Self-termination.** Voice management is the thing tutorials never mention. Each note is a worklet node consuming CPU forever unless you tell it to stop. I track peak amplitude inside `process()` and once it stays below ~0.0005 (about −66 dB) for 12 render quanta in a row, the processor `postMessage`s the main thread and returns `false`:

```javascript
if (peak < 0.0005) this.silenceCounter++;
else this.silenceCounter = 0;

if (this.silenceCounter >= 12) {
  this.port.postMessage({ type: "done" });
  return false;
}
```

The main thread disconnects the node and forgets about it. The map of active voices stays small even after thousands of notes.

**Note off.** Releasing a key doesn't kill the voice. It schedules `setTargetAtTime` on the damping AudioParam to drop the loop gain from ~0.996 to ~0.88. Physically this is what putting your finger on the string does. The string decays in maybe 200 ms instead of four seconds, the silence detector trips, and the worklet retires itself.

```javascript
const now = this.audioContext.currentTime;
voice.dampingParam.cancelScheduledValues(now);
voice.dampingParam.setTargetAtTime(0.88, now, 0.03);
```

The two states, held and released, are the same algorithm with a different loop gain.

## The actual question: the body

So you have a Karplus-Strong string. Plug it into `context.destination` and you'll hear something that sounds like a plucked rubber band. It's recognizably _a string_, and it's also unmistakably _an algorithm_. Real guitars don't sound like that, because real guitars are strings glued to a vibrating wooden enclosure.

A classical guitar body has a Helmholtz resonance from the air in the soundhole around 100 Hz, a coupled top-plate/back-plate pair around 196 and 285 Hz, and then a sequence of higher top-plate modes climbing through the spectrum. When you pluck a string, the bridge couples its vibration into the top plate, which excites every one of those modes at once. The body rings.

The standard way to put "a guitar body" in your signal chain on the web is to record an impulse response of an actual guitar, gently tap the bridge with a calibrated hammer, mic the body, save the recording, and feed it into a `ConvolverNode`. This works. It is also a little boring, because the IR is a recording. I wanted to _generate_ the IR.

### Modal synthesis

Modal synthesis is the small, tractable shortcut. The idea: any linear resonator can be modelled to first order as a parallel bank of damped harmonic oscillators, one per resonant mode. Each mode contributes a decaying sinusoid, and you sum them:

```
ir(t) = Σᵢ  aᵢ · exp(−t / τᵢ) · sin(2π · fᵢ · t)
```

Each `(fᵢ, τᵢ, aᵢ)` triple is one mode: frequency in Hz, decay time in seconds, amplitude. Sum a handful of them, normalize the result, and you have an impulse response. The `ConvolverNode` doesn't care that it was synthesized.

The body presets live as small tables:

```javascript
guitar: {
  durationSeconds: 0.9,
  modes: [
    // [freq Hz, decay s, amp]   role
    [ 100, 0.55, 1.00],         // Helmholtz "air mode" — soundhole
    [ 196, 0.32, 0.82],         // T(1,1)₂  top plate, coupled to air
    [ 285, 0.24, 0.70],         // T(1,1)₃  back plate, coupled
    [ 425, 0.16, 0.50],         // higher top-plate mode
    [ 610, 0.12, 0.36],
    [ 880, 0.09, 0.24],
    [1350, 0.06, 0.16],
  ],
}
```

The guitar values roughly follow documented mode frequencies for a classical guitar: the Helmholtz peak, the T(1,1) coupled pair, the higher top-plate modes. These have decades of measurement literature behind them and vary only a few Hz between real instruments. Decay times come from the same place: low modes hold longest, high modes die quickly because they radiate efficiently. Amplitudes are tastefully chosen.

Generation is one nested loop:

```javascript
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
```

A small phase offset on the right channel gives the body a subtle stereo spread: when the modes interfere slightly differently between the ears, the body feels wider without sounding artificially stereoized.

The whole IR is computed in maybe 30 ms at startup, and again whenever the user switches presets. No fetch, no decode, no licensing question, no file in the build.

### Why this is the right amount of physics

I'm aware this isn't waveguide synthesis and it's not a finite-element model of a vibrating top plate. The body isn't reacting to what the string is doing: the string feeds energy into the body, but the body isn't pulling back the way it does on a real instrument where the bridge couples _bidirectionally_. The IR is a linear, time-invariant approximation of one specific impulse response. Real bodies are nonlinear, mildly position-dependent, and have transient behaviour the modal sum just doesn't reproduce.

But here's the thing: the convolution costs a `ConvolverNode`, which is one of the most heavily optimized parts of WebAudio. The synthesis costs 30 ms once. And the result is a voice that sounds _like a guitar_ in a way that bare Karplus-Strong does not. The Helmholtz mode in particular, that low 100 Hz peak, is what your ear hooks onto as "wooden box." Add it and you cross the perceptual line into "instrument." Skip it and you're a synth pad.

The koto and banjo presets are eyeballed rather than measured, and the differences are striking. The koto's tightly-spaced low modes give it that hollow, resonant body. The banjo, with most of its energy up around 600 Hz and very short decays, gets the unmistakable plink.

## The signal graph

The whole thing is small enough to draw:

```
  keypress → noteOn(midi)
                │
                ▼
   AudioWorkletNode (karplus-strong)   ← one per simultaneous note
                │
                ▼
             voiceBus ──►   dryGain    ──┐
                  └────► ConvolverNode ──► wetGain ──┤
                                                     ▼
                                                   master ──► destination
                                                     └────► AnalyserNode (viz)
```

A few choices in there are deliberate:

**Parallel dry and wet.** I send the voice bus to _both_ the convolver and a dry tap. With a 100% wet send you can hear how much the body has smeared the attack, the transient gets softer. Keeping some dry signal in the mix preserves the crispness of the pluck and lets the body sit underneath like reverb. The mix function clamps dry to a minimum of 0.35 for exactly this reason:

```javascript
setBodyMix(wet) {
  this.dryGain.gain.value = Math.max(0.35, 1 - wet);
  this.wetGain.gain.value = wet * 1.6;
}
```

**One bus, many voices.** Every voice node connects to a single `voiceBus`. The convolver runs once, not once per voice. This matters: `ConvolverNode` is cheap but not free, and convolving N voices through N separate convolvers is _N times_ more expensive than summing N voices first and convolving the sum once. Convolution distributes over addition. The body is the same for every string. Do it once. Polyphony then costs almost nothing beyond the worklets themselves.

**Wet boost.** Convolving with a normalized IR almost always loses perceived loudness: the body smears energy across time, so peak amplitude drops. I scale `wetGain.gain` by 1.6 to compensate.

**AnalyserNode for the visualizer.** Tapped off `master`, FFT size 2048, time-domain only. The waveform on screen shows the polyphonic mix in real time. Watching the Helmholtz mode beat against the fundamental of a low-C pluck is mildly hypnotic.

## The parameters worth exposing

I gave the user four sliders and a body picker, and stopped. This was deliberate. Karplus-Strong has roughly two interesting axes (decay and brightness), and the pluck is a third. Adding more controls, separate damping for the noise burst vs. the steady state, biquad pre-emphasis on the excitation, EQ on the wet bus, is technically easy and rapidly turns the instrument into a synth-design exercise instead of something you play.

- **Sustain** maps to the damping coefficient: the loop gain. Just under 1.0 sustains for seconds. At 0.85 the string is essentially dead.
- **Brightness** is the lowpass α. Small α means an aggressive lowpass; harmonics die fast each loop, the tone darkens.
- **Pluck** controls the smoothing on the initial noise burst. Hard pluck → bright attack, soft pluck → thumb-plucked dullness.
- **Body** picks the mode table.
- **Mix** sets the wet send.

The mappings expose the algorithm to the player without making them think in dB or seconds. "Brightness" is a perceptual word; "lowpass α" is a DSP word; they happen to be the same knob. That's the kind of one-to-one mapping I think instruments should have, and it's the kind procedural synthesis lets you build naturally: every parameter in the UI corresponds to a single variable somewhere in the loop.

## What I'd do differently

A few honest notes from the rear-view mirror.

**The body should be live, not a one-shot IR.** A real instrument body responds to the string at every moment: there's continuous coupling, not a single impulse at note-on. A more faithful version would put each mode as its own resonant `BiquadFilter`, running in parallel with the string in real time, so that two-string interactions, hammer-ons, and changes in playing pressure would all excite the body live. Convolution captures the _shape_ of the body response, but not its _liveness_. You can hear the difference if you play many notes very fast: the convolver smears them, but they don't interact through the body the way they would on a real guitar.

**Bridge feedback is missing entirely.** On a real guitar the bridge moves with the body, which feeds back into the string. This is what gives a guitar that slight pitch wobble on a hard pluck: the string sees a moving boundary, not a fixed one. The Karplus-Strong loop has a rigid termination. Modelling bridge admittance is its own paper.

**Mode tables for non-Western instruments are eyeballed.** I'd love to measure my actual instruments and dial the koto preset in. The frequencies are plausible; the amplitudes are vibes.

**Buffer length should follow frequency for high notes.** At very high pitches the delay line is only a handful of samples, and the quantization of N = floor(sampleRate / f₀) starts pulling notes flat. A linear-interpolated read tap would fix it. I haven't yet.

## Why procedural

The conventional path for browser instruments is samples: record a great guitar, chop it, layer round-robins, ship megabytes of audio. It sounds wonderful, and it's how every commercial sample library works.

But it also locks you into one specific guitar, and into one specific _recording_ of it. Procedural synthesis lets the parameters move smoothly. You can interpolate the body from guitar to koto without crossfading recordings, and the in-between sounds are themselves coherent instruments rather than glitchy averages of two unrelated audio files. The whole instrument fits in roughly 700 lines of code and zero bytes of audio. Reloading the page doesn't pull a CDN. Every voice is computed live.

That's a different aesthetic than the sample-based world, and the web is the right place for it. Bandwidth is precious, the `AudioWorklet` is real now, and the math is genuinely small. A plucked string and a wooden box, both expressed as a few hundred floating-point operations per sample.

A guitar is two things. So is the code.

---

_Source: a single HTML file, one worklet, and one instrument module. Karplus & Strong (1983) for the string algorithm; Christensen & Vistisen (1980) and Jansson's various papers for the guitar body mode frequencies; everything else is in the repo._
