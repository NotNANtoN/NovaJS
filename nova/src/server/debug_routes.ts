import * as crypto from 'crypto';
import * as express from 'express';
import { Express } from 'express';
import { Entity } from 'nova_ecs/entity';
import { EntityMap } from 'nova_ecs/entity_map';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { World } from 'nova_ecs/world';
import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { PlanetData } from 'novadatainterface/PlanetData';
import {
    CombatAuthority,
    combatLedger,
    CombatResources,
    copyCombatResources,
    isCombatAmmoId,
    resetAmmoToHullDefaults,
} from '../nova_plugin/combat_resources';
import { clampFuel } from '../nova_plugin/fuel';
import { ArmorComponent, IonizationComponent, ShieldComponent } from '../nova_plugin/health_plugin';
import { NcbRuntime, NcbRuntimeResource } from '../nova_plugin/ncb_runtime';
import { OutfitsStateComponent } from '../nova_plugin/outfit_plugin';
import { isStellarDestroyed, PlayerStateComponent, PlayerStorePort } from '../nova_plugin/player_state';
import { ShipComponent, ShipDataComponent } from '../nova_plugin/ship_plugin';
import {
    recordPilotStellarDestruction,
    recordPilotStellarRegeneration,
} from '../nova_plugin/stellar_damage_plugin';
import { SystemComponent } from '../nova_plugin/nova_plugin';

/** Environment variable that enables the debug menu. Unset means disabled. */
export const DEBUG_TOKEN_ENV = 'NOVA_DEBUG_TOKEN';

/**
 * The configured debug token, or undefined when debugging is disabled. The
 * environment wins over nova/settings/server.json so deployments can opt in
 * without editing the image. Blank values count as unset.
 */
export function resolveDebugToken(
    env: Readonly<Record<string, string | undefined>>,
    settingsToken?: string,
): string | undefined {
    const fromEnv = env[DEBUG_TOKEN_ENV]?.trim();
    if (fromEnv) return fromEnv;
    const fromSettings = settingsToken?.trim();
    return fromSettings || undefined;
}

/**
 * Constant-time token comparison. Both sides are hashed first so the compare
 * neither short-circuits nor leaks the expected length.
 */
export function debugTokenMatches(expected: string, provided: unknown): boolean {
    if (typeof provided !== 'string' || provided.length === 0 || provided.length > 512) {
        return false;
    }
    const a = crypto.createHash('sha256').update(expected, 'utf8').digest();
    const b = crypto.createHash('sha256').update(provided, 'utf8').digest();
    return crypto.timingSafeEqual(a, b);
}

/** A pilot's live flight entity on the server. */
export interface DebugPilot {
    entities: EntityMap;
    uuid: string;
    entity: Entity;
    ncbRuntime?: NcbRuntime;
}

export type PilotLocator = (playerToken: string) => DebugPilot | undefined;

/** Finds a pilot's ship in whichever star-system room it is flying in. */
export function pilotLocatorForWorld(
    getWorld: () => World | undefined,
    store: Pick<PlayerStorePort, 'getTokenForPeer'>,
): PilotLocator {
    return playerToken => {
        const root = getWorld();
        if (!root) return undefined;
        for (const roomEntity of root.entities.values()) {
            const room = roomEntity.components.get(SystemComponent);
            if (!room) continue;
            for (const [uuid, entity] of room.entities) {
                const owner = entity.components.get(MultiplayerData)?.owner;
                if (!owner || owner === 'server'
                    || !entity.components.has(PlayerStateComponent)) continue;
                if (store.getTokenForPeer(owner) === playerToken) {
                    return {
                        entities: room.entities, uuid, entity,
                        ncbRuntime: room.resources.get(NcbRuntimeResource),
                    };
                }
            }
        }
        return undefined;
    };
}

export type DebugActionRequest =
    | { action: 'ship'; shipId: string }
    | { action: 'credits'; mode: 'set' | 'add'; amount: number }
    | { action: 'ammo'; outfitId: string; count: number }
    | { action: 'refuel' }
    | { action: 'repair' }
    | { action: 'stellar'; planetId: string; destroyed: boolean }
    /** Client-applied changes (bits, missions, outfits, date, jumps): logged and authorised only. */
    | { action: 'note'; what: string; detail?: string };

export interface DebugActionResult {
    ok: true;
    balance?: CombatResources;
    credits?: number;
    destroyed?: boolean;
    message?: string;
}

export class DebugActionError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
    }
}

const MAX_CREDITS = 2_000_000_000;
const MAX_AMMO = 100_000;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

function isId(value: unknown): value is string {
    return typeof value === 'string' && ID_PATTERN.test(value);
}

/** Validates an untrusted request body. Returns undefined when malformed. */
export function parseDebugAction(body: unknown): DebugActionRequest | undefined {
    const value = body as Record<string, unknown> | undefined;
    if (!value || typeof value !== 'object') return undefined;
    switch (value.action) {
        case 'ship':
            return isId(value.shipId) ? { action: 'ship', shipId: value.shipId } : undefined;
        case 'credits':
            return (value.mode === 'set' || value.mode === 'add')
                && typeof value.amount === 'number' && Number.isSafeInteger(value.amount)
                && Math.abs(value.amount) <= MAX_CREDITS
                ? { action: 'credits', mode: value.mode, amount: value.amount } : undefined;
        case 'ammo':
            return isId(value.outfitId) && typeof value.count === 'number'
                && Number.isSafeInteger(value.count) && value.count >= 0 && value.count <= MAX_AMMO
                ? { action: 'ammo', outfitId: value.outfitId, count: value.count } : undefined;
        case 'refuel':
        case 'repair':
            return { action: value.action };
        case 'stellar':
            return isId(value.planetId) && typeof value.destroyed === 'boolean'
                ? { action: 'stellar', planetId: value.planetId, destroyed: value.destroyed }
                : undefined;
        case 'note':
            return typeof value.what === 'string' && value.what.length > 0 && value.what.length <= 64
                && (value.detail === undefined
                    || typeof value.detail === 'string' && value.detail.length <= 2000)
                ? { action: 'note', what: value.what, detail: value.detail as string | undefined }
                : undefined;
        default:
            return undefined;
    }
}

/**
 * Applies debug actions through the same authorities normal play uses: the
 * combat ledger for hull, fuel, ammo and credits, and the server's copy of
 * the pilot's PlayerState for stellar destruction, so the landing check and
 * every later projection agree with what the menu did.
 */
export class DebugActions {
    constructor(
        private readonly gameData: GameDataInterface,
        private readonly store: PlayerStorePort,
        private readonly locatePilot: PilotLocator = () => undefined,
    ) { }

    private authority(playerToken: string): CombatAuthority {
        // Like the combat shop, never initialize a pilot from an HTTP request.
        const authority = combatLedger(this.store, this.gameData).getSync(playerToken);
        if (!authority || authority.retired) {
            throw new DebugActionError(409, 'Pilot is not loaded on the server; enter flight first');
        }
        return authority;
    }

    private pilot(playerToken: string): DebugPilot {
        const pilot = this.locatePilot(playerToken);
        if (!pilot) throw new DebugActionError(409, 'Pilot is not in flight');
        return pilot;
    }

    private receipt(authority: CombatAuthority, extra: Partial<DebugActionResult> = {}): DebugActionResult {
        return { ok: true, balance: copyCombatResources(authority.balance),
            credits: authority.state.credits, ...extra };
    }

    async run(playerToken: string, request: DebugActionRequest): Promise<DebugActionResult> {
        switch (request.action) {
            case 'note':
                return { ok: true };
            case 'ship':
                return this.switchShip(playerToken, request.shipId);
            case 'credits': {
                const authority = this.authority(playerToken);
                const base = request.mode === 'add' ? authority.state.credits : 0;
                const credits = Math.min(MAX_CREDITS, Math.max(0, base + request.amount));
                authority.state.credits = credits;
                const state = this.locatePilot(playerToken)?.entity.components.get(PlayerStateComponent);
                if (state) state.credits = credits;
                authority.commit();
                return this.receipt(authority);
            }
            case 'ammo': {
                const authority = this.authority(playerToken);
                if (!isCombatAmmoId(request.outfitId)) {
                    throw new DebugActionError(400, `${request.outfitId} is not ledger ammunition`);
                }
                authority.balance.ammo[request.outfitId] = request.count;
                authority.commit();
                return this.receipt(authority);
            }
            case 'refuel': {
                const authority = this.authority(playerToken);
                const hull = await this.gameData.data.Ship.get(authority.balance.shipId);
                authority.balance.fuel = Math.max(0, hull.fuelCapacity);
                authority.commit();
                return this.receipt(authority);
            }
            case 'repair': {
                const authority = this.authority(playerToken);
                const { entity } = this.pilot(playerToken);
                const shield = entity.components.get(ShieldComponent);
                const armor = entity.components.get(ArmorComponent);
                const ionization = entity.components.get(IonizationComponent);
                if (shield) { shield.current = shield.max; authority.shield = shield.max; }
                if (armor) { armor.current = armor.max; authority.armor = armor.max; }
                if (ionization) { ionization.current = 0; authority.ionization = 0; }
                return this.receipt(authority);
            }
            case 'stellar':
                return this.setStellar(playerToken, request.planetId, request.destroyed);
        }
    }

    private async switchShip(playerToken: string, shipId: string): Promise<DebugActionResult> {
        const ids = await this.gameData.ids;
        if (!ids.Ship.includes(shipId)) throw new DebugActionError(400, `Unknown ship ${shipId}`);
        const hull = await this.gameData.data.Ship.get(shipId);
        // Re-read after the await: the pilot may have landed or left.
        const authority = this.authority(playerToken);
        if (authority.landed) throw new DebugActionError(409, 'Take off before switching ships');
        authority.balance.shipId = hull.id;
        authority.balance.fuel = clampFuel(authority.balance.fuel, hull.fuelCapacity);
        resetAmmoToHullDefaults(authority.balance, hull);
        authority.commit();
        const entity = this.locatePilot(playerToken)?.entity;
        if (entity) {
            // Hull data first, so providers keyed on Ship see the new hull,
            // then the hull's stock outfits (server-side weapons follow them).
            entity.components.set(ShipDataComponent, hull);
            entity.components.set(ShipComponent, { id: hull.id });
            entity.components.set(OutfitsStateComponent, new Map(
                Object.entries(hull.outfits).map(([id, count]) => [id, { count }])));
            authority.project(entity);
        }
        return this.receipt(authority);
    }

    private async setStellar(playerToken: string, planetId: string,
        destroyed: boolean): Promise<DebugActionResult> {
        const ids = await this.gameData.ids;
        if (!ids.Planet.includes(planetId)) throw new DebugActionError(400, `Unknown stellar ${planetId}`);
        const planet: PlanetData = await this.gameData.data.Planet.get(planetId);
        const pilot = this.pilot(playerToken);
        const changed = destroyed
            ? recordPilotStellarDestruction(pilot.entities, pilot.uuid, planet,
                this.gameData, pilot.ncbRuntime)
            : recordPilotStellarRegeneration(pilot.entities, pilot.uuid, planet,
                this.gameData, pilot.ncbRuntime);
        const state = pilot.entities.get(pilot.uuid)?.components.get(PlayerStateComponent);
        return {
            ok: true,
            destroyed: state ? isStellarDestroyed(state, planetId) : destroyed,
            message: changed ? undefined : `Already ${destroyed ? 'destroyed' : 'intact'}`,
        };
    }
}

export interface DebugRouteOptions {
    /** Undefined disables the debug routes (they answer 404). */
    token?: string;
    locatePilot?: PilotLocator;
    log?: (message: string) => void;
    /** Failed token checks per client before it is throttled. */
    maxFailures?: number;
    failureWindowMs?: number;
}

function clientKey(req: express.Request): string {
    return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Mounts `/debug/*`. Must run after express.json() and before the index.html
 * catch-all, which would otherwise answer every unknown path with 200.
 */
export function setupDebugRoutes(app: Express, gameData: GameDataInterface,
    store: PlayerStorePort | undefined, options: DebugRouteOptions): void {
    const token = options.token;
    if (!token || !store) {
        app.use('/debug', (_req, res) => { res.status(404).send('Not found'); });
        return;
    }
    const log = options.log ?? (message => console.log(message));
    const actions = new DebugActions(gameData, store, options.locatePilot);
    const maxFailures = options.maxFailures ?? 20;
    const windowMs = options.failureWindowMs ?? 10 * 60_000;
    const failures = new Map<string, { count: number; resetAt: number }>();

    const authorized = (req: express.Request, res: express.Response, provided: unknown): boolean => {
        const key = clientKey(req);
        const now = Date.now();
        const entry = failures.get(key);
        if (entry && entry.resetAt <= now) failures.delete(key);
        const current = failures.get(key);
        if (current && current.count >= maxFailures) {
            res.status(429).send('Too many failed debug attempts');
            return false;
        }
        if (debugTokenMatches(token, provided)) return true;
        failures.set(key, { count: (current?.count ?? 0) + 1,
            resetAt: current?.resetAt ?? now + windowMs });
        if (failures.size > 4096) failures.delete(failures.keys().next().value!);
        log(`[DEBUG] Rejected debug token from ${key} (${req.method} ${req.path})`);
        res.status(403).send('Forbidden');
        return false;
    };

    app.get('/debug/status', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!authorized(req, res, req.query.token)) return;
        res.json({ ok: true });
    });

    app.post('/debug/action', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!authorized(req, res, req.body?.token)) return;
        const playerToken = req.body?.playerToken;
        if (typeof playerToken !== 'string' || playerToken.length === 0 || playerToken.length > 128) {
            res.status(400).send('Missing player token');
            return;
        }
        const request = parseDebugAction(req.body);
        if (!request) {
            res.status(400).send('Invalid debug action');
            return;
        }
        const { action, ...details } = request;
        const pilotTag = `[pilot:${playerToken.slice(0, 8)}]`;
        try {
            const result = await actions.run(playerToken, request);
            log(`[DEBUG] ${pilotTag} ${action} ${JSON.stringify(details)} ok (from ${clientKey(req)})`);
            res.json(result);
        } catch (error) {
            const status = error instanceof DebugActionError ? error.status : 500;
            const message = error instanceof Error ? error.message : String(error);
            log(`[DEBUG] ${pilotTag} ${action} ${JSON.stringify(details)} failed: ${message}`);
            res.status(status).send(message);
        }
    });
}
