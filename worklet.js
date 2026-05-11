/**
 * Karplus-Strong plucked-string AudioWorklet processor.
 *
 * Each instance models a single string voice. The string is a circular
 * delay line of length N = sampleRate / frequency. Each sample we read
 * the oldest value out, feed it through a one-pole low-pass filter,
 * multiply by a damping coefficient < 1, and write it back to the
 * newest slot. The initial contents of the delay line — a short burst
 * of filtered noise — are the "pluck" excitation.
 *
 * Fundamental:        f0 = sampleRate / bufferSize
 * Decay:              controlled by `damping` parameter (loop gain)
 * Spectral roll-off:  controlled by `brightness` parameter (lowpass α)
 *
 * Using an AudioWorklet (rather than DelayNode + BiquadFilter in the
 * main graph) lets us have delay lines shorter than one render quantum,
 * which is required for pitches above ~340 Hz to be in tune.
 */
class KarplusStrongProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'damping',
        defaultValue: 0.996,
        minValue: 0.0,
        maxValue: 1.0,
        automationRate: 'k-rate',
      },
      {
        name: 'brightness',
        defaultValue: 0.5,
        minValue: 0.01,
        maxValue: 1.0,
        automationRate: 'k-rate',
      },
    ];
  }

  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    const frequency = opts.frequency || 220;
    const pluckHardness = opts.pluckHardness ?? 0.5;

    // Delay-line length sets the fundamental: f0 = sampleRate / N.
    // Clamp to at least 2 samples so the loop has somewhere to run.
    this.bufferSize = Math.max(2, Math.floor(sampleRate / frequency));
    this.delayLine = new Float32Array(this.bufferSize);
    this.readIndex = 0;

    this.lowpassState = 0;
    this.silenceCounter = 0;

    this.excite(pluckHardness);
  }

  /**
   * Initialize the delay line with the pluck excitation.
   * Hard plucks (hardness → 1) start as raw white noise — lots of
   * high-frequency content, bright attack. Soft plucks (hardness → 0)
   * are heavily smoothed, giving a duller, thumb-plucked sound.
   * The DC component is subtracted so the attack doesn't thud.
   */
  excite(hardness) {
    const smoothing = 1 - Math.max(0.02, hardness);
    let previous = 0;
    for (let i = 0; i < this.bufferSize; i++) {
      const noise = Math.random() * 2 - 1;
      previous = previous + (1 - smoothing) * (noise - previous);
      this.delayLine[i] = previous;
    }

    let sum = 0;
    for (let i = 0; i < this.bufferSize; i++) sum += this.delayLine[i];
    const mean = sum / this.bufferSize;
    for (let i = 0; i < this.bufferSize; i++) this.delayLine[i] -= mean;
  }

  process(_inputs, outputs, parameters) {
    const channel = outputs[0][0];
    const damping = parameters.damping[0];
    const brightness = parameters.brightness[0];

    let peak = 0;

    for (let i = 0; i < channel.length; i++) {
      const current = this.delayLine[this.readIndex];

      // One-pole IIR low-pass in the feedback path.
      // y[n] = α·x[n] + (1 − α)·y[n − 1]
      // Small α (dark) → high frequencies decay quickly, like a soft string.
      this.lowpassState =
        brightness * current + (1 - brightness) * this.lowpassState;

      // Damping is the loop gain. Values just under 1 give long sustain;
      // dropping it on noteOff accelerates the natural decay.
      const feedback = this.lowpassState * damping;

      channel[i] = current;
      this.delayLine[this.readIndex] = feedback;
      this.readIndex = (this.readIndex + 1) % this.bufferSize;

      const abs = current < 0 ? -current : current;
      if (abs > peak) peak = abs;
    }

    // Self-terminate once the voice has decayed below the audible floor
    // (~ −66 dB) for a few render quanta. We notify the main thread so it
    // can disconnect this node; returning false then stops further calls.
    if (peak < 0.0005) this.silenceCounter++;
    else this.silenceCounter = 0;

    if (this.silenceCounter >= 12) {
      this.port.postMessage({ type: 'done' });
      return false;
    }
    return true;
  }
}

registerProcessor('karplus-strong', KarplusStrongProcessor);
