/* ─────────────────────────────────────────────────────────────────────
   Pluck · presentation
   Procedurally drawn SVG diagrams.
   The diagrams are computed from the same math the instrument uses,
   so the visualization is honest — not a stylized cartoon.
   ──────────────────────────────────────────────────────────────────── */


/* ── Karplus-Strong loop diagram ───────────────────────────────────── */
function drawKarplusStrongDiagram(container) {
  // The diagram reads left-to-right at the top (the active forward path)
  // and the feedback wraps below in the accent colour, so the "loop" is
  // visually obvious without forcing the viewer to read arrows.
  const svg = `
    <svg viewBox="0 0 700 380" xmlns="http://www.w3.org/2000/svg" role="img"
         aria-label="Karplus-Strong feedback loop block diagram">

      <defs>
        <marker id="ks-arrow" viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#1a1816"/>
        </marker>
        <marker id="ks-arrow-accent" viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#b8862c"/>
        </marker>
      </defs>

      <!-- Pluck input -->
      <text x="100" y="60" text-anchor="middle" font-family="JetBrains Mono"
            font-size="11" fill="#5a5346" letter-spacing="1">PLUCK</text>
      <text x="100" y="80" text-anchor="middle" font-family="Fraunces"
            font-style="italic" font-size="14" fill="#1a1816">noise burst</text>
      <line x1="100" y1="95" x2="100" y2="135" stroke="#1a1816" stroke-width="1.4"
            marker-end="url(#ks-arrow)"/>

      <!-- Delay line -->
      <rect x="40" y="140" width="620" height="80" fill="none"
            stroke="#1a1816" stroke-width="1.4"/>
      <text x="350" y="175" text-anchor="middle" font-family="Fraunces"
            font-style="italic" font-weight="400" font-size="22" fill="#1a1816">
        delay line
      </text>
      <text x="350" y="200" text-anchor="middle" font-family="JetBrains Mono"
            font-size="13" fill="#5a5346">N = sampleRate / f₀</text>

      <!-- Cell tick marks inside the buffer to suggest sample slots -->
      <g stroke="#d6cfbf" stroke-width="1">
        <line x1="115" y1="140" x2="115" y2="220"/>
        <line x1="190" y1="140" x2="190" y2="220"/>
        <line x1="265" y1="140" x2="265" y2="220"/>
        <line x1="435" y1="140" x2="435" y2="220"/>
        <line x1="510" y1="140" x2="510" y2="220"/>
        <line x1="585" y1="140" x2="585" y2="220"/>
      </g>

      <!-- Output tap -->
      <line x1="660" y1="180" x2="700" y2="180" stroke="#1a1816"
            stroke-width="1.4" marker-end="url(#ks-arrow)" pathLength="1"
            stroke-dasharray="0"/>
      <!-- (use simple line to right edge then a label past the viewBox is fine but let's keep inside) -->
      <line x1="620" y1="180" x2="675" y2="180" stroke="#1a1816"
            stroke-width="1.4" marker-end="url(#ks-arrow)"/>
      <text x="690" y="184" text-anchor="end" font-family="Fraunces"
            font-style="italic" font-size="16" fill="#1a1816">y[n]</text>

      <!-- Feedback path: down from output, through filter & gain, back to input -->
      <path d="M 645 180 L 645 295" fill="none" stroke="#b8862c" stroke-width="1.6"/>

      <!-- Lowpass filter block -->
      <rect x="430" y="280" width="180" height="40" fill="#f5f3ee"
            stroke="#b8862c" stroke-width="1.6"/>
      <text x="520" y="305" text-anchor="middle" font-family="JetBrains Mono"
            font-size="13" fill="#8d6519" letter-spacing="0.5">low-pass · α</text>

      <!-- Wire from filter to gain -->
      <line x1="430" y1="300" x2="370" y2="300" stroke="#b8862c"
            stroke-width="1.6"/>

      <!-- Gain (multiplier) circle -->
      <circle cx="350" cy="300" r="22" fill="#f5f3ee" stroke="#b8862c"
              stroke-width="1.6"/>
      <text x="350" y="306" text-anchor="middle" font-family="JetBrains Mono"
            font-size="14" fill="#8d6519">×g</text>

      <!-- Wire from gain back up to delay-line input -->
      <path d="M 328 300 L 100 300 L 100 220" fill="none" stroke="#b8862c"
            stroke-width="1.6" marker-end="url(#ks-arrow-accent)"/>

      <!-- Annotation labels -->
      <text x="610" y="270" text-anchor="end" font-family="JetBrains Mono"
            font-size="10" fill="#918a7a" letter-spacing="1.5">FEEDBACK</text>
    </svg>
  `;
  container.innerHTML = svg;
}


/* ── Modal-synthesis impulse-response visualization ────────────────── */

/**
 * Sample one decaying sinusoid into an SVG path string.
 * Parameters mirror the real instrument code so this isn't a fake sketch.
 */
function buildModePath(freq, decay, amplitude, durationSeconds, options) {
  const { width, height, midY, samples } = options;
  const pieces = [];
  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * durationSeconds;
    const value = amplitude * Math.exp(-t / decay) *
                  Math.sin(2 * Math.PI * freq * t);
    const x = (i / samples) * width;
    const y = midY - value * (height / 2);
    pieces.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return 'M ' + pieces.join(' L ');
}

/**
 * Sum many modes at the same time grid. Used for the bottom "= IR" trace.
 */
function buildSumPath(modes, durationSeconds, options) {
  const { width, height, midY, samples } = options;
  const pieces = [];
  let peak = 0;
  // First pass: gather raw sums, find peak for normalisation
  const raw = [];
  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * durationSeconds;
    let s = 0;
    for (const [f, tau, a] of modes) {
      s += a * Math.exp(-t / tau) * Math.sin(2 * Math.PI * f * t);
    }
    raw.push(s);
    if (Math.abs(s) > peak) peak = Math.abs(s);
  }
  // Second pass: emit normalised path
  const scale = peak === 0 ? 1 : 0.95 / peak;
  for (let i = 0; i <= samples; i++) {
    const x = (i / samples) * width;
    const y = midY - raw[i] * scale * (height / 2);
    pieces.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return 'M ' + pieces.join(' L ');
}

function drawModalDiagram(container) {
  // Subset of the guitar preset, chosen for visual clarity at the
  // duration we're rendering (modes tightly packed in time look like noise).
  const visModes = [
    [100, 0.55, 1.00],
    [196, 0.32, 0.82],
    [285, 0.24, 0.70],
  ];
  const duration = 0.20;       // seconds rendered horizontally
  const traceWidth = 540;
  const traceHeight = 56;
  const samples = 700;

  const opts = (midY) => ({ width: traceWidth, height: traceHeight, midY, samples });

  const labels = ['100 Hz · τ 0.55 s', '196 Hz · τ 0.32 s', '285 Hz · τ 0.24 s'];

  // Build three small mode rows + one larger summed row.
  let modeRows = '';
  visModes.forEach(([f, tau, a], idx) => {
    const yBase = 40 + idx * 70;
    const path = buildModePath(f, tau, a, duration, opts(yBase));
    modeRows += `
      <text x="0" y="${yBase - 26}" font-family="JetBrains Mono" font-size="10"
            fill="#918a7a" letter-spacing="1">${labels[idx]}</text>
      <line x1="0" y1="${yBase}" x2="${traceWidth}" y2="${yBase}"
            stroke="#e6dfcd" stroke-width="1"/>
      <path d="${path}" fill="none" stroke="#5a5346" stroke-width="1.1"/>
      <text x="${traceWidth + 18}" y="${yBase + 4}" font-family="Fraunces"
            font-style="italic" font-size="20" fill="#5a5346">+</text>
    `;
  });

  // Sum row uses a fuller-amplitude trace and the accent colour
  const sumY = 280;
  const sumPath = buildSumPath(visModes, duration, {
    width: traceWidth, height: 90, midY: sumY, samples,
  });
  const sumRow = `
    <line x1="0" y1="${sumY - 60}" x2="${traceWidth}" y2="${sumY - 60}"
          stroke="#1a1816" stroke-width="1"/>
    <text x="0" y="${sumY - 38}" font-family="JetBrains Mono" font-size="10"
          fill="#8d6519" letter-spacing="1">= IMPULSE RESPONSE</text>
    <line x1="0" y1="${sumY}" x2="${traceWidth}" y2="${sumY}"
          stroke="#e6dfcd" stroke-width="1"/>
    <path d="${sumPath}" fill="none" stroke="#b8862c" stroke-width="1.4"/>
  `;

  container.innerHTML = `
    <svg viewBox="0 -10 ${traceWidth + 40} 360" xmlns="http://www.w3.org/2000/svg"
         role="img" aria-label="Three damped sinusoids summing to an impulse response">
      ${modeRows}
      ${sumRow}
    </svg>
  `;
}


/* ── Architecture / signal-flow diagram ────────────────────────────── */
function drawArchDiagram(container) {
  // Read top-to-bottom: input source → multiple voices → bus → split into
  // dry & wet (convolved) → recombined at master → output. The accent
  // colour highlights the body-modeling branch since that's the slide's
  // main story.
  const svg = `
    <svg viewBox="0 0 900 460" xmlns="http://www.w3.org/2000/svg" role="img"
         aria-label="Signal flow from key press to audio destination">

      <defs>
        <marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="#1a1816"/>
        </marker>
        <marker id="arch-arrow-accent" viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="#b8862c"/>
        </marker>
      </defs>

      <!-- 1. Trigger source -->
      <g>
        <rect x="350" y="20" width="200" height="50" fill="none"
              stroke="#1a1816" stroke-width="1.4"/>
        <text x="450" y="44" text-anchor="middle" font-family="JetBrains Mono"
              font-size="10" fill="#918a7a" letter-spacing="1.5">INPUT</text>
        <text x="450" y="60" text-anchor="middle" font-family="Fraunces"
              font-style="italic" font-size="16" fill="#1a1816">QWERTY · touch</text>
      </g>

      <line x1="450" y1="70" x2="450" y2="105" stroke="#1a1816"
            stroke-width="1.4" marker-end="url(#arch-arrow)"/>

      <!-- 2. Voice nodes (3 representative) -->
      <g>
        <rect x="220" y="110" width="460" height="80" fill="none"
              stroke="#1a1816" stroke-width="1.4"/>
        <text x="450" y="134" text-anchor="middle" font-family="JetBrains Mono"
              font-size="10" fill="#918a7a" letter-spacing="1.5">PER-NOTE VOICES</text>
        <text x="450" y="156" text-anchor="middle" font-family="Fraunces"
              font-style="italic" font-size="20" fill="#1a1816">
          AudioWorkletNode × N
        </text>
        <text x="450" y="176" text-anchor="middle" font-family="JetBrains Mono"
              font-size="11" fill="#5a5346">Karplus-Strong string</text>
      </g>

      <line x1="450" y1="190" x2="450" y2="225" stroke="#1a1816"
            stroke-width="1.4" marker-end="url(#arch-arrow)"/>

      <!-- 3. Voice bus (sum) -->
      <g>
        <rect x="350" y="230" width="200" height="46" fill="none"
              stroke="#1a1816" stroke-width="1.4"/>
        <text x="450" y="252" text-anchor="middle" font-family="JetBrains Mono"
              font-size="10" fill="#918a7a" letter-spacing="1.5">SUM</text>
        <text x="450" y="268" text-anchor="middle" font-family="Fraunces"
              font-style="italic" font-size="15" fill="#1a1816">voice bus · GainNode</text>
      </g>

      <!-- 4. Split: dry and wet branches -->
      <!-- Dry branch (left) -->
      <path d="M 380 276 L 380 310 L 200 310 L 200 340" fill="none"
            stroke="#1a1816" stroke-width="1.4" marker-end="url(#arch-arrow)"/>
      <g>
        <rect x="100" y="345" width="200" height="46" fill="none"
              stroke="#1a1816" stroke-width="1.4"/>
        <text x="200" y="367" text-anchor="middle" font-family="JetBrains Mono"
              font-size="10" fill="#918a7a" letter-spacing="1.5">DRY</text>
        <text x="200" y="383" text-anchor="middle" font-family="Fraunces"
              font-style="italic" font-size="15" fill="#1a1816">GainNode (1−w)</text>
      </g>

      <!-- Wet branch (right) — accent -->
      <path d="M 520 276 L 520 310 L 700 310 L 700 340" fill="none"
            stroke="#b8862c" stroke-width="1.5"
            marker-end="url(#arch-arrow-accent)"/>
      <g>
        <rect x="600" y="345" width="200" height="46" fill="#fdfaf3"
              stroke="#b8862c" stroke-width="1.5"/>
        <text x="700" y="367" text-anchor="middle" font-family="JetBrains Mono"
              font-size="10" fill="#8d6519" letter-spacing="1.5">WET · BODY</text>
        <text x="700" y="383" text-anchor="middle" font-family="Fraunces"
              font-style="italic" font-size="15" fill="#1a1816">
          ConvolverNode (modal IR)
        </text>
      </g>

      <!-- 5. Recombine into master -->
      <path d="M 200 391 L 200 420 L 440 420" fill="none"
            stroke="#1a1816" stroke-width="1.4" marker-end="url(#arch-arrow)"/>
      <path d="M 700 391 L 700 420 L 460 420" fill="none"
            stroke="#b8862c" stroke-width="1.5"
            marker-end="url(#arch-arrow-accent)"/>

      <g>
        <rect x="375" y="420" width="150" height="32" fill="none"
              stroke="#1a1816" stroke-width="1.4"/>
        <text x="450" y="441" text-anchor="middle" font-family="Fraunces"
              font-style="italic" font-size="14" fill="#1a1816">→ destination</text>
      </g>
    </svg>
  `;
  container.innerHTML = svg;
}


/* ── Boot ──────────────────────────────────────────────────────────── */
drawKarplusStrongDiagram(document.getElementById('ksDiagram'));
drawModalDiagram(document.getElementById('modalViz'));
drawArchDiagram(document.getElementById('archDiagram'));
