import { createLogger } from '../util/logger';

const log = createLogger('COMBAT');

export interface SystemCombatMetrics {
    windowStartedAt: number;
    ticks: number;
    slowTicks: number;
    maxTickMs: number;
    totalTickMs: number;
    playerIntentsReceived: number;
    poseAccepted: number;
    poseRejectedDrift: number;
    poseRejectedAge: number;
    totalFastForwardMs: number;
    maxFastForwardMs: number;
    totalViewDelayMs: number;
    maxViewDelayMs: number;
    shipHitsResolved: number;
    asteroidHitsResolved: number;
    totalShieldDamage: number;
    totalArmorDamage: number;
    bayFightersLaunched: number;
}

const TELEMETRY_REPORT_INTERVAL_MS = 15_000;
const SLOW_TICK_WARN_THRESHOLD_MS = 28;
const metricsBySystem = new Map<string, SystemCombatMetrics>();
let lastSlowTickWarnAt = 0;
let lastPoseRejectWarnAt = 0;

function createMetrics(now: number): SystemCombatMetrics {
    return {
        windowStartedAt: now,
        ticks: 0,
        slowTicks: 0,
        maxTickMs: 0,
        totalTickMs: 0,
        playerIntentsReceived: 0,
        poseAccepted: 0,
        poseRejectedDrift: 0,
        poseRejectedAge: 0,
        totalFastForwardMs: 0,
        maxFastForwardMs: 0,
        totalViewDelayMs: 0,
        maxViewDelayMs: 0,
        shipHitsResolved: 0,
        asteroidHitsResolved: 0,
        totalShieldDamage: 0,
        totalArmorDamage: 0,
        bayFightersLaunched: 0,
    };
}

export function getSystemCombatMetrics(systemId: string, now = Date.now()): SystemCombatMetrics {
    let m = metricsBySystem.get(systemId);
    if (!m) {
        m = createMetrics(now);
        metricsBySystem.set(systemId, m);
    }
    return m;
}

export function recordServerShotIntentTelemetry(
    systemId: string | undefined,
    outcome: 'pose-accepted' | 'pose-rejected-drift' | 'pose-rejected-age' | 'entity-fallback',
    fastForwardMs = 0,
    viewDelayMs = 0,
    driftPx = 0,
): void {
    const id = systemId ?? 'unknown';
    const now = Date.now();
    const m = getSystemCombatMetrics(id, now);
    m.playerIntentsReceived++;
    if (outcome === 'pose-accepted') {
        m.poseAccepted++;
        m.totalFastForwardMs += Math.max(0, fastForwardMs);
        m.maxFastForwardMs = Math.max(m.maxFastForwardMs, fastForwardMs);
        m.totalViewDelayMs += Math.max(0, viewDelayMs);
        m.maxViewDelayMs = Math.max(m.maxViewDelayMs, viewDelayMs);
    } else if (outcome === 'pose-rejected-drift') {
        m.poseRejectedDrift++;
        if (now - lastPoseRejectWarnAt > 5_000) {
            lastPoseRejectWarnAt = now;
            log.warn(
                `[TIMING] Shot pose rejected due to muzzle drift (${Math.round(driftPx)}px) in ${id}; fell back to server hull pose`,
            );
        }
    } else if (outcome === 'pose-rejected-age') {
        m.poseRejectedAge++;
        if (now - lastPoseRejectWarnAt > 5_000) {
            lastPoseRejectWarnAt = now;
            log.warn(
                `[TIMING] Shot pose rejected due to age (${Math.round(fastForwardMs)}ms) in ${id}; fell back to server hull pose`,
            );
        }
    }
}

export function recordServerDamageTelemetry(
    systemId: string | undefined,
    isShip: boolean,
    isAsteroid: boolean,
    shieldDamage: number,
    armorDamage: number,
): void {
    const m = getSystemCombatMetrics(systemId ?? 'unknown');
    if (isShip) {
        m.shipHitsResolved++;
    } else if (isAsteroid) {
        m.asteroidHitsResolved++;
    }
    m.totalShieldDamage += shieldDamage;
    m.totalArmorDamage += armorDamage;
}

export function recordServerBayLaunchTelemetry(systemId: string | undefined): void {
    const m = getSystemCombatMetrics(systemId ?? 'unknown');
    m.bayFightersLaunched++;
}

export function recordServerSystemStepTelemetry(
    systemId: string,
    stepDurationMs: number,
    entityCount: number,
): void {
    const now = Date.now();
    const m = getSystemCombatMetrics(systemId, now);
    m.ticks++;
    m.totalTickMs += stepDurationMs;
    m.maxTickMs = Math.max(m.maxTickMs, stepDurationMs);
    if (stepDurationMs >= SLOW_TICK_WARN_THRESHOLD_MS) {
        m.slowTicks++;
        if (now - lastSlowTickWarnAt > 5_000) {
            lastSlowTickWarnAt = now;
            log.warn(
                `[TIMING] Slow system step in ${systemId}: ${stepDurationMs.toFixed(1)}ms (entities=${entityCount})`,
            );
        }
    }

    if (now - m.windowStartedAt >= TELEMETRY_REPORT_INTERVAL_MS) {
        const hadCombat =
            m.playerIntentsReceived > 0
            || m.shipHitsResolved > 0
            || m.asteroidHitsResolved > 0
            || m.bayFightersLaunched > 0
            || m.slowTicks > 0;
        if (hadCombat) {
            const avgTick = m.ticks > 0 ? (m.totalTickMs / m.ticks).toFixed(2) : '0.00';
            const avgFf = m.poseAccepted > 0 ? Math.round(m.totalFastForwardMs / m.poseAccepted) : 0;
            const avgView = m.poseAccepted > 0 ? Math.round(m.totalViewDelayMs / m.poseAccepted) : 0;
            log.info(
                `[TELEMETRY] system=${systemId} entities=${entityCount} `
                + `tickMs(avg=${avgTick},max=${m.maxTickMs.toFixed(1)},slow=${m.slowTicks}/${m.ticks}) `
                + `shots(in=${m.playerIntentsReceived},poseOk=${m.poseAccepted},driftRej=${m.poseRejectedDrift},ageRej=${m.poseRejectedAge}) `
                + `lagMs(ffAvg=${avgFf},ffMax=${Math.round(m.maxFastForwardMs)},viewAvg=${avgView},viewMax=${Math.round(m.maxViewDelayMs)}) `
                + `hits(ship=${m.shipHitsResolved},rock=${m.asteroidHitsResolved},shieldDmg=${Math.round(m.totalShieldDamage)},armorDmg=${Math.round(m.totalArmorDamage)},bayLaunches=${m.bayFightersLaunched})`,
            );
        }
        metricsBySystem.set(systemId, createMetrics(now));
    }
}
