// ============================================================
// LJUDMONITOR v2.8 — App Logic
// ============================================================

// ---- STATE ----
let audioCtx = null, analyser = null, mediaStream = null;
let isRecording = false, animFrameId = null, updateInterval = null;

const HISTORY_LENGTH = 120;
const SAMPLE_INTERVAL = 500;
const historyLevels = new Float32Array(HISTORY_LENGTH);
const historyPhases = new Int8Array(HISTORY_LENGTH);
const historyTimes = new Float64Array(HISTORY_LENGTH);
let historyIndex = 0;
let historyCount = 0;
let phaseMarkers = [];

const PHASE_TO_ID = { none: 0, lecture: 1, quiet: 2, discussion: 3 };
const ID_TO_PHASE = ['none', 'lecture', 'quiet', 'discussion'];
let threshold = 50, calibrationOffset = 0;  // Lowered from 65 to 50 dB
let peakLevel = 0, totalSamples = 0, totalSum = 0, overThresholdCount = 0;

// EMA filter for smooth display
const EMA_ALPHA = 0.3;
let smoothedLevel = 0;

// Recovery gradient (0 = safe, 1 = danger)
let dangerLevel = 0;
const DANGER_RISE = 0.4;   // How fast danger rises
const DANGER_FALL = 0.15;  // How fast danger falls (slower = more forgiving)

// Student stat — VEP consensus: rotate variants, update on state change only
let lastStatState = null;  // 'good' | 'ok' | 'warn' | 'aurora' | 'break'
let projectorMode = false;  // VEP v2.8: reduced visual mode
const STAT_MSGS = {
    good: ['Lugn nivå ✓', 'Stark nivå ✓', 'Stabilt ✓'],
    ok: ['{t} — fortsätt', 'Nästan där — {t}'],
    warn: ['Lite högt just nu', 'Högt just nu — prova sänka'],
    aurora: ['✓'],
    break: ['Ny chans — kör!', 'Börja om — ni fixar det!', 'Reset — kör igen!'],
    discussion_good: ['Bra diskussionsnivå ✓', 'Lagom samtalston ✓', 'Produktivt samtal ✓']
};

// Streak
let streakStart = null, streakActive = false, bestStreak = 0;
let graceTimeout = null, streakBroken = false;
const GRACE_MS = 5000;  // Extended from 2000ms to 5000ms

// Phase — thresholds are configurable defaults
let currentPhase = 'none';
const PHASE_THRESHOLDS = {
    none: null,      // Uses manual slider value
    lecture: null,    // No auto-threshold — teacher talks, no student target
    quiet: 35,       // Low ceiling: individual focus work
    discussion: 65   // Higher ceiling: active group conversation
};
let phaseAdjustments = { quiet: 0, lecture: 0, discussion: 0 };  // Fine-tuning offsets
const PHASE_LABELS = { none: 'Ingen', lecture: 'Genomgång', quiet: 'Tyst arbete', discussion: 'Diskussion' };
const PHASE_COLORS = {
    none: { bg: 'rgba(99,102,241,0.15)', line: 'rgba(99,102,241,0.5)' },
    lecture: { bg: 'rgba(139,92,246,0.15)', line: 'rgba(139,92,246,0.5)' },
    quiet: { bg: 'rgba(34,197,94,0.15)', line: 'rgba(34,197,94,0.5)' },
    discussion: { bg: 'rgba(245,158,11,0.15)', line: 'rgba(245,158,11,0.5)' }
};

// Warning sound
let soundEnabled = false, lastWarningTime = 0;
const COOLDOWN_MS = 5000;
let cooldownTimer = null;

// Session
let sessionStartTime = null, sessionPhaseLog = [];

// Aurora
let auroraCtx = null, auroraAnimId = null, auroraIntensity = 0;

// ---- DOM REFS ----
const $ = id => document.getElementById(id);
const vuValue = $('vuValue'), vuRing = $('vuRing');
const statAvg = $('statAvg'), statPeak = $('statPeak'), statOver = $('statOver');
const statusBadge = $('statusBadge'), statusText = $('statusText');
const graphCanvas = $('volumeGraph'), graphCtx = graphCanvas.getContext('2d');
const thresholdSlider = $('thresholdSlider'), thresholdValueEl = $('thresholdValue');
const soundToggle = $('soundToggle');
const startBtn = $('startBtn'), startLabel = $('startLabel');
const calibrateBtn = $('calibrateBtn'), calibrationMsg = $('calibrationMsg');
const cooldownBar = $('cooldownBar'), cooldownFill = $('cooldownFill');
const streakTimeEl = $('streakTime'), streakBestEl = $('streakBest'), streakDisplay = $('streakDisplay');
const phaseHint = $('phaseHint');
const thresholdHint = $('thresholdHint');

// ---- INIT ----
function init() {
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    thresholdSlider.addEventListener('input', e => {
        threshold = parseInt(e.target.value);
        thresholdValueEl.textContent = threshold;
        drawGraph();
    });
    soundToggle.addEventListener('change', e => { soundEnabled = e.target.checked; });

    // Load persistent calibration
    const saved = localStorage.getItem('soundmonitor_calibration');
    if (saved) {
        const data = JSON.parse(saved);
        calibrationOffset = data.offset;
        if (data.thresholds) {
            PHASE_THRESHOLDS.quiet = data.thresholds.quiet;
            PHASE_THRESHOLDS.lecture = data.thresholds.lecture;
            PHASE_THRESHOLDS.discussion = data.thresholds.discussion;
        }
        calibrationMsg.textContent = 'Kalibrering laddad (' + data.date + ')';
        calibrationMsg.className = 'calibration-msg success';
        setTimeout(() => { calibrationMsg.textContent = ''; }, 3000);
    }

    // Load phase adjustments
    const savedAdj = localStorage.getItem('phaseAdjustments');
    if (savedAdj) {
        phaseAdjustments = JSON.parse(savedAdj);
    }

    // Load best streak
    const savedBest = localStorage.getItem('soundmonitor_best_streak');
    if (savedBest) bestStreak = parseInt(savedBest);

    // Init aurora canvas
    const ac = $('auroraCanvas');
    auroraCtx = ac.getContext('2d');
    function resizeAurora() { ac.width = window.innerWidth; ac.height = window.innerHeight; }
    resizeAurora();
    window.addEventListener('resize', resizeAurora);

    // Doubleclick fullscreen
    document.addEventListener('dblclick', e => {
        if (!$('fullscreenView').classList.contains('hidden')) exitFullscreen();
        else if (isRecording) enterFullscreen();
    });

    // Build graph legend
    buildGraphLegend();

    // Setup fine-tuning sliders
    setupTuneSliders();
    updateTuneDisplays();

    setPhase('none');
    drawGraph();
}

// ---- GRAPH LEGEND ----
function buildGraphLegend() {
    const legend = $('graphLegend');
    if (!legend) return;
    const items = [
        { label: 'Genomgång', color: 'rgba(139,92,246,0.5)' },
        { label: 'Tyst arbete', color: 'rgba(34,197,94,0.5)' },
        { label: 'Diskussion', color: 'rgba(245,158,11,0.5)' }
    ];
    legend.innerHTML = items.map(i =>
        `<div class="legend-item"><span class="legend-dot" style="background:${i.color}"></span>${i.label}</div>`
    ).join('');
}

// ---- CANVAS ----
function resizeCanvas() {
    const rect = graphCanvas.getBoundingClientRect();
    graphCanvas.width = rect.width * devicePixelRatio;
    graphCanvas.height = rect.height * devicePixelRatio;
    graphCtx.scale(devicePixelRatio, devicePixelRatio);
    drawGraph();
}

// ---- AUDIO ----
async function toggleRecording() {
    if (isRecording) stopRecording(); else await startRecording();
}

async function startRecording() {
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaStreamSource(mediaStream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.8;
        source.connect(analyser);

        isRecording = true;
        sessionStartTime = Date.now();
        lastStatState = null;
        sessionPhaseLog = [];
        if (currentPhase !== 'none') sessionPhaseLog.push({ phase: currentPhase, start: Date.now() });

        startBtn.classList.add('active');
        // Update start button to show stop icon
        startBtn.querySelector('svg').innerHTML = '<rect x="6" y="5" width="12" height="14" rx="1"/>';
        startLabel.textContent = 'Stoppa mätning';
        statusBadge.className = 'status-badge active';
        statusText.textContent = 'Mäter';
        calibrateBtn.disabled = false;

        // Update fullscreen start button
        const fsLabel = $('fsStartLabel');
        if (fsLabel) fsLabel.textContent = 'Stoppa';

        resetStreak();
        streakStart = Date.now();
        streakActive = true;

        updateInterval = setInterval(sampleVolume, SAMPLE_INTERVAL);
        animate();
    } catch (err) {
        calibrationMsg.textContent = 'Kunde inte komma åt mikrofonen.';
        calibrationMsg.className = 'calibration-msg';
    }
}

function stopRecording() {
    const sessionData = buildSessionData();
    isRecording = false;
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    if (updateInterval) { clearInterval(updateInterval); updateInterval = null; }
    if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }

    startBtn.classList.remove('active');
    // Restore play icon
    startBtn.querySelector('svg').innerHTML = '<polygon points="6,3 20,12 6,21"/>';
    startLabel.textContent = 'Starta mätning';
    statusBadge.className = 'status-badge inactive'; statusText.textContent = 'Inaktiv';
    calibrateBtn.disabled = true;
    document.body.classList.remove('alert-active', 'aurora-active');
    stopAurora();

    // Update fullscreen start button
    const fsLabel = $('fsStartLabel');
    if (fsLabel) fsLabel.textContent = 'Starta';

    // Save best streak
    if (bestStreak > 0) {
        localStorage.setItem('soundmonitor_best_streak', bestStreak.toString());
    }

    // Exit fullscreen if active
    if (!$('fullscreenView').classList.contains('hidden')) {
        exitFullscreen();
    }

    if (sessionData && sessionData.totalSamples > 5) {
        saveSession(sessionData);
        showReport(sessionData);
    }
}

// ---- RMS & dB ----
function getRMS() {
    if (!analyser) return 0;
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
}

function rmsToDb(rms) {
    const adj = Math.max(0, rms - calibrationOffset);
    if (adj < 0.0001) return 0;
    return Math.min(100, Math.max(0, 20 * Math.log10(adj / 0.0001)));
}

// ---- SAMPLING ----
function sampleVolume() {
    if (!isRecording) return;
    const level = rmsToDb(getRMS());
    const effectiveThreshold = getEffectiveThreshold();

    // EMA smoothing for display (raw level kept for threshold)
    smoothedLevel = EMA_ALPHA * level + (1 - EMA_ALPHA) * smoothedLevel;

    // Circular Buffer update — store SMOOTHED for graph display
    historyLevels[historyIndex] = smoothedLevel;
    historyPhases[historyIndex] = PHASE_TO_ID[currentPhase] || 0;
    historyTimes[historyIndex] = Date.now();

    historyIndex = (historyIndex + 1) % HISTORY_LENGTH;
    if (historyCount < HISTORY_LENGTH) historyCount++;

    totalSamples++; totalSum += level;
    if (level > peakLevel) peakLevel = level;
    if (level > effectiveThreshold) overThresholdCount++;

    // Recovery gradient — smooth danger level
    if (level > effectiveThreshold) {
        dangerLevel = Math.min(1, dangerLevel + DANGER_RISE);
        document.body.classList.add('alert-active');
        handleStreakBreak();
        checkWarningSound();
    } else {
        dangerLevel = Math.max(0, dangerLevel - DANGER_FALL);
        if (dangerLevel < 0.05) {
            document.body.classList.remove('alert-active');
            dangerLevel = 0;
        }
        if (!streakActive && !graceTimeout) startStreak();
    }
    updateDangerOverlay();

    // Update VU meter (at 500ms interval — smooth transitions)
    vuValue.textContent = smoothedLevel.toFixed(0);
    let cls = 'level-green', col = 'var(--green)';
    if (level > effectiveThreshold) { cls = 'level-red'; col = 'var(--red)'; }
    else if (level > effectiveThreshold * 0.8) { cls = 'level-orange'; col = 'var(--orange)'; }
    vuRing.className = 'vu-ring ' + cls;
    vuValue.style.color = col;

    // Fullscreen VU mirror
    const fsVu = $('fsVuValue'), fsRing = $('fsVuRing');
    if (fsVu) { fsVu.textContent = smoothedLevel.toFixed(0); fsVu.style.color = col; }
    if (fsRing) fsRing.className = 'vu-ring fs-vu-ring ' + cls;

    updateStats(level);
    updateStreakDisplay();
    updateSessionTime();

    // Sync current level to fullscreen
    if ($('fsCurrentValue')) {
        $('fsCurrentValue').textContent = smoothedLevel.toFixed(0);
        const et = getEffectiveThreshold();
        $('fsCurrentValue').className = 'fs-current-value' +
            (level > et ? ' highlight-red' : level > et * 0.8 ? ' highlight-orange' : ' highlight-green');
    }

    drawGraph();
    drawFullscreenGraph();
}

// Recovery gradient overlay
function updateDangerOverlay() {
    const overlay = $('dangerOverlay');
    if (!overlay) return;
    if (dangerLevel <= 0) {
        overlay.style.opacity = '0';
        return;
    }
    // Color: red at danger=1, orange at 0.5, transparent at 0
    const r = 220, g = Math.round(38 + (1 - dangerLevel) * 120), b = 38;
    overlay.style.background = `radial-gradient(ellipse at center, transparent 40%, rgba(${r},${g},${b},${dangerLevel * 0.3}) 100%)`;
    overlay.style.opacity = '1';
}

function getEffectiveThreshold() {
    const pt = PHASE_THRESHOLDS[currentPhase];
    if (pt !== null) {
        const adjustment = phaseAdjustments[currentPhase] || 0;
        return pt + adjustment;
    }
    return threshold;
}

function updateStats(level) {
    const avg = totalSamples > 0 ? totalSum / totalSamples : 0;
    const et = getEffectiveThreshold();
    const overPct = totalSamples > 0 ? (overThresholdCount / totalSamples * 100) : 0;
    statAvg.textContent = avg.toFixed(0);
    statAvg.className = 'stat-value' + (avg > et ? ' highlight-red' : avg > et * 0.8 ? ' highlight-orange' : ' highlight-green');
    statPeak.textContent = peakLevel.toFixed(0);
    statPeak.className = 'stat-value' + (peakLevel > et ? ' highlight-red' : ' highlight-orange');
    statOver.textContent = overPct.toFixed(0) + '%';
    statOver.className = 'stat-value' + (overPct > 30 ? ' highlight-red' : overPct > 10 ? ' highlight-orange' : ' highlight-green');

    // Sync to fullscreen
    if ($('fsStatAvg')) {
        $('fsStatAvg').textContent = avg.toFixed(0);
        $('fsStatAvg').className = 'fs-stat-value' + (avg > et ? ' highlight-red' : avg > et * 0.8 ? ' highlight-orange' : ' highlight-green');
    }
    if ($('fsStatPeak')) {
        $('fsStatPeak').textContent = peakLevel.toFixed(0);
        $('fsStatPeak').className = 'fs-stat-value' + (peakLevel > et ? ' highlight-red' : ' highlight-orange');
    }
    if ($('fsStatOver')) {
        $('fsStatOver').textContent = overPct.toFixed(0) + '%';
        $('fsStatOver').className = 'fs-stat-value' + (overPct > 30 ? ' highlight-red' : overPct > 10 ? ' highlight-orange' : ' highlight-green');
    }

    // S4: Student stat — VEP consensus: update only on state change, rotate variants
    const fsStudentStat = $('fsStudentStat');
    if (fsStudentStat && sessionStartTime) {
        const calmPct = 1 - overPct / 100;
        const newState = calmPct >= 0.7 ? 'good' : calmPct >= 0.4 ? 'ok' : 'warn';
        // Only update text on state change (not every sample)
        if (newState !== lastStatState && lastStatState !== 'aurora' && lastStatState !== 'break') {
            const elapsedSec = Math.floor((Date.now() - sessionStartTime) / 1000);
            const elapsedMin = Math.floor(elapsedSec / 60);
            const t = elapsedMin >= 1
                ? Math.max(0, Math.round(elapsedMin * calmPct)) + ' av ' + elapsedMin + ' min'
                : Math.max(0, Math.round(elapsedSec * calmPct)) + ' av ' + elapsedSec + ' sek';
            // VEP v2.8: use discussion-specific messages in discussion phase
            const msgKey = (newState === 'good' && currentPhase === 'discussion') ? 'discussion_good' : newState;
            const variants = STAT_MSGS[msgKey];
            const pick = variants[Math.floor(Math.random() * variants.length)];
            fsStudentStat.textContent = pick.replace('{t}', t);
            fsStudentStat.className = 'fs-student-stat stat-' + newState;
            fsStudentStat.style.opacity = '1';
            lastStatState = newState;
        }
    }
}

// ---- STREAK ----
function startStreak() {
    streakStart = Date.now(); streakActive = true; streakBroken = false;
}

function handleStreakBreak() {
    if (!streakActive) return;
    if (graceTimeout) return;
    graceTimeout = setTimeout(() => {
        graceTimeout = null;
        const level = rmsToDb(getRMS());
        if (level > getEffectiveThreshold()) {
            const dur = Date.now() - streakStart;
            if (dur > bestStreak) bestStreak = dur;
            streakActive = false; streakBroken = true;
            streakDisplay.classList.remove('on-fire');
            document.body.classList.remove('aurora-active');
            stopAurora();
            // VEP: Show streak-break encouragement
            const fsStat = $('fsStudentStat');
            if (fsStat) {
                const bvariants = STAT_MSGS.break;
                fsStat.textContent = bvariants[Math.floor(Math.random() * bvariants.length)];
                fsStat.className = 'fs-student-stat stat-warn';
                fsStat.style.opacity = '1';
                lastStatState = 'break';
                // Clear break message after 3s so normal stat resumes
                setTimeout(() => { if (lastStatState === 'break') lastStatState = null; }, 3000);
            }
        }
    }, GRACE_MS);
}

function resetStreak() {
    streakStart = Date.now(); streakActive = true; streakBroken = false;
    if (graceTimeout) { clearTimeout(graceTimeout); graceTimeout = null; }
}

function updateStreakDisplay() {
    if (!isRecording) return;
    const dur = streakActive ? Date.now() - streakStart : 0;
    const sec = Math.floor(dur / 1000);
    const m = Math.floor(sec / 60), s = sec % 60;
    const timeStr = m + ':' + String(s).padStart(2, '0');
    streakTimeEl.textContent = timeStr;
    if ($('fsStreakTime')) $('fsStreakTime').textContent = timeStr;

    // Update progress bar (0-10s)
    const progressBar = $('streakProgressBar');
    const progressLabel = $('streakProgressLabel');
    if (progressBar) {
        if (sec < 10) {
            const pct = (sec / 10) * 100;
            progressBar.style.width = pct + '%';
            if (progressLabel) progressLabel.textContent = sec + '/10s';
        } else {
            progressBar.style.width = '100%';
            if (progressLabel) progressLabel.textContent = 'Aurora aktiv!';
        }
    }

    // Fullscreen: SVG streak ring progress
    const ring = $('fsStreakRing');
    if (ring) {
        const circumference = 565.5; // 2π × 90
        // VEP: use discussion-blue when in discussion phase
        const ringColor = currentPhase === 'discussion' ? 'var(--discussion-blue)' : 'var(--green)';
        if (sec < 10) {
            const progress = sec / 10;
            ring.style.strokeDashoffset = circumference * (1 - progress);
            ring.style.stroke = ringColor;
        } else {
            ring.style.strokeDashoffset = '0';
            ring.style.stroke = ringColor;
        }
    }

    if (sec >= 10) {
        streakDisplay.classList.add('on-fire');
        // Aurora intensifies with streak length — full effect at 2 min
        const intensity = Math.min(1, (sec - 10) / 110);
        updateAurora(intensity);
        document.body.classList.add('aurora-active');
        // VEP: Hide stat text during aurora — aurora IS the reward
        const fsStat2 = $('fsStudentStat');
        if (fsStat2 && lastStatState !== 'aurora') {
            fsStat2.textContent = '✓';
            fsStat2.className = 'fs-student-stat stat-good';
            fsStat2.style.opacity = '0.35';
            lastStatState = 'aurora';
        }
    } else {
        streakDisplay.classList.remove('on-fire');
        document.body.classList.remove('aurora-active');
        auroraIntensity = 0;
        // VEP: Restore stat visibility when aurora deactivates
        if (lastStatState === 'aurora') lastStatState = null;
    }

    // Best streak display
    const bestSec = Math.floor(Math.max(bestStreak, dur) / 1000);
    if (bestSec > 0) {
        const bm = Math.floor(bestSec / 60), bs = bestSec % 60;
        streakBestEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5C7 4 7 7 7 7"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5C17 4 17 7 17 7"/><path d="M4 22h16"/><path d="M10 22V8a4 4 0 0 0-4-4v0"/><path d="M14 22V8a4 4 0 0 1 4-4v0"/><path d="M10 8h4"/></svg> ' + bm + ':' + String(bs).padStart(2, '0');
    }
}

function updateSessionTime() {
    if (!isRecording || !sessionStartTime) return;
    const elapsed = Date.now() - sessionStartTime;
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    const timeStr = mins + ':' + String(secs).padStart(2, '0');
    if ($('fsSessionTime')) {
        $('fsSessionTime').textContent = 'Sessionstid: ' + timeStr;
    }
}

// ---- AURORA ----
function updateAurora(intensity) {
    auroraIntensity = intensity;
    if (!auroraAnimId) renderAurora();
}

function renderAurora() {
    const c = $('auroraCanvas'), ctx = auroraCtx;
    if (!c || !ctx) return;
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);

    if (auroraIntensity <= 0) { auroraAnimId = null; return; }

    const t = Date.now() / 3000;
    // Increased alpha range for better visibility (0.15 → 0.5)
    const alpha = 0.15 + auroraIntensity * 0.35;

    // Draw 4 aurora bands for richer effect
    for (let i = 0; i < 4; i++) {
        const grad = ctx.createLinearGradient(0, 0, w, h * 0.5);
        const hue1 = (120 + i * 35 + t * 15) % 360;
        const hue2 = (180 + i * 25 + t * 10) % 360;
        grad.addColorStop(0, `hsla(${hue1}, 80%, 55%, ${alpha * 0.5})`);
        grad.addColorStop(0.3, `hsla(${hue2}, 75%, 45%, ${alpha * 0.8})`);
        grad.addColorStop(0.6, `hsla(${hue1 + 40}, 70%, 40%, ${alpha})`);
        grad.addColorStop(1, `hsla(${hue2 + 60}, 60%, 30%, ${alpha * 0.2})`);

        ctx.beginPath();
        for (let x = 0; x <= w; x += 3) {
            const baseY = h * (0.1 + i * 0.12);
            const y = baseY
                + Math.sin(x / (180 + i * 60) + t + i * 1.3) * (30 + auroraIntensity * 70)
                + Math.sin(x / (90 + i * 40) + t * 1.3 + i) * (15 + auroraIntensity * 35)
                + Math.cos(x / (250 + i * 30) + t * 0.7) * (10 + auroraIntensity * 20);
            if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
    }
    auroraAnimId = requestAnimationFrame(renderAurora);
}

function stopAurora() {
    auroraIntensity = 0;
    if (auroraAnimId) { cancelAnimationFrame(auroraAnimId); auroraAnimId = null; }
    if (auroraCtx) auroraCtx.clearRect(0, 0, $('auroraCanvas').width, $('auroraCanvas').height);
}

// ---- PHASES ----
function setPhase(phase) {
    // Close previous phase in log
    if (isRecording && sessionPhaseLog.length > 0) {
        const last = sessionPhaseLog[sessionPhaseLog.length - 1];
        if (!last.end) last.end = Date.now();
    }

    currentPhase = phase;
    if (isRecording && phase !== 'none') {
        sessionPhaseLog.push({ phase, start: Date.now() });
        phaseMarkers.push({ phase, index: historyCount });
    }

    // Update all phase button states (both main and fullscreen)
    document.querySelectorAll('.phase-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.phase === phase);
    });
    phaseHint.textContent = PHASE_LABELS[phase] || 'Ingen fas vald';

    // Update threshold with phase-specific value
    const pt = PHASE_THRESHOLDS[phase];
    if (pt !== null && pt !== undefined) {
        thresholdValueEl.textContent = pt;
        thresholdSlider.value = pt;
        threshold = pt;
        // Show threshold hint
        if (thresholdHint) {
            thresholdHint.textContent = PHASE_LABELS[phase] + ': tröskel ' + pt + ' dB';
            thresholdHint.classList.add('visible');
            setTimeout(() => thresholdHint.classList.remove('visible'), 3000);
        }
    } else {
        if (thresholdHint) {
            thresholdHint.textContent = 'Manuell tröskel';
            thresholdHint.classList.add('visible');
            setTimeout(() => thresholdHint.classList.remove('visible'), 2000);
        }
    }

    // Update fullscreen phase indicator
    const fsIndicator = $('fsPhaseIndicator');
    if (fsIndicator) {
        const label = PHASE_LABELS[phase] || 'Ingen fas';
        const et = getEffectiveThreshold();
        const thresholdText = et ? `Mål: under ${et} dB` : 'Ingen tröskel';

        fsIndicator.querySelector('.fs-phase-label').textContent = label.toUpperCase();
        fsIndicator.querySelector('.fs-threshold-hint').textContent = thresholdText;

        // Update color class
        fsIndicator.className = 'fs-phase-indicator';
        if (phase === 'quiet') fsIndicator.classList.add('phase-quiet');
        if (phase === 'lecture') fsIndicator.classList.add('phase-lecture');
        if (phase === 'discussion') fsIndicator.classList.add('phase-discussion');
    }

    // VEP v2.8: Toggle discussion class on fullscreen-view for blue identity
    const fsView = $('fullscreenView');
    if (fsView) {
        fsView.classList.remove('phase-discussion');
        if (phase === 'discussion') fsView.classList.add('phase-discussion');
    }

    // VEP: Re-fade header after showing phase change
    const fsHeader = document.querySelector('.fs-header');
    if (fsHeader) {
        fsHeader.classList.remove('faded');
        setTimeout(() => fsHeader.classList.add('faded'), 3000);
    }

    drawGraph();
}

// ---- ANIMATION ----
function animate() {
    if (!isRecording) return;
    updateStreakDisplay();
    animFrameId = requestAnimationFrame(animate);
}

// ---- GRAPH ----
// ---- GRAPH ----
function drawGraph() {
    const w = graphCanvas.getBoundingClientRect().width;
    const h = graphCanvas.getBoundingClientRect().height;
    graphCtx.clearRect(0, 0, w, h);

    // Grid
    graphCtx.strokeStyle = 'rgba(255,255,255,0.04)'; graphCtx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = (i / 4) * h;
        graphCtx.beginPath(); graphCtx.moveTo(0, y); graphCtx.lineTo(w, y); graphCtx.stroke();
    }
    graphCtx.fillStyle = 'rgba(255,255,255,0.2)'; graphCtx.font = '10px Inter, sans-serif';
    graphCtx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
        graphCtx.fillText(100 - i * 25, 4, (i / 4) * h + (i === 0 ? 8 : i === 4 ? -4 : 0));
    }

    if (historyCount < 2) {
        drawThresholdLine(w, h);
        return;
    }

    const xStep = w / (HISTORY_LENGTH - 1);
    const startX = w - (historyCount - 1) * xStep;

    // Phase background zones
    let firstIdx = (historyIndex - historyCount + HISTORY_LENGTH) % HISTORY_LENGTH;
    let lastPhase = ID_TO_PHASE[historyPhases[firstIdx]];
    let zoneStart = 0;

    for (let i = 1; i <= historyCount; i++) {
        let pIdx = (historyIndex - historyCount + i + HISTORY_LENGTH) % HISTORY_LENGTH;
        const p = i < historyCount ? ID_TO_PHASE[historyPhases[pIdx]] : null;
        if (p !== lastPhase || i === historyCount) {
            if (lastPhase !== 'none' && PHASE_COLORS[lastPhase]) {
                const x1 = startX + zoneStart * xStep;
                const x2 = startX + (i - 1) * xStep + xStep;
                graphCtx.fillStyle = PHASE_COLORS[lastPhase].bg;
                graphCtx.fillRect(x1, 0, x2 - x1, h);
                graphCtx.strokeStyle = PHASE_COLORS[lastPhase].line;
                graphCtx.lineWidth = 1.5;
                graphCtx.setLineDash([4, 4]);
                graphCtx.beginPath(); graphCtx.moveTo(x1, 0); graphCtx.lineTo(x1, h); graphCtx.stroke();
                graphCtx.setLineDash([]);
            }
            zoneStart = i; lastPhase = p;
        }
    }

    // Fill area
    const gradient = graphCtx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, 'rgba(99,102,241,0.25)');
    gradient.addColorStop(1, 'rgba(99,102,241,0.0)');
    graphCtx.beginPath(); graphCtx.moveTo(startX, h);
    for (let i = 0; i < historyCount; i++) {
        let currIdx = (historyIndex - historyCount + i + HISTORY_LENGTH) % HISTORY_LENGTH;
        const x = startX + i * xStep, y = h - (historyLevels[currIdx] / 100) * h;
        if (i === 0) graphCtx.lineTo(x, y);
        else {
            let prevIdx = (historyIndex - historyCount + i - 1 + HISTORY_LENGTH) % HISTORY_LENGTH;
            const px = startX + (i - 1) * xStep, py = h - (historyLevels[prevIdx] / 100) * h;
            const cpx = (px + x) / 2;
            graphCtx.bezierCurveTo(cpx, py, cpx, y, x, y);
        }
    }
    graphCtx.lineTo(startX + (historyCount - 1) * xStep, h); graphCtx.closePath();
    graphCtx.fillStyle = gradient; graphCtx.fill();

    // Line segments
    const et = getEffectiveThreshold();
    for (let i = 1; i < historyCount; i++) {
        let prevIdx = (historyIndex - historyCount + i - 1 + HISTORY_LENGTH) % HISTORY_LENGTH;
        let currIdx = (historyIndex - historyCount + i + HISTORY_LENGTH) % HISTORY_LENGTH;
        const x1 = startX + (i - 1) * xStep, y1 = h - (historyLevels[prevIdx] / 100) * h;
        const x2 = startX + i * xStep, y2 = h - (historyLevels[currIdx] / 100) * h;
        const val = historyLevels[currIdx];
        graphCtx.strokeStyle = val > et ? 'rgba(239,68,68,0.9)' : val > et * 0.8 ? 'rgba(245,158,11,0.9)' : 'rgba(99,102,241,0.9)';
        graphCtx.lineWidth = 2.5;
        graphCtx.beginPath(); graphCtx.moveTo(x1, y1);
        graphCtx.bezierCurveTo((x1 + x2) / 2, y1, (x1 + x2) / 2, y2, x2, y2);
        graphCtx.stroke();
    }
    drawThresholdLine(w, h);
}

function drawFullscreenGraph() {
    const canvas = $('fsGraphCanvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const w = canvas.width = canvas.getBoundingClientRect().width;
    const h = canvas.height = canvas.getBoundingClientRect().height;
    ctx.clearRect(0, 0, w, h);

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = (i / 4) * h;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.font = '14px Inter, sans-serif';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
        ctx.fillText(100 - i * 25, 8, (i / 4) * h + (i === 0 ? 12 : i === 4 ? -8 : 0));
    }

    if (historyCount < 2) {
        const et = getEffectiveThreshold();
        if (et !== null) {
            const ty = h - (et / 100) * h;
            ctx.strokeStyle = 'rgba(239,68,68,0.8)'; ctx.lineWidth = 3;
            ctx.setLineDash([8, 8]); ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(w, ty); ctx.stroke(); ctx.setLineDash([]);
        }
        return;
    }

    const xStep = w / (HISTORY_LENGTH - 1);
    const startX = w - (historyCount - 1) * xStep;

    // Phase background zones
    let firstIdx = (historyIndex - historyCount + HISTORY_LENGTH) % HISTORY_LENGTH;
    let lastPhase = ID_TO_PHASE[historyPhases[firstIdx]];
    let zoneStart = 0;
    for (let i = 1; i <= historyCount; i++) {
        let pIdx = (historyIndex - historyCount + i + HISTORY_LENGTH) % HISTORY_LENGTH;
        const p = i < historyCount ? ID_TO_PHASE[historyPhases[pIdx]] : null;
        if (p !== lastPhase || i === historyCount) {
            if (lastPhase !== 'none' && PHASE_COLORS[lastPhase]) {
                const x1 = startX + zoneStart * xStep;
                const x2 = startX + (i - 1) * xStep + xStep;
                ctx.fillStyle = PHASE_COLORS[lastPhase].bg; ctx.fillRect(x1, 0, x2 - x1, h);
                ctx.strokeStyle = PHASE_COLORS[lastPhase].line; ctx.lineWidth = 2;
                ctx.setLineDash([6, 6]); ctx.beginPath(); ctx.moveTo(x1, 0); ctx.lineTo(x1, h); ctx.stroke(); ctx.setLineDash([]);
            }
            zoneStart = i; lastPhase = p;
        }
    }

    // Fill area
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, 'rgba(99,102,241,0.3)');
    gradient.addColorStop(1, 'rgba(99,102,241,0.0)');
    ctx.beginPath(); ctx.moveTo(startX, h);
    for (let i = 0; i < historyCount; i++) {
        let currIdx = (historyIndex - historyCount + i + HISTORY_LENGTH) % HISTORY_LENGTH;
        const x = startX + i * xStep, y = h - (historyLevels[currIdx] / 100) * h;
        if (i === 0) ctx.lineTo(x, y);
        else {
            let prevIdx = (historyIndex - historyCount + i - 1 + HISTORY_LENGTH) % HISTORY_LENGTH;
            const px = startX + (i - 1) * xStep, py = h - (historyLevels[prevIdx] / 100) * h;
            const cpx = (px + x) / 2;
            ctx.bezierCurveTo(cpx, py, cpx, y, x, y);
        }
    }
    ctx.lineTo(startX + (historyCount - 1) * xStep, h); ctx.closePath();
    ctx.fillStyle = gradient; ctx.fill();

    // Line segments
    const et = getEffectiveThreshold();
    for (let i = 1; i < historyCount; i++) {
        let prevIdx = (historyIndex - historyCount + i - 1 + HISTORY_LENGTH) % HISTORY_LENGTH;
        let currIdx = (historyIndex - historyCount + i + HISTORY_LENGTH) % HISTORY_LENGTH;
        const x1 = startX + (i - 1) * xStep, y1 = h - (historyLevels[prevIdx] / 100) * h;
        const x2 = startX + i * xStep, y2 = h - (historyLevels[currIdx] / 100) * h;
        const val = historyLevels[currIdx];
        ctx.strokeStyle = val > et ? 'rgba(239,68,68,0.95)' : val > et * 0.8 ? 'rgba(245,158,11,0.95)' : 'rgba(99,102,241,0.95)';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(x1, y1);
        ctx.bezierCurveTo((x1 + x2) / 2, y1, (x1 + x2) / 2, y2, x2, y2);
        ctx.stroke();
    }

    if (et !== null) {
        const ty = h - (et / 100) * h;
        ctx.strokeStyle = 'rgba(239,68,68,0.9)'; ctx.lineWidth = 3;
        ctx.setLineDash([10, 10]); ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(w, ty); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(239,68,68,0.9)'; ctx.font = 'bold 16px Inter, sans-serif'; ctx.textAlign = 'right';
        ctx.fillText('Tröskel: ' + et + ' dB', w - 12, ty - 10); ctx.textAlign = 'left';
    }
}


function drawThresholdLine(w, h) {
    const et = getEffectiveThreshold();
    const ty = h - (et / 100) * h;
    graphCtx.setLineDash([8, 4]);
    graphCtx.strokeStyle = 'rgba(239,68,68,0.5)'; graphCtx.lineWidth = 1.5;
    graphCtx.beginPath(); graphCtx.moveTo(0, ty); graphCtx.lineTo(w, ty); graphCtx.stroke();
    graphCtx.setLineDash([]);
    graphCtx.fillStyle = 'rgba(239,68,68,0.7)'; graphCtx.font = '600 10px Inter, sans-serif';
    graphCtx.fillText('TRÖSKEL ' + et, w - 70, ty - 6);
}

// ---- WARNING SOUND ----
function checkWarningSound() {
    if (!soundEnabled) return;
    if (Date.now() - lastWarningTime < COOLDOWN_MS) return;
    lastWarningTime = Date.now();
    playChime();
    cooldownBar.classList.add('visible');
    const start = Date.now();
    if (cooldownTimer) clearInterval(cooldownTimer);
    cooldownTimer = setInterval(() => {
        const pct = Math.min(100, ((Date.now() - start) / COOLDOWN_MS) * 100);
        cooldownFill.style.width = pct + '%';
        if (pct >= 100) { clearInterval(cooldownTimer); cooldownTimer = null; cooldownBar.classList.remove('visible'); cooldownFill.style.width = '0%'; }
    }, 50);
}

function playChime() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    [[880, 0, 0.05, 0.4, 0.15], [1320, 0.1, 0.15, 0.6, 0.1]].forEach(([freq, start, attack, decay, vol]) => {
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = 'sine'; osc.frequency.setValueAtTime(freq, now + start);
        gain.gain.setValueAtTime(0, now + start);
        gain.gain.linearRampToValueAtTime(vol, now + attack);
        gain.gain.exponentialRampToValueAtTime(0.001, now + decay);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(now + start); osc.stop(now + decay);
    });
    setTimeout(() => ctx.close(), 1000);
}

// ---- CALIBRATION ----
function calculatePhaseThresholds(baseLevel) {
    return {
        quiet: Math.round(baseLevel + 10),
        lecture: Math.round(baseLevel + 25),
        discussion: Math.round(baseLevel + 35)
    };
}

async function calibrate() {
    if (!isRecording) return;
    calibrateBtn.classList.add('calibrating'); calibrateBtn.disabled = true;
    calibrationMsg.textContent = 'Kalibrerar... håll tyst i 3 sekunder';
    calibrationMsg.className = 'calibration-msg';
    const samples = [];
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (!isRecording) break;
        samples.push(getRMS());
    }
    if (samples.length > 0) {
        calibrationOffset = (samples.reduce((a, b) => a + b, 0) / samples.length) * 0.9;

        // Calculate intelligent phase thresholds based on ambient level
        const avgRMS = samples.reduce((a, b) => a + b, 0) / samples.length;
        const baseLevel = rmsToDb(avgRMS);
        const suggested = calculatePhaseThresholds(baseLevel);

        // Update phase thresholds
        PHASE_THRESHOLDS.quiet = suggested.quiet;
        PHASE_THRESHOLDS.lecture = suggested.lecture;
        PHASE_THRESHOLDS.discussion = suggested.discussion;

        // Save calibration and thresholds
        const dateStr = new Date().toLocaleDateString('sv-SE');
        localStorage.setItem('soundmonitor_calibration', JSON.stringify({
            offset: calibrationOffset,
            date: dateStr,
            thresholds: PHASE_THRESHOLDS
        }));

        // Update fine-tune value displays
        updateTuneDisplays();

        // Show fine-tune panel
        const tunePanel = $('phaseTune');
        if (tunePanel) tunePanel.classList.add('visible');

        calibrationMsg.innerHTML = `✓ Kalibrerad! Föreslagna trösklar:<br>
            Tyst arbete: ${suggested.quiet} dB | 
            Genomgång: ${suggested.lecture} dB | 
            Diskussion: ${suggested.discussion} dB`;
        calibrationMsg.className = 'calibration-msg success';
        resetStats();
    }
    calibrateBtn.classList.remove('calibrating'); calibrateBtn.disabled = false;
    setTimeout(() => { calibrationMsg.className = 'calibration-msg'; }, 6000);
}

// ---- RESET ----
function resetStats() {
    historyIndex = 0;
    historyCount = 0;
    historyLevels.fill(0);
    historyPhases.fill(0);
    historyTimes.fill(0);
    phaseMarkers = [];
    peakLevel = 0; totalSamples = 0; totalSum = 0; overThresholdCount = 0;
    statAvg.textContent = statPeak.textContent = statOver.textContent = '—';
    statAvg.className = statPeak.className = statOver.className = 'stat-value';
    resetStreak();
    drawGraph();
}

// ---- FULLSCREEN ----
function enterFullscreen() {
    $('mainView').classList.add('hidden');
    $('fullscreenView').classList.remove('hidden');
    // Update fullscreen start button label
    const fsLabel = $('fsStartLabel');
    if (fsLabel) fsLabel.textContent = isRecording ? 'Stoppa' : 'Starta';
    document.documentElement.requestFullscreen?.();
    // VEP v2.8: auto-fade header after 3s
    const fsHeader = document.querySelector('.fs-header');
    if (fsHeader) {
        fsHeader.classList.remove('faded');
        setTimeout(() => fsHeader.classList.add('faded'), 3000);
    }
    // Apply discussion class if already in discussion phase
    if (currentPhase === 'discussion') {
        $('fullscreenView').classList.add('phase-discussion');
    }
    // VEP: Restore projector mode if persisted
    if (projectorMode) {
        $('fullscreenView').classList.add('projector-mode');
        const btn = $('fsProjectorToggle');
        if (btn) btn.classList.add('active');
    }
}

// VEP v2.8: Projector mode toggle (persisted in localStorage)
function toggleProjectorMode() {
    projectorMode = !projectorMode;
    const fsView = $('fullscreenView');
    const btn = $('fsProjectorToggle');
    if (fsView) fsView.classList.toggle('projector-mode', projectorMode);
    if (btn) btn.classList.toggle('active', projectorMode);
    try { localStorage.setItem('sm_projectorMode', projectorMode ? '1' : '0'); } catch (e) { }
}
// Restore projector mode on load
try { projectorMode = localStorage.getItem('sm_projectorMode') === '1'; } catch (e) { }
function exitFullscreen() {
    $('fullscreenView').classList.add('hidden');
    $('mainView').classList.remove('hidden');
    document.exitFullscreen?.();
}

// ---- SESSION DATA ----
function buildSessionData() {
    if (!sessionStartTime) return null;
    if (sessionPhaseLog.length > 0) {
        const last = sessionPhaseLog[sessionPhaseLog.length - 1];
        if (!last.end) last.end = Date.now();
    }

    const history = [];
    for (let i = 0; i < historyCount; i++) {
        let idx = (historyIndex - historyCount + i + HISTORY_LENGTH) % HISTORY_LENGTH;
        history.push({
            level: historyLevels[idx],
            phase: ID_TO_PHASE[historyPhases[idx]],
            time: historyTimes[idx]
        });
    }

    const levels = history.map(v => v.level);
    const avg = levels.length > 0 ? levels.reduce((a, b) => a + b, 0) / levels.length : 0;
    const peak = levels.length > 0 ? Math.max(...levels) : 0;
    const et = getEffectiveThreshold();
    const overCount = levels.filter(l => l > et).length;
    return {
        date: new Date(sessionStartTime).toISOString(),
        duration: Date.now() - sessionStartTime,
        avg: avg.toFixed(1), peak: peak.toFixed(1),
        overPercent: levels.length > 0 ? (overCount / levels.length * 100).toFixed(0) : 0,
        bestStreak: Math.max(bestStreak, streakActive ? Date.now() - streakStart : 0),
        threshold, totalSamples,
        phases: sessionPhaseLog.map(p => ({
            phase: p.phase, label: PHASE_LABELS[p.phase],
            duration: (p.end || Date.now()) - p.start
        })),
        history: history
    };
}

function saveSession(data) {
    const key = 'soundmonitor_sessions';
    let sessions = JSON.parse(localStorage.getItem(key) || '[]');
    sessions.unshift(data);
    if (sessions.length > 20) sessions = sessions.slice(0, 20);
    localStorage.setItem(key, JSON.stringify(sessions));
}

// ---- SESSION REPORT ----
function showReport(data) {
    $('reportOverlay').classList.remove('hidden');
    const dur = Math.floor(data.duration / 1000);
    const dm = Math.floor(dur / 60), ds = dur % 60;
    $('reportMeta').innerHTML = `<span class="meta-item"><svg class="meta-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg> ${new Date(data.date).toLocaleDateString('sv-SE')}</span>
    <span class="meta-item"><svg class="meta-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> ${dm}m ${ds}s</span>
    <span class="meta-item"><svg class="meta-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg> Tröskel: ${data.threshold}</span>`;

    const bs = Math.floor(data.bestStreak / 1000);
    const bm = Math.floor(bs / 60), bss = bs % 60;
    $('reportStats').innerHTML = `
    <div class="report-stat-item"><div class="report-stat-label">Snitt</div><div class="report-stat-value">${data.avg}</div></div>
    <div class="report-stat-item"><div class="report-stat-label">Topp</div><div class="report-stat-value">${data.peak}</div></div>
    <div class="report-stat-item"><div class="report-stat-label">Över tröskel</div><div class="report-stat-value">${data.overPercent}%</div></div>
    <div class="report-stat-item"><div class="report-stat-label">Bästa streak</div><div class="report-stat-value">${bm}:${String(bss).padStart(2, '0')}</div></div>`;

    // Phases
    if (data.phases.length > 0) {
        $('reportPhases').innerHTML = '<div class="control-label" style="margin-bottom:8px">Aktivitetsfaser</div>' +
            data.phases.map(p => {
                const pd = Math.floor(p.duration / 1000);
                return `<div class="report-phase-item"><span>${p.label}</span><span>${Math.floor(pd / 60)}m ${pd % 60}s</span></div>`;
            }).join('');
    } else { $('reportPhases').innerHTML = ''; }

    drawReportGraph(data);
}

function drawReportGraph(data) {
    const c = $('reportGraph'), ctx = c.getContext('2d');
    const rect = c.getBoundingClientRect();
    c.width = rect.width * devicePixelRatio; c.height = rect.height * devicePixelRatio;
    ctx.scale(devicePixelRatio, devicePixelRatio);
    const w = rect.width, h = rect.height;
    if (!data.history || data.history.length < 2) return;

    const hist = data.history;
    const xStep = w / (hist.length - 1);

    // Phase zones with tinted backgrounds
    let lp = hist[0].phase, zs = 0;
    for (let i = 1; i <= hist.length; i++) {
        const p = i < hist.length ? hist[i].phase : null;
        if (p !== lp || i === hist.length) {
            if (lp !== 'none' && PHASE_COLORS[lp]) {
                const zoneX = zs * xStep;
                const zoneW = (i - zs) * xStep;
                ctx.fillStyle = PHASE_COLORS[lp].bg;
                ctx.fillRect(zoneX, 0, zoneW, h);
                // Zone border
                ctx.strokeStyle = PHASE_COLORS[lp].line;
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 3]);
                ctx.beginPath(); ctx.moveTo(zoneX, 0); ctx.lineTo(zoneX, h); ctx.stroke();
                ctx.setLineDash([]);
            }
            zs = i; lp = p;
        }
    }

    // Line
    for (let i = 1; i < hist.length; i++) {
        const x1 = (i - 1) * xStep, y1 = h - (hist[i - 1].level / 100) * h;
        const x2 = i * xStep, y2 = h - (hist[i].level / 100) * h;
        ctx.strokeStyle = hist[i].level > data.threshold ? 'rgba(239,68,68,0.8)' : 'rgba(99,102,241,0.8)';
        ctx.lineWidth = 1.5; ctx.beginPath();
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }

    // Threshold
    const ty = h - (data.threshold / 100) * h;
    ctx.setLineDash([6, 3]); ctx.strokeStyle = 'rgba(239,68,68,0.4)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(w, ty); ctx.stroke(); ctx.setLineDash([]);
}

function closeReport() { $('reportOverlay').classList.add('hidden'); }
function saveReflection() {
    const text = $('reportReflection').value;
    if (!text) return;
    const sessions = JSON.parse(localStorage.getItem('soundmonitor_sessions') || '[]');
    if (sessions.length > 0) { sessions[0].reflection = text; localStorage.setItem('soundmonitor_sessions', JSON.stringify(sessions)); }
    calibrationMsg.textContent = 'Reflektion sparad'; calibrationMsg.className = 'calibration-msg success';
    setTimeout(() => { calibrationMsg.textContent = ''; }, 3000);
}

// ---- HISTORY ----
function showHistory() {
    const sessions = JSON.parse(localStorage.getItem('soundmonitor_sessions') || '[]');
    $('historyOverlay').classList.remove('hidden');
    if (sessions.length === 0) {
        $('historyList').innerHTML = '<div class="history-empty">Inga sessioner sparade ännu.</div>';
        return;
    }
    $('historyList').innerHTML = sessions.map((s, i) => {
        const dur = Math.floor(s.duration / 1000);
        const bs = Math.floor((s.bestStreak || 0) / 1000);
        return `<div class="history-item">
      <div class="history-item-header">
        <span class="history-item-date">${new Date(s.date).toLocaleDateString('sv-SE')} ${new Date(s.date).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}</span>
        <span class="history-item-duration">${Math.floor(dur / 60)}m ${dur % 60}s</span>
      </div>
      <div class="history-item-stats">
        <span>Snitt: ${s.avg}</span><span>Topp: ${s.peak}</span>
        <span>Över: ${s.overPercent}%</span>
        <span class="streak-mini"><img src="icons/fire.png" alt="" style="width:12px;height:12px"> ${Math.floor(bs / 60)}:${String(bs % 60).padStart(2, '0')}</span>
      </div>
      ${s.reflection ? '<div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px;font-style:italic">' + s.reflection + '</div>' : ''}
    </div>`;
    }).join('');
}
function closeHistory() { $('historyOverlay').classList.add('hidden'); }

// ---- FINE-TUNING ----
function updateTuneDisplays() {
    const tuneQuietValue = $('tuneQuietValue');
    const tuneLectureValue = $('tuneLectureValue');
    const tuneDiscussionValue = $('tuneDiscussionValue');

    const qVal = (PHASE_THRESHOLDS.quiet + phaseAdjustments.quiet);
    const lVal = (PHASE_THRESHOLDS.lecture + phaseAdjustments.lecture);
    const dVal = (PHASE_THRESHOLDS.discussion + phaseAdjustments.discussion);

    if (tuneQuietValue) tuneQuietValue.textContent = qVal + ' dB';
    if (tuneLectureValue) tuneLectureValue.textContent = lVal + ' dB';
    if (tuneDiscussionValue) tuneDiscussionValue.textContent = dVal + ' dB';

    // Update Fullscreen displays
    if ($('fsVal-quiet')) $('fsVal-quiet').textContent = phaseAdjustments.quiet > 0 ? '+' + phaseAdjustments.quiet : phaseAdjustments.quiet;
    if ($('fsVal-lecture')) $('fsVal-lecture').textContent = phaseAdjustments.lecture > 0 ? '+' + phaseAdjustments.lecture : phaseAdjustments.lecture;
    if ($('fsVal-discussion')) $('fsVal-discussion').textContent = phaseAdjustments.discussion > 0 ? '+' + phaseAdjustments.discussion : phaseAdjustments.discussion;

    // Sync input values (main <-> fullscreen)
    if ($('fsTune-quiet')) $('fsTune-quiet').value = phaseAdjustments.quiet;
    if ($('fsTune-lecture')) $('fsTune-lecture').value = phaseAdjustments.lecture;
    if ($('fsTune-discussion')) $('fsTune-discussion').value = phaseAdjustments.discussion;

    if ($('tuneQuiet')) $('tuneQuiet').value = phaseAdjustments.quiet;
    if ($('tuneLecture')) $('tuneLecture').value = phaseAdjustments.lecture;
    if ($('tuneDiscussion')) $('tuneDiscussion').value = phaseAdjustments.discussion;
}

function setupTuneSliders() {
    const sliders = [
        { id: 'quiet', main: 'tuneQuiet', fs: 'fsTune-quiet' },
        { id: 'lecture', main: 'tuneLecture', fs: 'fsTune-lecture' },
        { id: 'discussion', main: 'tuneDiscussion', fs: 'fsTune-discussion' }
    ];

    sliders.forEach(s => {
        const handleInput = (e) => {
            phaseAdjustments[s.id] = parseInt(e.target.value);
            updateTuneDisplays();
            localStorage.setItem('phaseAdjustments', JSON.stringify(phaseAdjustments));
            // Immediate redraw to show threshold line move
            drawGraph();
            drawFullscreenGraph();
        };

        if ($(s.main)) $(s.main).addEventListener('input', handleInput);
        if ($(s.fs)) $(s.fs).addEventListener('input', handleInput);
    });
}

// ---- BOOT ----
init();
