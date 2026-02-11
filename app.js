// ============================================================
// LJUDMONITOR v2.0 — App Logic
// ============================================================

// ---- STATE ----
let audioCtx = null, analyser = null, mediaStream = null;
let isRecording = false, animFrameId = null, updateInterval = null;

const HISTORY_LENGTH = 120;
const SAMPLE_INTERVAL = 500;
let volumeHistory = [], phaseMarkers = [];
let threshold = 65, calibrationOffset = 0;
let peakLevel = 0, totalSamples = 0, totalSum = 0, overThresholdCount = 0;

// Streak
let streakStart = null, streakActive = false, bestStreak = 0;
let graceTimeout = null, streakBroken = false;
const GRACE_MS = 2000;

// Phase
let currentPhase = 'none';
const PHASE_THRESHOLDS = { none: null, lecture: null, quiet: 35, discussion: 65 };
const PHASE_LABELS = { none: 'Ingen', lecture: '📢 Genomgång', quiet: '✍️ Tyst arbete', discussion: '💬 Diskussion' };
const PHASE_COLORS = { none: 'rgba(99,102,241,0.3)', lecture: 'rgba(139,92,246,0.3)', quiet: 'rgba(34,197,94,0.3)', discussion: 'rgba(245,158,11,0.3)' };

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
const startBtn = $('startBtn'), startIcon = $('startIcon'), startLabel = $('startLabel');
const calibrateBtn = $('calibrateBtn'), calibrationMsg = $('calibrationMsg');
const cooldownBar = $('cooldownBar'), cooldownFill = $('cooldownFill');
const streakTimeEl = $('streakTime'), streakBestEl = $('streakBest'), streakDisplay = $('streakDisplay');
const phaseHint = $('phaseHint');

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
        calibrationMsg.textContent = `✅ Kalibrering laddad (${data.date})`;
        calibrationMsg.className = 'calibration-msg success';
        setTimeout(() => { calibrationMsg.textContent = ''; }, 3000);
    }

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

    setPhase('none');
    drawGraph();
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
        sessionPhaseLog = [];
        if (currentPhase !== 'none') sessionPhaseLog.push({ phase: currentPhase, start: Date.now() });

        startBtn.classList.add('active');
        startIcon.textContent = '■';
        startLabel.textContent = 'Stoppa mätning';
        statusBadge.className = 'status-badge active';
        statusText.textContent = 'Mäter';
        calibrateBtn.disabled = false;

        resetStreak();
        streakStart = Date.now();
        streakActive = true;

        updateInterval = setInterval(sampleVolume, SAMPLE_INTERVAL);
        animate();
    } catch (err) {
        calibrationMsg.textContent = '⚠️ Kunde inte komma åt mikrofonen.';
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
    startIcon.textContent = '▶'; startLabel.textContent = 'Starta mätning';
    statusBadge.className = 'status-badge inactive'; statusText.textContent = 'Inaktiv';
    calibrateBtn.disabled = true;
    document.body.classList.remove('alert-active', 'aurora-active');
    stopAurora();

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

    volumeHistory.push({ level, phase: currentPhase, time: Date.now() });
    if (volumeHistory.length > HISTORY_LENGTH) volumeHistory.shift();

    totalSamples++; totalSum += level;
    if (level > peakLevel) peakLevel = level;
    if (level > effectiveThreshold) overThresholdCount++;

    // Threshold check
    if (level > effectiveThreshold) {
        document.body.classList.add('alert-active');
        handleStreakBreak();
        checkWarningSound();
    } else {
        document.body.classList.remove('alert-active');
        if (!streakActive && !graceTimeout) startStreak();
    }

    updateStats(level);
    drawGraph();
}

function getEffectiveThreshold() {
    const pt = PHASE_THRESHOLDS[currentPhase];
    return pt !== null ? pt : threshold;
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
}

// ---- STREAK ----
function startStreak() {
    streakStart = Date.now(); streakActive = true; streakBroken = false;
}

function handleStreakBreak() {
    if (!streakActive) return;
    if (graceTimeout) return; // Already in grace
    graceTimeout = setTimeout(() => {
        graceTimeout = null;
        // Check if still over threshold
        const level = rmsToDb(getRMS());
        if (level > getEffectiveThreshold()) {
            const dur = Date.now() - streakStart;
            if (dur > bestStreak) bestStreak = dur;
            streakActive = false; streakBroken = true;
            streakDisplay.classList.remove('on-fire');
            document.body.classList.remove('aurora-active');
            stopAurora();
        }
    }, GRACE_MS);
}

function resetStreak() {
    streakStart = Date.now(); streakActive = true; streakBroken = false;
    bestStreak = 0;
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

    if (sec >= 10) {
        streakDisplay.classList.add('on-fire');
        // Aurora intensifies with streak length
        const intensity = Math.min(1, (sec - 10) / 120); // Full at 130s
        updateAurora(intensity);
        document.body.classList.add('aurora-active');
    } else {
        streakDisplay.classList.remove('on-fire');
        document.body.classList.remove('aurora-active');
        auroraIntensity = 0;
    }

    const bestSec = Math.floor(bestStreak / 1000);
    if (bestSec > 0) {
        const bm = Math.floor(bestSec / 60), bs = bestSec % 60;
        streakBestEl.textContent = '🏆 ' + bm + ':' + String(bs).padStart(2, '0');
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
    const alpha = auroraIntensity * 0.25;

    for (let i = 0; i < 3; i++) {
        const grad = ctx.createLinearGradient(0, 0, w, h * 0.6);
        const hue1 = (120 + i * 40 + t * 20) % 360;
        const hue2 = (180 + i * 30 + t * 15) % 360;
        grad.addColorStop(0, `hsla(${hue1}, 80%, 50%, ${alpha * 0.6})`);
        grad.addColorStop(0.5, `hsla(${hue2}, 70%, 40%, ${alpha})`);
        grad.addColorStop(1, `hsla(${hue1 + 60}, 60%, 30%, ${alpha * 0.3})`);

        ctx.beginPath();
        for (let x = 0; x <= w; x += 4) {
            const y = h * 0.2 + Math.sin(x / (150 + i * 50) + t + i) * (40 + auroraIntensity * 60)
                + Math.sin(x / (80 + i * 30) + t * 1.5) * (20 + auroraIntensity * 30);
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
        // Add marker to graph
        phaseMarkers.push({ phase, index: volumeHistory.length });
    }

    // Update UI
    document.querySelectorAll('.phase-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.phase === phase);
    });
    phaseHint.textContent = PHASE_LABELS[phase] || 'Ingen fas vald';

    // Update threshold display if phase has default threshold
    const pt = PHASE_THRESHOLDS[phase];
    if (pt !== null && pt !== undefined) {
        thresholdValueEl.textContent = pt;
        thresholdSlider.value = pt;
        threshold = pt;
    }
    drawGraph();
}

// ---- ANIMATION ----
function animate() {
    if (!isRecording) return;
    const level = rmsToDb(getRMS());
    const et = getEffectiveThreshold();

    vuValue.textContent = level.toFixed(0);
    let cls = 'level-green', col = 'var(--green)';
    if (level > et) { cls = 'level-red'; col = 'var(--red)'; }
    else if (level > et * 0.8) { cls = 'level-orange'; col = 'var(--orange)'; }
    vuRing.className = 'vu-ring ' + cls;
    vuValue.style.color = col;

    // Fullscreen mirror
    const fsVu = $('fsVuValue'), fsRing = $('fsVuRing');
    if (fsVu) { fsVu.textContent = level.toFixed(0); fsVu.style.color = col; }
    if (fsRing) fsRing.className = 'vu-ring fs-vu-ring ' + cls;

    updateStreakDisplay();
    animFrameId = requestAnimationFrame(animate);
}

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

    if (volumeHistory.length < 2) {
        drawThresholdLine(w, h);
        return;
    }

    const dataLen = volumeHistory.length;
    const xStep = w / (HISTORY_LENGTH - 1);
    const startX = w - (dataLen - 1) * xStep;

    // Phase background zones
    let lastPhase = volumeHistory[0].phase, zoneStart = 0;
    for (let i = 1; i <= dataLen; i++) {
        const p = i < dataLen ? volumeHistory[i].phase : null;
        if (p !== lastPhase || i === dataLen) {
            if (lastPhase !== 'none' && PHASE_COLORS[lastPhase]) {
                const x1 = startX + zoneStart * xStep;
                const x2 = startX + (i - 1) * xStep;
                graphCtx.fillStyle = PHASE_COLORS[lastPhase];
                graphCtx.fillRect(x1, 0, x2 - x1 + xStep, h);
            }
            zoneStart = i; lastPhase = p;
        }
    }

    // Fill area
    const gradient = graphCtx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, 'rgba(99,102,241,0.25)');
    gradient.addColorStop(1, 'rgba(99,102,241,0.0)');
    graphCtx.beginPath(); graphCtx.moveTo(startX, h);
    for (let i = 0; i < dataLen; i++) {
        const x = startX + i * xStep, y = h - (volumeHistory[i].level / 100) * h;
        if (i === 0) graphCtx.lineTo(x, y);
        else {
            const px = startX + (i - 1) * xStep, py = h - (volumeHistory[i - 1].level / 100) * h;
            const cpx = (px + x) / 2;
            graphCtx.bezierCurveTo(cpx, py, cpx, y, x, y);
        }
    }
    graphCtx.lineTo(startX + (dataLen - 1) * xStep, h); graphCtx.closePath();
    graphCtx.fillStyle = gradient; graphCtx.fill();

    // Line segments colored by threshold
    const et = getEffectiveThreshold();
    for (let i = 1; i < dataLen; i++) {
        const x1 = startX + (i - 1) * xStep, y1 = h - (volumeHistory[i - 1].level / 100) * h;
        const x2 = startX + i * xStep, y2 = h - (volumeHistory[i].level / 100) * h;
        const val = volumeHistory[i].level;
        graphCtx.strokeStyle = val > et ? 'rgba(239,68,68,0.9)' : val > et * 0.8 ? 'rgba(245,158,11,0.9)' : 'rgba(99,102,241,0.9)';
        graphCtx.lineWidth = 2.5;
        graphCtx.beginPath();
        graphCtx.moveTo(x1, y1);
        graphCtx.bezierCurveTo((x1 + x2) / 2, y1, (x1 + x2) / 2, y2, x2, y2);
        graphCtx.stroke();
    }

    drawThresholdLine(w, h);
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
async function calibrate() {
    if (!isRecording) return;
    calibrateBtn.classList.add('calibrating'); calibrateBtn.disabled = true;
    calibrationMsg.textContent = '🎯 Kalibrerar... håll tyst i 3 sekunder';
    calibrationMsg.className = 'calibration-msg';
    const samples = [];
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (!isRecording) break;
        samples.push(getRMS());
    }
    if (samples.length > 0) {
        calibrationOffset = (samples.reduce((a, b) => a + b, 0) / samples.length) * 0.9;
        const dateStr = new Date().toLocaleDateString('sv-SE');
        localStorage.setItem('soundmonitor_calibration', JSON.stringify({ offset: calibrationOffset, date: dateStr }));
        calibrationMsg.textContent = '✅ Kalibrering sparad!';
        calibrationMsg.className = 'calibration-msg success';
        resetStats();
    }
    calibrateBtn.classList.remove('calibrating'); calibrateBtn.disabled = false;
    setTimeout(() => { calibrationMsg.textContent = ''; }, 4000);
}

// ---- RESET ----
function resetStats() {
    volumeHistory = []; phaseMarkers = [];
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
    document.documentElement.requestFullscreen?.();
}
function exitFullscreen() {
    $('fullscreenView').classList.add('hidden');
    $('mainView').classList.remove('hidden');
    document.exitFullscreen?.();
}

// ---- SESSION DATA ----
function buildSessionData() {
    if (!sessionStartTime) return null;
    // Close last phase
    if (sessionPhaseLog.length > 0) {
        const last = sessionPhaseLog[sessionPhaseLog.length - 1];
        if (!last.end) last.end = Date.now();
    }
    const levels = volumeHistory.map(v => v.level);
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
        history: volumeHistory.slice()
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
    $('reportMeta').innerHTML = `<span>📅 ${new Date(data.date).toLocaleDateString('sv-SE')}</span>
    <span>⏱️ ${dm}m ${ds}s</span><span>🎯 Tröskel: ${data.threshold}</span>`;

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

    // Draw report graph
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

    // Phase zones
    let lp = hist[0].phase, zs = 0;
    for (let i = 1; i <= hist.length; i++) {
        const p = i < hist.length ? hist[i].phase : null;
        if (p !== lp || i === hist.length) {
            if (lp !== 'none' && PHASE_COLORS[lp]) {
                ctx.fillStyle = PHASE_COLORS[lp];
                ctx.fillRect(zs * xStep, 0, (i - zs) * xStep, h);
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
    calibrationMsg.textContent = '✅ Reflektion sparad'; calibrationMsg.className = 'calibration-msg success';
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
        <span>Över: ${s.overPercent}%</span><span>🔥 ${Math.floor(bs / 60)}:${String(bs % 60).padStart(2, '0')}</span>
      </div>
      ${s.reflection ? '<div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px">💭 ' + s.reflection + '</div>' : ''}
    </div>`;
    }).join('');
}
function closeHistory() { $('historyOverlay').classList.add('hidden'); }

// ---- BOOT ----
init();
