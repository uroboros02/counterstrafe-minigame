import './style.css';
import {
    recomputeBenchmarks, WEAPONS, STATE, MODE, TIMING,
    StrafeLab, MicroStrafe, RhythmState, SymmetryLog,
    PlayerState, P_VELOCITY,
    MicroStrafeVisuals,
} from './state.js';
import { initInput }                              from './input.js';
import { fireShot, updateTTK, resetTTK }          from './logic.js';
import { updatePhysics }                          from './physics.js';
import {
    startStrafeLab, stopStrafeLab, finishStrafeLab,
    startMicroStrafe, stopMicroStrafe, finishMicroStrafe,
} from './strafelab.js';
import { startRhythm, stopRhythm, updateRhythm }  from './rhythm.js';
import {
    initVelBar, updateLiveDOM, updateSidebar, updateSidebarLabMode,
    updateBenchmarksUI, exportHistoryCSV, exportLabCSV,
    rebuildHistoryDOM, computeAverages, updateSymmetryUI,
    updateLabProgressUI, showLabResults, hideLabResults,
    syncLabConfig, renderRhythmConfig, renderRhythmPresets, syncRhythmConfig,
} from './ui.js';
import { initRenderer, renderPixi, getScreenSize } from './renderer.js';
import { initHistory }                             from './history.js';

let lastTs = null, fpsFrames = 0, fpsTimer = 0, fpsDisplay;

// ===========================================================================
//  ABOUT PANEL CONTENT
// ===========================================================================
const ABOUT_CONTENT = {
    [MODE.FREESTYLE]: {
        title: 'Freestyle',
        body: `The fundamental drill. Strafe at full speed, press the opposite key to cancel momentum (counter-strafe), then fire the moment speed drops below 73 u/s — the green threshold marker on the velocity bar.
<br><br>
Read the <b>decel bar</b> in the history: short and consistent = clean technique. Always-coasted = releasing the key too early. Gap = a dead window where neither key is held.`,
    },
    [MODE.TTK]: {
        title: 'Time to Shot',
        body: `Reaction + technique under pressure. Strafe freely until the <b>arena glows blue</b> — that's your cue to immediately counter-strafe and shoot. Measures total time from cue to accurate shot.
<br><br>
False starts (firing before the glow) are tracked separately. The delay is random (1.5–10s) so you can't anticipate it. This mirrors the real scenario: you never know when you'll need to stop.`,
    },
    [MODE.STRAFELAB]: {
        title: 'Strafe Lab',
        body: `<b>Wide-peek trainer.</b> Cover the distance quota as fast as possible in the chosen direction — every unit of movement counts. Accurate shots (≤73 u/s) count toward the required total.
<br><br>
The ideal is: sprint at full speed → snap counter-strafe → fire at exactly the threshold → keep strafing. The shot spread score shows whether shots are evenly distributed across the run or all dumped at the start.`,
    },
    [MODE.MICROSTRAFE]: {
        title: 'Micro-Strafe',
        body: `<b>Micro-movement under the threshold.</b> ADAD continuously without overshooting 73 u/s, landing every shot while staying evasive. The arena circle tracks your real position.
<br><br>
<b>Realistic Time to Ready</b> is self-calibrating: it blends your personal counter-strafe speed and coast percentage to estimate how long you'd be stoppable to an enemy. Lower is harder to kill.`,
    },
    [MODE.RHYTHM]: {
        title: 'Rhythm',
        body: `Polyrhythmic metronome for movement timing. Reverse direction on <b>accent beats</b> (large dots), fill on sub-beats and small dots.
<br><br>
Odd signatures (7/8, 11/8) and irrational rhythms break the reflex of predictable, readable ADAD. Once you can strafe cleanly on 7/8 at 160bpm, your movement becomes much harder to time-predict from the enemy's perspective.`,
    },
};

// ===========================================================================
//  BOOT
// ===========================================================================
async function boot() {
    const container = document.getElementById('canvas-container');
    const app       = await initRenderer(container);
    fpsDisplay      = document.getElementById('fps-counter');

    recomputeBenchmarks();
    initVelBar();
    initHistory();
    updateBenchmarksUI();

    document.getElementById('weapon-select').addEventListener('change', e => {
        const id = e.target.value;
        if (WEAPONS[id]) { STATE.WPN = WEAPONS[id]; recomputeBenchmarks(); updateBenchmarksUI(); }
    });

    document.getElementById('btn-export').addEventListener('click', () => {
        const isLab = STATE.currentMode === MODE.STRAFELAB || STATE.currentMode === MODE.MICROSTRAFE;
        if (isLab) exportLabCSV(); else exportHistoryCSV();
    });

    // ── Mode tabs ──
    const modeTabs = document.querySelectorAll('.mode-tab');
    modeTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            if (StrafeLab.active)   { stopStrafeLab(performance.now());   hideLabResults(); }
            if (MicroStrafe.active) { stopMicroStrafe(performance.now()); hideLabResults(); }
            if (RhythmState.active) { stopRhythm(); syncRhythmConfig(); }

            modeTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            STATE.currentMode = tab.dataset.mode;

            const ttk  = STATE.currentMode === MODE.TTK;
            const sl   = STATE.currentMode === MODE.STRAFELAB;
            const ms   = STATE.currentMode === MODE.MICROSTRAFE;
            const rhy  = STATE.currentMode === MODE.RHYTHM;
            const isLab = sl || ms;

            // Reset micro-strafe position when entering the mode
            if (ms) { MicroStrafeVisuals.x = null; MicroStrafeVisuals.y = null; }

            document.querySelectorAll('.ttk-only').forEach(el => el.style.display = ttk ? 'flex' : 'none');
            document.getElementById('sl-config').style.display  = isLab ? 'block' : 'none';
            document.getElementById('rhy-config').style.display = rhy   ? 'block' : 'none';
            document.getElementById('sl-progress').style.display = 'none';
            document.getElementById('canvas-container').classList.toggle('ttk-armed', ttk);
            document.getElementById('hist-section').style.display = (isLab || rhy) ? 'none' : 'flex';
            document.getElementById('avg-section').style.display  = (isLab || rhy) ? 'none' : 'block';
            document.getElementById('btn-export').textContent     = isLab ? 'Export Lab CSV' : 'Export History as CSV';

            if (isLab) {
                const labTitle = document.getElementById('sl-config-title');
                const labDesc  = document.getElementById('sl-config-desc');
                if (labTitle) labTitle.textContent = sl ? 'Strafe Lab' : 'Micro-Strafe';
                if (labDesc) labDesc.textContent = sl
                    ? 'Wide-peek: run the distance fast, shoot at the threshold.'
                    : 'Micro-movement: stay under the threshold, coast cleanly.';
                syncLabConfig(STATE.currentMode);
            }

            // Update About panel
            updateAboutPanel(STATE.currentMode);

            const instEl = document.getElementById('instructions');
            if (ttk) {
                instEl.innerHTML = `<p><span>A / D</span> — strafe &nbsp;·&nbsp; <span>WAIT for BLUE GLOW</span> then CS + shoot</p><p>Firing before the glow = <span style="color:var(--red)">False Start</span></p>`;
            } else if (sl) {
                instEl.innerHTML = `<p><span>A / D</span> — strafe in chosen direction &nbsp;·&nbsp; <span>CLICK / SPACE</span> shoot</p><p>Cover the quota at max speed. Every shot must land at ≤73 u/s.</p>`;
            } else if (ms) {
                instEl.innerHTML = `<p><span>A / D</span> — ADAD &nbsp;·&nbsp; <span>CLICK / SPACE</span> shoot when accurate &nbsp;·&nbsp; <span>DRAG</span> circle to reposition</p><p>Stay below threshold. Coast clean. Never overshoot on purpose.</p>`;
            } else if (rhy) {
                instEl.innerHTML = `<p><span>A / D</span> — reverse direction on the <span>large dot</span></p><p>Medium = sub-accent &nbsp;·&nbsp; small = fill &nbsp;·&nbsp; stay irregular, stay in time</p>`;
            } else {
                instEl.innerHTML = `<p><span>A / D or ← / →</span> — strafe</p><p><span>LEFT CLICK or SPACE</span> — shoot</p><p>Strafe → counter-strafe → shoot → repeat</p>`;
            }

            resetTTK();
            rebuildHistoryDOM();
            computeAverages();
        });
    });

    // Initialise About panel for default mode
    updateAboutPanel(STATE.currentMode);

    // ── About panel collapse toggle ──
    document.getElementById('about-hdr').addEventListener('click', () => {
        const body   = document.getElementById('about-body');
        const toggle = document.getElementById('about-toggle');
        const hidden = body.style.display === 'none';
        body.style.display = hidden ? 'block' : 'none';
        toggle.textContent = hidden ? '▼' : '▶';
    });

    // ── Direction radios ──
    document.querySelectorAll('input[name="sl-dir"]').forEach(radio => {
        radio.addEventListener('change', e => {
            StrafeLab.direction = MicroStrafe.direction = e.target.value;
        });
    });

    // ── Lab config ──
    initLabConfig();

    // ── Rhythm config ──
    initRhythmConfig();

    // ── Symmetry collapse ──
    document.getElementById('sym-reset-btn').addEventListener('click', () => {
        SymmetryLog.left.length = 0; SymmetryLog.right.length = 0;
        updateSymmetryUI();
    });
    document.getElementById('sym-hdr').addEventListener('click', e => {
        if (e.target.id === 'sym-reset-btn') return;
        const body = document.getElementById('sym-body');
        const toggle = document.getElementById('sym-toggle');
        const hidden = body.style.display === 'none';
        body.style.display = hidden ? 'block' : 'none';
        toggle.textContent = hidden ? '▼' : '▶';
    });

    // ── Lab results overlay buttons ──
    document.getElementById('sl-res-retry').addEventListener('click', () => {
        hideLabResults();
        const now = performance.now();
        if (STATE.currentMode === MODE.STRAFELAB)   { startStrafeLab(now);   syncLabConfig(MODE.STRAFELAB); }
        if (STATE.currentMode === MODE.MICROSTRAFE) { startMicroStrafe(now); syncLabConfig(MODE.MICROSTRAFE); }
    });
    document.getElementById('sl-res-config').addEventListener('click', () => {
        hideLabResults(); syncLabConfig(STATE.currentMode);
    });

    // ── Micro-strafe drag (register BEFORE initInput so it runs first) ──
    initMicroStrafeDrag(app.canvas);

    // ── Input ──
    initInput(app.canvas, updateLiveDOM, () => {
        if (MicroStrafeVisuals.isDragging) return; // don't fire while dragging
        const isLab = STATE.currentMode === MODE.STRAFELAB || STATE.currentMode === MODE.MICROSTRAFE;
        fireShot(performance.now(), isLab ? updateSidebarLabMode : updateSidebar);
    });

    requestAnimationFrame(loop);
}

// ===========================================================================
//  ABOUT PANEL
// ===========================================================================
function updateAboutPanel(mode) {
    const content = ABOUT_CONTENT[mode];
    if (!content) return;
    document.getElementById('about-title').textContent = content.title;
    document.getElementById('about-text').innerHTML    = content.body;
}

// ===========================================================================
//  MICRO-STRAFE DRAG
// ===========================================================================
function initMicroStrafeDrag(canvas) {
    const BALL_R   = 40;
    const HIT_R    = BALL_R + 14;  // generous hit area

    function getMousePos(e) {
        const rect = canvas.getBoundingClientRect();
        return { mx: e.clientX - rect.left, my: e.clientY - rect.top };
    }
    function distToCircle(mx, my) {
        const bx = MicroStrafeVisuals.x ?? 0;
        const by = MicroStrafeVisuals.y ?? 0;
        return Math.hypot(mx - bx, my - by);
    }

    canvas.addEventListener('mousemove', e => {
        if (STATE.currentMode !== MODE.MICROSTRAFE) {
            canvas.style.cursor = 'crosshair'; return;
        }
        const { mx, my } = getMousePos(e);
        MicroStrafeVisuals.isHovered = distToCircle(mx, my) <= HIT_R;

        if (MicroStrafeVisuals.isDragging) {
            const { W, H } = getScreenSize();
            let nx = mx + MicroStrafeVisuals._dragOffsetX;
            let ny = my + MicroStrafeVisuals._dragOffsetY;

            const scx = W * 0.5, scy = H * 0.5;
            MicroStrafeVisuals._snapX = Math.abs(nx - scx) <= MicroStrafeVisuals.SNAP_RADIUS;
            MicroStrafeVisuals._snapY = Math.abs(ny - scy) <= MicroStrafeVisuals.SNAP_RADIUS;
            if (MicroStrafeVisuals._snapX) nx = scx;
            if (MicroStrafeVisuals._snapY) ny = scy;

            MicroStrafeVisuals.x = Math.max(BALL_R+8, Math.min(W-BALL_R-8, nx));
            MicroStrafeVisuals.y = Math.max(BALL_R+8, Math.min(H-BALL_R-8, ny));
        }

        canvas.style.cursor = MicroStrafeVisuals.isDragging ? 'grabbing'
            : MicroStrafeVisuals.isHovered ? 'grab'
            : 'crosshair';
    });

    canvas.addEventListener('mousedown', e => {
        if (STATE.currentMode !== MODE.MICROSTRAFE) return;
        const { mx, my } = getMousePos(e);
        if (distToCircle(mx, my) <= HIT_R) {
            MicroStrafeVisuals.isDragging    = true;
            MicroStrafeVisuals._dragOffsetX  = (MicroStrafeVisuals.x ?? 0) - mx;
            MicroStrafeVisuals._dragOffsetY  = (MicroStrafeVisuals.y ?? 0) - my;
            canvas.style.cursor              = 'grabbing';
            e.stopPropagation(); // prevent falling through to shot fire
        }
    });

    window.addEventListener('mouseup', () => {
        if (!MicroStrafeVisuals.isDragging) return;
        MicroStrafeVisuals.isDragging = false;
        MicroStrafeVisuals._snapX     = false;
        MicroStrafeVisuals._snapY     = false;
        canvas.style.cursor = MicroStrafeVisuals.isHovered ? 'grab' : 'crosshair';
    });
}

// ===========================================================================
//  LAB CONFIG
// ===========================================================================
function initLabConfig() {
    document.querySelectorAll('#sl-quota-presets .sl-preset').forEach(btn => {
        btn.addEventListener('click', e => {
            const v = +e.target.dataset.v;
            StrafeLab.quotaUnits = MicroStrafe.quotaUnits = v;
            document.getElementById('sl-quota-custom').value = v;
            document.querySelectorAll('#sl-quota-presets .sl-preset')
                .forEach(b => b.classList.toggle('active', +b.dataset.v === v));
        });
    });
    document.getElementById('sl-quota-custom').addEventListener('change', e => {
        const v = Math.max(50, Math.min(9999, +e.target.value || 400));
        StrafeLab.quotaUnits = MicroStrafe.quotaUnits = v;
        document.getElementById('sl-quota-custom').value = v;
        document.querySelectorAll('#sl-quota-presets .sl-preset').forEach(b => b.classList.remove('active'));
    });
    document.getElementById('sl-quota-dec').addEventListener('click', () => nudgeQuota(-50));
    document.getElementById('sl-quota-inc').addEventListener('click', () => nudgeQuota(50));

    document.querySelectorAll('#sl-shots-presets .sl-preset').forEach(btn => {
        btn.addEventListener('click', e => {
            const v = +e.target.dataset.v;
            StrafeLab.quotaShots = MicroStrafe.quotaShots = v;
            document.querySelectorAll('#sl-shots-presets .sl-preset')
                .forEach(b => b.classList.toggle('active', +b.dataset.v === v));
        });
    });

    document.getElementById('sl-start').addEventListener('click', () => {
        const mode = STATE.currentMode;
        const lab  = mode === MODE.STRAFELAB ? StrafeLab : MicroStrafe;
        if (mode !== MODE.STRAFELAB && mode !== MODE.MICROSTRAFE) return;
        if (lab.active) {
            const r = mode === MODE.STRAFELAB ? stopStrafeLab(performance.now()) : stopMicroStrafe(performance.now());
            syncLabConfig(mode); showLabResults(r);
        } else {
            hideLabResults();
            if (mode === MODE.STRAFELAB) startStrafeLab(performance.now());
            else { startMicroStrafe(performance.now()); MicroStrafeVisuals.x = null; MicroStrafeVisuals.y = null; }
            syncLabConfig(mode);
        }
    });
}

function nudgeQuota(delta) {
    const v = Math.max(50, Math.min(9999, (StrafeLab.quotaUnits || 400) + delta));
    StrafeLab.quotaUnits = MicroStrafe.quotaUnits = v;
    document.getElementById('sl-quota-custom').value = v;
    document.querySelectorAll('#sl-quota-presets .sl-preset').forEach(b => b.classList.remove('active'));
}

// ===========================================================================
//  RHYTHM CONFIG
// ===========================================================================
function initRhythmConfig() {
    renderRhythmPresets(() => renderRhythmConfig(null));
    renderRhythmConfig(null);

    const bpmRange  = document.getElementById('rhy-bpm');
    const bpmNumber = document.getElementById('rhy-bpm-val');
    bpmRange.addEventListener('input',  e => { RhythmState.bpm = +e.target.value; bpmNumber.value = e.target.value; });
    bpmNumber.addEventListener('change', e => {
        const v = Math.max(40, Math.min(300, +e.target.value || 140));
        RhythmState.bpm = v; bpmRange.value = v; bpmNumber.value = v;
    });
    document.getElementById('rhy-bpm-dec').addEventListener('click', () => nudgeBPM(-5));
    document.getElementById('rhy-bpm-inc').addEventListener('click', () => nudgeBPM(5));
    document.getElementById('rhy-vol').addEventListener('input', e => { RhythmState.volume = +e.target.value / 100; });
    document.getElementById('rhy-add-seg').addEventListener('click', () => {
        RhythmState.segments.push({ bars: 1, num: 5, denom: 8, grouping: [3, 2] });
        renderRhythmConfig(null);
    });
    document.getElementById('rhy-start').addEventListener('click', () => {
        if (RhythmState.active) stopRhythm(); else startRhythm(performance.now());
        syncRhythmConfig();
    });
}

function nudgeBPM(delta) {
    const v = Math.max(40, Math.min(300, RhythmState.bpm + delta));
    RhythmState.bpm = v;
    document.getElementById('rhy-bpm').value     = v;
    document.getElementById('rhy-bpm-val').value = v;
}

// ===========================================================================
//  MAIN LOOP
// ===========================================================================
function loop(ts) {
    if (lastTs === null) lastTs = ts;
    const dt = Math.min((ts - lastTs) / TIMING.MS_PER_SECOND, TIMING.MAX_FRAME_TIME);
    lastTs = ts;

    fpsFrames++; fpsTimer += dt;
    if (fpsTimer >= 1) { fpsDisplay.textContent = fpsFrames + ' fps'; fpsFrames = 0; fpsTimer -= 1; }

    updatePhysics(dt, updateSidebar);
    updateTTK(performance.now(), dt);
    updateRhythm(ts);

    // ── Micro-Strafe: integrate actual ball position ──
    if (STATE.currentMode === MODE.MICROSTRAFE && !MicroStrafeVisuals.isDragging) {
        const { W, H } = getScreenSize();
        if (W > 0) {
            if (MicroStrafeVisuals.x === null) MicroStrafeVisuals.x = W * 0.5;
            if (MicroStrafeVisuals.y === null) MicroStrafeVisuals.y = H * 0.5;
            const pxPerUnit = (W * 0.5) / MicroStrafeVisuals.UNITS_TO_HALF_ARENA;
            const R = 40;
            MicroStrafeVisuals.x += PlayerState[P_VELOCITY] * dt * pxPerUnit;
            MicroStrafeVisuals.x  = Math.max(R + 8, Math.min(W - R - 8, MicroStrafeVisuals.x));
        }
    }

    // ── Lab quota completion check ──
    const activeLab = StrafeLab.active ? StrafeLab : MicroStrafe.active ? MicroStrafe : null;
    if (activeLab) {
        const shotsOk = activeLab.quotaShots === 0 ||
            activeLab.shotEvents.filter(s => s.wasAccurate).length >= activeLab.quotaShots;
        if (activeLab.accumulatedUnits >= activeLab.quotaUnits && shotsOk) {
            const r = StrafeLab.active ? finishStrafeLab(performance.now()) : finishMicroStrafe(performance.now());
            syncLabConfig(STATE.currentMode);
            showLabResults(r);
        } else {
            updateLabProgressUI();
        }
    }

    updateLiveDOM();
    renderPixi(ts);
    requestAnimationFrame(loop);
}

document.addEventListener('DOMContentLoaded', boot);
