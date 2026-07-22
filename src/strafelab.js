import {
    StrafeLab, MicroStrafe, STATE,
    SessionLogStrafeLab, SessionLogMicroStrafe,
    estimatedMsToAccurate, realisticTimeToReady,
} from './state.js';
import { historyRecordLab } from './history.js';

// ===========================================================================
//  GENERIC LAB HELPERS  (shared by both modes)
// ===========================================================================

function resetLab(lab, now) {
    lab.active                   = true;
    lab.accumulatedUnits         = 0;
    lab.completedShots           = 0;
    lab.startMs                  = now;
    lab.shotEvents               = [];
    lab.attemptLog               = [];
    lab.totalDistanceUnits       = 0;
    lab.inaccurateDistanceUnits  = 0;
    lab.mtrSum                   = 0;
    lab.mtrSamples               = 0;
    lab._prevVelocitySign        = 0;
    lab._strafeAccurateUnits     = 0;
    lab._strafeInaccurateMs      = 0;
    lab.strafeLog                = [];
}

function computeBaseResults(lab, now, completed) {
    const timeMs   = Math.round(now - lab.startMs);
    const shots    = lab.shotEvents;
    const nShots   = shots.length;

    const shotAccuratePct = nShots > 0
        ? Math.round(shots.filter(s => s.wasAccurate).length / nShots * 100)
        : null;

    // Avg speed at shot — report as distance from threshold (+ = above, − = below)
    // "Closer to threshold" means closer to 0 on this scale
    const avgSpeedAtShot = nShots > 0
        ? Math.round(shots.reduce((a, s) => a + s.speed, 0) / nShots)
        : null;

    const avgMTR = lab.mtrSamples > 0
        ? Math.round(lab.mtrSum / lab.mtrSamples * 10) / 10
        : 0;

    let avgStrafeEff = null;
    if (lab.strafeLog.length > 0) {
        const effs = lab.strafeLog.map(s => s.accurateUnits / (s.inaccurateMs + 1));
        avgStrafeEff = Math.round(effs.reduce((a, b) => a + b, 0) / effs.length * 100) / 100;
    }

    return {
        completed,
        timeMs,
        quotaUnits:     lab.quotaUnits,
        quotaShots:     lab.quotaShots,
        direction:      lab.direction,
        completedShots: nShots,
        shotAccuratePct,
        avgSpeedAtShot,
        avgMTR,
        avgStrafeEff,
        strafeCount:    lab.strafeLog.length,
        weapon:         STATE.WPN.id,
    };
}

// ===========================================================================
//  STRAFE LAB  (wide-peek: run fast, shoot at threshold)
// ===========================================================================

export function startStrafeLab(now)  { resetLab(StrafeLab, now); }
export function stopStrafeLab(now)   { StrafeLab.active = false; return computeStrafeLabResults(now, false); }
export function finishStrafeLab(now) {
    StrafeLab.active = false;
    const r = computeStrafeLabResults(now, true);
    SessionLogStrafeLab.push(r);
    return r;
}

function computeStrafeLabResults(now, completed) {
    const base = computeBaseResults(StrafeLab, now, completed);

    // Shot spread: std-dev of quota fractions at which shots were fired
    const pos = StrafeLab.shotEvents.map(s => s.quotaFraction);
    let shotSpread = null;
    if (pos.length > 1) {
        const mn  = pos.reduce((a, b) => a + b, 0) / pos.length;
        const v   = pos.reduce((a, b) => a + (b - mn) ** 2, 0) / pos.length;
        shotSpread = Math.round(Math.sqrt(v) * 100) / 100;
    }

    return { ...base, mode: 'strafelab', shotSpread };
}

// ===========================================================================
//  MICRO STRAFE  (micro-movement: stay below threshold, coast clean)
// ===========================================================================

export function startMicroStrafe(now)  { resetLab(MicroStrafe, now); }
export function stopMicroStrafe(now)   { MicroStrafe.active = false; return computeMicroResults(now, false); }
export function finishMicroStrafe(now) {
    MicroStrafe.active = false;
    const r = computeMicroResults(now, true);
    SessionLogMicroStrafe.push(r);
    return r;
}

function computeMicroResults(now, completed) {
    const base = computeBaseResults(MicroStrafe, now, completed);

    // Inaccurate Distance %
    const inaccDistPct = MicroStrafe.totalDistanceUnits > 0
        ? Math.round(MicroStrafe.inaccurateDistanceUnits / MicroStrafe.totalDistanceUnits * 1000) / 10
        : 0;

    // Realistic Time to Ready
    // Average oneAtTimePct across all logged attempts in this session
    const attempts = MicroStrafe.attemptLog;
    let rtr = null;
    if (attempts.length > 0) {
        const avgOneAtTime = attempts.reduce((a, b) => a + b.oneAtTimePct, 0) / attempts.length;
        rtr = realisticTimeToReady(avgOneAtTime);
    }

    return { ...base, mode: 'microstrafe', inaccDistPct, rtr };
}

// ===========================================================================
//  PER-FRAME TICK  (called from physics.js for whichever lab is active)
// ===========================================================================

export function tickLabFrame(dt, velocity) {
    const lab = StrafeLab.active ? StrafeLab : MicroStrafe.active ? MicroStrafe : null;
    if (!lab) return;

    const absV       = Math.abs(velocity);
    const frameMs    = dt * 1000;
    const curSign    = Math.sign(velocity);
    const targetSign = lab.direction === 'right' ? 1 : -1;

    // Accumulate distance only in target direction, any speed
    if (curSign === targetSign && absV > 0) {
        lab.accumulatedUnits      += absV * dt;
        lab.totalDistanceUnits    += absV * dt;
        if (absV > STATE.ACCURATE_THRESH) {
            lab.inaccurateDistanceUnits += absV * dt;
        }
    }

    // MTR sampled every frame
    lab.mtrSum += estimatedMsToAccurate(absV);
    lab.mtrSamples++;

    // Per-strafe efficiency
    if (curSign !== 0 &&
        lab._prevVelocitySign !== 0 &&
        curSign !== lab._prevVelocitySign) {
        if (lab._strafeAccurateUnits > 0 || lab._strafeInaccurateMs > 0) {
            lab.strafeLog.push({
                accurateUnits: lab._strafeAccurateUnits,
                inaccurateMs:  lab._strafeInaccurateMs,
            });
        }
        lab._strafeAccurateUnits = 0;
        lab._strafeInaccurateMs  = 0;
    }
    if (curSign !== 0) lab._prevVelocitySign = curSign;

    if (absV <= STATE.ACCURATE_THRESH) {
        lab._strafeAccurateUnits += absV * dt;
    } else {
        lab._strafeInaccurateMs  += frameMs;
    }
}

/**
 * Called by logic.js when a shot fires during an active lab session.
 * @param {number}  speed
 * @param {boolean} wasAccurate
 * @param {object}  attemptData  {csMs, gapMs, overlapMs, stoppedMs} for RTR calc
 */
export function recordLabShotEvent(speed, wasAccurate, attemptData) {
    const lab = StrafeLab.active ? StrafeLab : MicroStrafe.active ? MicroStrafe : null;
    if (!lab) return;
    historyRecordLab(wasAccurate);

    lab.shotEvents.push({
        speed,
        wasAccurate,
        quotaFraction: Math.min(1, lab.accumulatedUnits / lab.quotaUnits),
    });

    if (wasAccurate) lab.completedShots++;

    // Log attempt data for MicroStrafe RTR
    if (MicroStrafe.active && attemptData) {
        const { csMs, gapMs, overlapMs, stoppedMs } = attemptData;
        const totalMs = csMs + gapMs + overlapMs + stoppedMs;
        const oneAtTimePct = totalMs > 0 ? Math.round(csMs / totalMs * 100) : 0;
        MicroStrafe.attemptLog.push({ oneAtTimePct, csMs, gapMs, overlapMs, stoppedMs });
    }
}

/**
 * Called by logic.js when an attempt is aborted (direction reversal without shot).
 * Only MicroStrafe needs this for RTR.
 */
export function recordLabAbortEvent(attemptData) {
    if (!MicroStrafe.active || !attemptData) return;
    const { csMs, gapMs, overlapMs, stoppedMs } = attemptData;
    const totalMs = csMs + gapMs + overlapMs + stoppedMs;
    const oneAtTimePct = totalMs > 0 ? Math.round(csMs / totalMs * 100) : 0;
    MicroStrafe.attemptLog.push({ oneAtTimePct, csMs, gapMs, overlapMs, stoppedMs });
}
