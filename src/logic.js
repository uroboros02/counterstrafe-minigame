import {
    AttemptState, PlayerState, STATE, MODE, TTKState, TIMING,
    A_ACTIVE, A_DIR, A_START_MS, A_PEAK_SPEED,
    A_GAP_MS, A_OVERLAP_MS, A_COUNTER_MS, A_STOPPED_MS, A_OVERSHOOT_INTEGRAL,
    P_VELOCITY, P_PHASE, PHASE,
    HistoryFreestyle, HistoryTTK, SessionLogFreestyle, SessionLogTTK,
    HISTORY_MAX, Feedback, SymmetryLog, StrafeLab, MicroStrafe,
} from './state.js';
import { recordLabShotEvent, recordLabAbortEvent } from './strafelab.js';
import { historyRecordShot } from './history.js';

function getArrays() {
    if (STATE.currentMode === MODE.TTK) return { history: HistoryTTK, session: SessionLogTTK };
    return { history: HistoryFreestyle, session: SessionLogFreestyle };
}

// ── Symmetry log ──
function logSymmetry(speed) {
    if (AttemptState[A_ACTIVE] !== 1) return;
    if (AttemptState[A_PEAK_SPEED] < STATE.MIN_ATTEMPT_SPEED) return;

    const csMs      = AttemptState[A_COUNTER_MS];
    const gapMs     = AttemptState[A_GAP_MS];
    const overlapMs = AttemptState[A_OVERLAP_MS];
    const stoppedMs = AttemptState[A_STOPPED_MS];
    const totalMs   = csMs + gapMs + overlapMs + stoppedMs;
    const oneAtTimePct = totalMs > 0 ? Math.round(csMs / totalMs * 100) : 0;

    const side = AttemptState[A_DIR] < 0 ? SymmetryLog.left : SymmetryLog.right;
    side.push({ speedAtShot: Math.round(speed), oneAtTimePct });
    if (side.length > SymmetryLog.MAX) side.shift();
}

function getAttemptData() {
    return {
        csMs:      Math.round(AttemptState[A_COUNTER_MS]),
        gapMs:     Math.round(AttemptState[A_GAP_MS]),
        overlapMs: Math.round(AttemptState[A_OVERLAP_MS]),
        stoppedMs: Math.round(AttemptState[A_STOPPED_MS]),
    };
}

// ── Classification ──
export function classify(speed, totalDecelMs) {
    if (AttemptState[A_ACTIVE] === 0)
        return { result: 'MOVING',     label: 'Moving',     color: '#ef4444', isSuccess: false, isAttempt: speed > STATE.ACCURATE_THRESH };
    if (AttemptState[A_PEAK_SPEED] < STATE.MIN_ATTEMPT_SPEED)
        return { result: 'NO_ATTEMPT', label: 'No Attempt', color: '#3a4248', isSuccess: false, isAttempt: false };
    if (speed > STATE.ACCURATE_THRESH)
        return { result: 'MOVING',     label: 'Moving',     color: '#ef4444', isSuccess: false, isAttempt: true };
    if (totalDecelMs > STATE.COAST_MS)
        return { result: 'TOO_SLOW',   label: 'Too Slow',   color: '#ef4444', isSuccess: false, isAttempt: true };
    if (totalDecelMs <= 80)
        return { result: 'PERFECT',    label: 'Perfect',    color: '#22c55e', isSuccess: true,  isAttempt: true };
    if (totalDecelMs <= 100)
        return { result: 'GOOD',       label: 'Good',       color: '#4ade80', isSuccess: true,  isAttempt: true };
    if (totalDecelMs <= 130)
        return { result: 'OK',         label: 'OK',         color: '#a3e635', isSuccess: true,  isAttempt: true };
    if (totalDecelMs <= 180)
        return { result: 'SLOW',       label: 'Slow',       color: '#facc15', isSuccess: true,  isAttempt: true };
    return   { result: 'COASTED',      label: 'Coasted',    color: '#f97316', isSuccess: true,  isAttempt: true };
}

export function updateTTK(now, dt) {
    if (STATE.currentMode !== MODE.TTK) return;

    const phase  = PlayerState[P_PHASE];
    const absSpd = Math.abs(PlayerState[P_VELOCITY]);

    if (phase === PHASE.STRAFING && !TTKState.armed && !TTKState.cueVisible) {
        if (absSpd >= STATE.MIN_ATTEMPT_SPEED) {
            TTKState.armed     = true;
            TTKState.elapsedMs = 0;
            TTKState.delayMs   = TIMING.TTK_MIN_DELAY_MS + Math.random() * TIMING.TTK_RANDOM_RANGE_MS;
        }
    }
    if (TTKState.armed && !TTKState.cueVisible) {
        if (phase === PHASE.IDLE) { resetTTK(); return; }
        if (phase === PHASE.STRAFING && absSpd >= STATE.MIN_ATTEMPT_SPEED) {
            TTKState.elapsedMs += dt * TIMING.MS_PER_SECOND;
        }
        if (TTKState.elapsedMs >= TTKState.delayMs) {
            TTKState.cueVisible = true;
            TTKState.cueSpawnMs = now;
        }
    }
}

export function resetTTK() {
    TTKState.armed      = false;
    TTKState.cueVisible = false;
    TTKState.cueSpawnMs = 0;
    TTKState.delayMs    = 0;
    TTKState.elapsedMs  = 0;
    TTKState.ttsMs      = 0;
}

export function fireShot(now, updateSidebarCallback) {
    const speed     = Math.abs(PlayerState[P_VELOCITY]);
    const isLabMode = STATE.currentMode === MODE.STRAFELAB || STATE.currentMode === MODE.MICROSTRAFE;

    // In lab modes we allow shooting at any speed / phase (the lab tracks it)
    if (!isLabMode) {
        if (PlayerState[P_PHASE] === PHASE.IDLE && speed < 5) return;
    } else {
        if (speed < 1) return;
    }

    const totalDecelMs = AttemptState[A_ACTIVE] === 1
        ? Math.round(now - AttemptState[A_START_MS]) : 0;

    // ── TTK false start ──
    if (STATE.currentMode === MODE.TTK && !TTKState.cueVisible) {
        const { history, session } = getArrays();
        const falseRec = {
            n: session.length + 1, timestamp: new Date().toISOString(),
            mode: 'ttk', result: 'FALSE_START', label: 'False Start',
            color: '#ef4444', isSuccess: false, isAttempt: true, isFalseStart: true,
            speed: Math.round(speed), totalDecelMs: 0,
            csMs: 0, gapMs: 0, overlapMs: 0, stoppedMs: 0,
            coastMs: Math.round(STATE.COAST_MS), ttsMs: 0, weapon: STATE.WPN.id,
        };
        history.unshift(falseRec);
        if (history.length > HISTORY_MAX) history.pop();
        session.push(falseRec);
        historyRecordShot(falseRec);
        Feedback.active = true; Feedback.label = 'False Start'; Feedback.color = '#ef4444'; Feedback.startMs = now;
        updateSidebarCallback(falseRec);
        resetTTK();
        return;
    }

    // ── Lab modes: record event, no history row ──
    if (isLabMode) {
        const wasAccurate = speed <= STATE.ACCURATE_THRESH;
        recordLabShotEvent(speed, wasAccurate, getAttemptData());
        logSymmetry(speed);

        // Feedback: delta from accuracy threshold (− = margin under, + = overshoot)
        const delta = Math.round(speed - STATE.ACCURATE_THRESH);
        Feedback.active  = true;
        Feedback.label   = (delta <= 0 ? '−' : '+') + Math.abs(delta) + ' u/s';
        Feedback.color   = wasAccurate ? '#22c55e' : '#ef4444';
        Feedback.startMs = now;

        AttemptState[A_ACTIVE] = 0;
        PlayerState[P_PHASE]   = PHASE.IDLE;
        return;
    }

    // ── Freestyle / TTK ──
    const { history, session } = getArrays();
    const cls = classify(speed, totalDecelMs);

    let ttsMs = 0;
    if (STATE.currentMode === MODE.TTK && TTKState.cueVisible) {
        ttsMs = Math.round(now - TTKState.cueSpawnMs);
        TTKState.ttsMs = ttsMs;
    }

    const rec = {
        n: session.length + 1,
        timestamp:    new Date().toISOString(),
        mode:         STATE.currentMode,
        result:       cls.result,
        label:        cls.label,
        color:        cls.color,
        isSuccess:    cls.isSuccess,
        isAttempt:    cls.isAttempt,
        speed:        Math.round(speed),
        totalDecelMs,
        csMs:         AttemptState[A_ACTIVE] === 1 ? Math.round(AttemptState[A_COUNTER_MS]) : 0,
        gapMs:        AttemptState[A_ACTIVE] === 1 ? Math.round(AttemptState[A_GAP_MS])     : 0,
        overlapMs:    AttemptState[A_ACTIVE] === 1 ? Math.round(AttemptState[A_OVERLAP_MS]) : 0,
        stoppedMs:    AttemptState[A_ACTIVE] === 1 ? Math.round(AttemptState[A_STOPPED_MS]) : 0,
        coastMs:      Math.round(STATE.COAST_MS),
        ttsMs,
        weapon:       STATE.WPN.id,
    };

    history.unshift(rec);
    if (history.length > HISTORY_MAX) history.pop();
    session.push(rec);
    historyRecordShot(rec);

    if (cls.isAttempt) logSymmetry(speed);

    Feedback.active = true; Feedback.label = cls.label; Feedback.color = cls.color; Feedback.startMs = now;
    updateSidebarCallback(rec);

    AttemptState[A_ACTIVE] = 0;
    PlayerState[P_PHASE]   = PHASE.IDLE;

    if (STATE.currentMode === MODE.TTK) resetTTK();
}

export function abortAttempt(now, speed, updateSidebarCallback) {
    const { history, session } = getArrays();
    const isLabMode = STATE.currentMode === MODE.STRAFELAB || STATE.currentMode === MODE.MICROSTRAFE;

    // In lab modes, log the attempt data for RTR but don't push a history row
    if (isLabMode) {
        logSymmetry(speed);
        recordLabAbortEvent(getAttemptData());
        PlayerState[P_PHASE]   = PHASE.STRAFING;
        AttemptState[A_ACTIVE] = 0;
        return;
    }

    logSymmetry(speed);

    const abortRec = {
        n: session.length + 1,
        timestamp:    new Date().toISOString(),
        mode:         STATE.currentMode,
        result:       'ABORTED',
        label:        'Changed Dir',
        color:        '#6a7880',
        isSuccess:    false,
        isAttempt:    true,
        speed:        Math.round(speed),
        totalDecelMs: Math.round(now - AttemptState[A_START_MS]),
        csMs:         Math.round(AttemptState[A_COUNTER_MS]),
        gapMs:        Math.round(AttemptState[A_GAP_MS]),
        overlapMs:    Math.round(AttemptState[A_OVERLAP_MS]),
        stoppedMs:    Math.round(AttemptState[A_STOPPED_MS]),
        coastMs:      Math.round(STATE.COAST_MS),
        isAbort:      true,
        ttsMs:        0,
        weapon:       STATE.WPN.id,
    };

    history.unshift(abortRec);
    if (history.length > HISTORY_MAX) history.pop();
    session.push(abortRec);

    Feedback.active = true; Feedback.label = 'Changed Dir'; Feedback.color = '#6a7880'; Feedback.startMs = now;
    updateSidebarCallback(abortRec);

    PlayerState[P_PHASE]   = PHASE.STRAFING;
    AttemptState[A_ACTIVE] = 0;

    if (STATE.currentMode === MODE.TTK) resetTTK();
}
