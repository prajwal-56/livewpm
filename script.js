/**
 * Live WPM — Minimal Real-Time Typing Speed & Speedometer
 */

(function () {
  'use strict';

  // Elements
  const typeArea = document.getElementById('typeArea');
  const liveWpmEl = document.getElementById('liveWpm');
  const avgWpmEl = document.getElementById('avgWpm');
  const peakWpmEl = document.getElementById('peakWpm');
  const charCountEl = document.getElementById('charCount');
  const wordCountEl = document.getElementById('wordCount');
  const gaugeFillEl = document.getElementById('gaugeFill');
  const statusIndicatorEl = document.getElementById('statusIndicator');
  const statusTextEl = document.getElementById('statusText');
  const resetBtn = document.getElementById('resetBtn');

  // Mode Elements
  const modeBtnText = document.getElementById('modeBtnText');
  const modeBtnGauge = document.getElementById('modeBtnGauge');
  const modeBtnGraph = document.getElementById('modeBtnGraph');

  // Speedometer Elements
  const speedoArcFill = document.getElementById('speedoArcFill');
  const speedoNeedleGroup = document.getElementById('speedoNeedleGroup');
  const speedoValueEl = document.getElementById('speedoValue');
  const tierPillSimple = document.getElementById('tierPillSimple');
  const tierPillGauge = document.getElementById('tierPillGauge');
  
  // Graph Elements
  const graphWpmEl = document.getElementById('graphWpm');
  const tierPillGraph = document.getElementById('tierPillGraph');
  const speedCanvas = document.getElementById('speedCanvas');
  const ctx = speedCanvas ? speedCanvas.getContext('2d') : null;

  // Configuration
  const WINDOW_MS = 2500;       // 2.5s sliding window for live velocity
  const IDLE_TIMEOUT_MS = 1400; // Idle threshold before decay kicks in
  const MAX_SPEEDO_WPM = 180;   // Speedometer gauge upper bound
  const MAX_BAR_WPM = 130;      // Horizontal bar gauge upper bound

  // Speed Tiers config
  const TIERS = [
    { threshold: 0,   index: 0, label: 'Warmup' },
    { threshold: 30,  index: 1, label: 'Cruising' },
    { threshold: 60,  index: 2, label: 'Brisk' },
    { threshold: 85,  index: 3, label: 'Fast' },
    { threshold: 120, index: 4, label: 'Supersonic' }
  ];

  // State
  let keystrokeLog = [];        // [{ time: DOMHighResTimeStamp, chars: number }]
  let previousTextLength = 0;
  let sessionStartTime = null;
  let lastKeystrokeTime = null;
  let totalActiveTimeMs = 0;
  let totalCharsTyped = 0;
  let peakWpm = 0;

  let currentDisplayedWpm = 0;
  let targetLiveWpm = 0;
  let isTyping = false;
  let currentTierIndex = -1;
  let arcTotalLength = 460.7;
  
  const GRAPH_MAX_POINTS = 200;
  let graphHistory = new Array(GRAPH_MAX_POINTS).fill(0);
  let currentGraphColor = [75, 74, 68];
  let currentGraphMaxWpm = 180;

  // Helper
  function hexToRgb(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const int = parseInt(hex, 16);
    if (isNaN(int)) return [75, 74, 68];
    return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
  }

  // Initialize
  function init() {
    typeArea.focus();

    // Calculate exact SVG arc path length
    if (speedoArcFill && speedoArcFill.getTotalLength) {
      arcTotalLength = speedoArcFill.getTotalLength();
      speedoArcFill.style.strokeDasharray = `${arcTotalLength}`;
      speedoArcFill.style.strokeDashoffset = `${arcTotalLength}`;
    }

    // Set initial tier
    updateSpeedTier(0);

    // Load saved view mode or default to text
    const savedMode = localStorage.getItem('livewpm_view_mode') || 'text';
    setViewMode(savedMode);

    // Event listeners
    typeArea.addEventListener('input', handleInput);
    typeArea.addEventListener('keydown', handleKeyDown);
    resetBtn.addEventListener('click', resetAll);

    modeBtnText.addEventListener('click', () => setViewMode('text'));
    modeBtnGauge.addEventListener('click', () => setViewMode('gauge'));
    modeBtnGraph.addEventListener('click', () => setViewMode('graph'));

    // Global shortcut: Esc resets
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        resetAll();
      }
    });

    // Start render loop
    requestAnimationFrame(renderLoop);
  }

  function setViewMode(mode) {
    document.body.setAttribute('data-view', mode);
    localStorage.setItem('livewpm_view_mode', mode);

    [modeBtnText, modeBtnGauge, modeBtnGraph].forEach(btn => {
      if (btn.dataset.mode === mode) {
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
      } else {
        btn.classList.remove('active');
        btn.setAttribute('aria-selected', 'false');
      }
    });

    typeArea.focus();
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      resetAll();
    }
  }

  function handleInput(e) {
    const now = performance.now();
    const currentLength = typeArea.value.length;
    const delta = currentLength - previousTextLength;

    if (!sessionStartTime) {
      sessionStartTime = now;
    }

    // Accumulate active typing time
    if (lastKeystrokeTime) {
      const gap = now - lastKeystrokeTime;
      // If gap is reasonable (less than 2s), count towards active time
      if (gap < 2000) {
        totalActiveTimeMs += gap;
      }
    }
    lastKeystrokeTime = now;

    // Only count realistic typing actions towards WPM velocity
    let charsAdded = 0;
    if (e.inputType === 'insertFromPaste') {
      // Pasted text: do not skew live typing speed
      charsAdded = 0;
    } else if (delta === -1 || e.inputType === 'deleteContentBackward') {
      // Single backspace/delete counts as 1 keystroke effort
      charsAdded = 1;
    } else if (delta > 0) {
      // Normal character entry (clamp bursts from IME/autocomplete)
      charsAdded = Math.min(delta, 5);
    }

    if (charsAdded > 0) {
      keystrokeLog.push({ time: now, chars: charsAdded });
      totalCharsTyped += charsAdded;
    }

    previousTextLength = currentLength;
    setTypingState(true);

    // Quick subtle pulse on number
    liveWpmEl.classList.remove('pulse');
    void liveWpmEl.offsetWidth; // trigger reflow
    liveWpmEl.classList.add('pulse');

    updateTextCounts();
  }

  function setTypingState(typing) {
    if (isTyping !== typing) {
      isTyping = typing;
      if (typing) {
        statusIndicatorEl.classList.add('active');
        statusTextEl.textContent = 'typing';
      } else {
        statusIndicatorEl.classList.remove('active');
        statusTextEl.textContent = 'idle';
      }
    }
  }

  function updateTextCounts() {
    const text = typeArea.value.trim();
    charCountEl.textContent = typeArea.value.length;
    
    // Count words (words separated by whitespace)
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
    wordCountEl.textContent = words;
  }

  function calculateLiveWpm(now) {
    // Purge records older than sliding window
    const windowStart = now - WINDOW_MS;
    keystrokeLog = keystrokeLog.filter(item => item.time >= windowStart);

    if (keystrokeLog.length === 0) {
      return 0;
    }

    // Sum characters in window
    const charsInWindow = keystrokeLog.reduce((sum, item) => sum + item.chars, 0);

    // Determine the effective duration of the window
    const oldestInWindow = keystrokeLog[0].time;
    const windowDurationSec = Math.max(0.65, (now - oldestInWindow) / 1000);

    // 5 characters = 1 standard word
    const words = charsInWindow / 5;
    const minutes = windowDurationSec / 60;
    const rawWpm = words / minutes;

    return Math.max(0, rawWpm);
  }

  function calculateAverageWpm() {
    if (totalActiveTimeMs < 1000 || totalCharsTyped === 0) {
      return 0;
    }
    const totalMinutes = (totalActiveTimeMs / 1000) / 60;
    const totalWords = totalCharsTyped / 5;
    return Math.round(totalWords / totalMinutes);
  }

  function updateSpeedTier(wpm) {
    let tier = TIERS[0];
    for (let i = TIERS.length - 1; i >= 0; i--) {
      if (wpm >= TIERS[i].threshold) {
        tier = TIERS[i];
        break;
      }
    }

    if (tier.index !== currentTierIndex) {
      currentTierIndex = tier.index;
      document.body.setAttribute('data-tier', tier.index);
      tierPillSimple.textContent = tier.label;
      tierPillGauge.textContent = tier.label;
    }
  }

  function renderLoop() {
    const now = performance.now();

    // Check idle status
    if (lastKeystrokeTime) {
      const timeSinceLastKey = now - lastKeystrokeTime;
      if (timeSinceLastKey > IDLE_TIMEOUT_MS) {
        setTypingState(false);
        // Gradually decay target live WPM when idle
        targetLiveWpm = 0;
      } else {
        targetLiveWpm = calculateLiveWpm(now);
      }
    } else {
      targetLiveWpm = 0;
    }

    // Smooth lerp towards target WPM
    const lerpFactor = targetLiveWpm === 0 ? 0.08 : 0.2;
    currentDisplayedWpm += (targetLiveWpm - currentDisplayedWpm) * lerpFactor;

    // Snap to 0 if very small
    if (currentDisplayedWpm < 0.3) {
      currentDisplayedWpm = 0;
    }

    const roundedLiveWpm = Math.round(currentDisplayedWpm);

    // Update numbers
    liveWpmEl.textContent = roundedLiveWpm;
    speedoValueEl.textContent = roundedLiveWpm;
    if (graphWpmEl) graphWpmEl.textContent = roundedLiveWpm;

    // Track graph history
    graphHistory.push(currentDisplayedWpm);
    if (graphHistory.length > GRAPH_MAX_POINTS) {
      graphHistory.shift();
    }

    // Update speed tier & color
    updateSpeedTier(roundedLiveWpm);

    // Track peak WPM
    if (roundedLiveWpm > peakWpm) {
      peakWpm = roundedLiveWpm;
      peakWpmEl.textContent = peakWpm;
    }

    // Update Average Wpm
    avgWpmEl.textContent = calculateAverageWpm();

    // Horizontal bar meter
    const barPercent = Math.min(100, (currentDisplayedWpm / MAX_BAR_WPM) * 100);
    gaugeFillEl.style.width = `${barPercent.toFixed(1)}%`;

    // Speedometer needle angle & arc
    // Needle sweeps from -120deg (0 WPM) to +120deg (180 WPM) = 240deg total
    const speedRatio = Math.min(1, currentDisplayedWpm / MAX_SPEEDO_WPM);
    const needleAngle = -120 + (speedRatio * 240);
    speedoNeedleGroup.style.transform = `rotate(${needleAngle.toFixed(2)}deg)`;

    // Speedometer colored arc offset
    const arcOffset = arcTotalLength * (1 - speedRatio);
    speedoArcFill.style.strokeDashoffset = `${arcOffset.toFixed(2)}`;

    // Render ECG Graph
    drawGraph();

    requestAnimationFrame(renderLoop);
  }

  function drawGraph() {
    if (!ctx || document.body.getAttribute('data-view') !== 'graph') return;

    const now = performance.now();
    const style = getComputedStyle(document.body);
    const speedHex = style.getPropertyValue('--speed-color').trim() || '#4b4a44';
    const borderSubtle = style.getPropertyValue('--border-subtle').trim() || '#dedbd2';

    // Determine if user is slowing down (idle for 800ms OR dropping active WPM)
    let isSlowing = false;
    if (currentDisplayedWpm > 2) {
      if (targetLiveWpm < currentDisplayedWpm - 1.5) isSlowing = true;
      if (lastKeystrokeTime && (now - lastKeystrokeTime > 800)) isSlowing = true;
    }

    // Blend color towards vibrant red if slowing, otherwise use speed tier color
    const targetRgb = isSlowing ? [225, 29, 72] : hexToRgb(speedHex);
    
    // Smooth lerp for color transition
    currentGraphColor[0] += (targetRgb[0] - currentGraphColor[0]) * 0.08;
    currentGraphColor[1] += (targetRgb[1] - currentGraphColor[1]) * 0.08;
    currentGraphColor[2] += (targetRgb[2] - currentGraphColor[2]) * 0.08;

    const r = Math.round(currentGraphColor[0]);
    const g = Math.round(currentGraphColor[1]);
    const b = Math.round(currentGraphColor[2]);
    const rgbSolid = `rgb(${r}, ${g}, ${b})`;

    const dpr = window.devicePixelRatio || 1;
    const rect = speedCanvas.getBoundingClientRect();
    
    // Resize only if needed
    if (speedCanvas.width !== rect.width * dpr || speedCanvas.height !== rect.height * dpr) {
      speedCanvas.width = rect.width * dpr;
      speedCanvas.height = rect.height * dpr;
    }
    
    const w = speedCanvas.width;
    const h = speedCanvas.height;
    
    // Dedicated axis area on the left
    const padLeft = 35 * dpr;
    const graphW = w - padLeft;

    // Determine dynamic Y-axis scale (zoom out if typing super fast)
    const peakInHistory = Math.max(...graphHistory, currentDisplayedWpm);
    const targetMax = Math.max(180, peakInHistory * 1.2); 
    currentGraphMaxWpm += (targetMax - currentGraphMaxWpm) * 0.05;

    // Reset shadow state and clear canvas
    ctx.shadowBlur = 0;
    ctx.clearRect(0, 0, w, h);

    // 1. Rich Interactive Background
    const bgRadial = ctx.createRadialGradient(padLeft + graphW/2, h/2, 0, padLeft + graphW/2, h/2, graphW/1.5);
    bgRadial.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.08)`);
    bgRadial.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.0)`);
    ctx.fillStyle = bgRadial;
    ctx.fillRect(padLeft, 0, graphW, h);

    // 2. Draw Dynamic Scrolling Grid
    ctx.strokeStyle = borderSubtle;
    ctx.lineWidth = 1 * dpr;
    
    // Vertical grid lines (Dotted & Scrolling for telemetry radar feel)
    ctx.setLineDash([2 * dpr, 4 * dpr]);
    ctx.beginPath();
    const vGridStep = graphW / 12;
    const scrollOffset = (now / 30) % vGridStep;
    for (let x = padLeft - scrollOffset; x <= w; x += vGridStep) {
        if (x >= padLeft) { 
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
        }
    }
    ctx.stroke();

    // Horizontal grid lines (Dashed)
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath();
    const gridStep = 30;
    const maxGridLine = Math.ceil(currentGraphMaxWpm / gridStep) * gridStep;
    for (let val = 0; val <= maxGridLine; val += gridStep) {
        const y = h - (val / currentGraphMaxWpm) * h;
        if (y >= 0 && y <= h) {
            ctx.moveTo(padLeft, y);
            ctx.lineTo(w, y);
        }
    }
    ctx.stroke();
    ctx.setLineDash([]); 

    // Axis separator line
    ctx.beginPath();
    ctx.moveTo(padLeft, 0);
    ctx.lineTo(padLeft, h);
    ctx.stroke();

    // 3. Draw Y-Axis Scale Labels
    const textMuted = style.getPropertyValue('--text-muted').trim() || '#87857d';
    ctx.font = `500 ${10 * dpr}px 'JetBrains Mono', monospace`;
    ctx.fillStyle = textMuted;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    
    for (let val = gridStep; val <= maxGridLine; val += gridStep) {
        const y = h - (val / currentGraphMaxWpm) * h;
        if (y >= 0 && y <= h) {
            ctx.fillText(val.toString(), padLeft - 6 * dpr, y);
        }
    }

    const endX = padLeft + (graphW * 0.78); 

    // 4. Digital Equalizer Bar Fill (Replaces solid gradient)
    ctx.beginPath();
    for (let i = 0; i < graphHistory.length; i += 4) {
        const x = padLeft + (i / (GRAPH_MAX_POINTS - 1)) * (endX - padLeft);
        const val = graphHistory[i];
        const y = h - (val / currentGraphMaxWpm) * h;
        if (val > 0.5) {
            ctx.moveTo(x, h);
            ctx.lineTo(x, y);
        }
    }
    const barGrad = ctx.createLinearGradient(padLeft, 0, endX, 0);
    barGrad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`);
    barGrad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.18)`);
    ctx.strokeStyle = barGrad;
    ctx.lineWidth = 1.5 * dpr;
    ctx.stroke();

    // 5. Telemetry Data Nodes (Tiny dots along the path)
    ctx.beginPath();
    for (let i = 0; i < graphHistory.length; i += 12) {
        const x = padLeft + (i / (GRAPH_MAX_POINTS - 1)) * (endX - padLeft);
        const val = graphHistory[i];
        const y = h - (val / currentGraphMaxWpm) * h;
        if (val > 2 && i < graphHistory.length - 5) { 
            ctx.moveTo(x, y);
            ctx.arc(x, y, 1.5 * dpr, 0, Math.PI * 2);
        }
    }
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.5)`;
    ctx.fill();

    // 6. Build & Draw the Main Neon Line
    ctx.beginPath();
    let lastX = padLeft, lastY = h;
    
    for (let i = 0; i < graphHistory.length; i++) {
        const x = padLeft + (i / (GRAPH_MAX_POINTS - 1)) * (endX - padLeft);
        const val = graphHistory[i];
        const y = h - (val / currentGraphMaxWpm) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        
        if (i === graphHistory.length - 1) {
            lastX = x;
            lastY = y;
        }
    }
    
    // Outer colored glow pass
    ctx.shadowBlur = 12 * dpr;
    ctx.shadowColor = rgbSolid;
    const strokeGrad = ctx.createLinearGradient(padLeft, 0, endX, 0);
    strokeGrad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`);
    strokeGrad.addColorStop(0.2, `rgba(${r}, ${g}, ${b}, 0.4)`);
    strokeGrad.addColorStop(1, rgbSolid);

    ctx.strokeStyle = strokeGrad;
    ctx.lineWidth = 3.5 * dpr;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
    
    // Inner bright core pass
    ctx.shadowBlur = 0;
    const coreGrad = ctx.createLinearGradient(padLeft, 0, endX, 0);
    coreGrad.addColorStop(0, `rgba(255, 255, 255, 0)`);
    coreGrad.addColorStop(0.6, `rgba(255, 255, 255, 0.1)`);
    coreGrad.addColorStop(1, `rgba(255, 255, 255, 0.8)`);
    ctx.strokeStyle = coreGrad;
    ctx.lineWidth = 1.5 * dpr;
    ctx.stroke();

    // 7. Draw Leading Node (Glowing Dot)
    const pulseR = (5 + Math.sin(now / 120) * 1.5) * dpr;
    ctx.beginPath();
    ctx.arc(lastX, lastY, pulseR, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.35)`;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(lastX, lastY, 3.5 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = rgbSolid;
    ctx.stroke();
  }

  function resetAll() {
    typeArea.value = '';
    previousTextLength = 0;
    keystrokeLog = [];
    sessionStartTime = null;
    lastKeystrokeTime = null;
    totalActiveTimeMs = 0;
    totalCharsTyped = 0;
    peakWpm = 0;
    targetLiveWpm = 0;
    currentDisplayedWpm = 0;
    graphHistory.fill(0);
    currentGraphMaxWpm = 180;

    liveWpmEl.textContent = '0';
    speedoValueEl.textContent = '0';
    if (graphWpmEl) graphWpmEl.textContent = '0';
    avgWpmEl.textContent = '0';
    peakWpmEl.textContent = '0';
    charCountEl.textContent = '0';
    wordCountEl.textContent = '0';
    gaugeFillEl.style.width = '0%';
    speedoArcFill.style.strokeDashoffset = `${arcTotalLength}`;
    speedoNeedleGroup.style.transform = 'rotate(-120deg)';

    updateSpeedTier(0);
    setTypingState(false);

    typeArea.focus();
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
