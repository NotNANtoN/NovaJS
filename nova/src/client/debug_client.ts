import { plainSnapshot } from 'nova_ecs/draft_snapshot';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { MissionData } from 'novadatainterface/MissionData';
import { ShipData } from 'novadatainterface/ShipData';
import { PLANET_BUSTER_OUTFIT_ID } from '../common/debug_content';
import { applyCombatReceipt, CombatResources, isCombatAmmoId } from '../nova_plugin/combat_resources';
import {
    abortMission,
    acceptMission,
    forceCompleteMission,
    MissionDestinationOptions,
    MissionRuntimeResource,
    startPendingNcbMissions,
} from '../nova_plugin/mission_plugin';
import { applyGoalRecordingDelta } from '../nova_plugin/mission_ship_plugin';
import { NcbRuntimeResource, PendingMissionJumpComponent } from '../nova_plugin/ncb_runtime';
import { OutfitsStateComponent } from '../nova_plugin/outfit_plugin';
import {
    ActiveMission,
    advanceGameDate,
    decodePlayerState,
    PlayerState,
    PlayerStateComponent,
    releaseMissionCargo,
    setCargoCapacity,
} from '../nova_plugin/player_state';
import { ShipComponent, ShipDataComponent } from '../nova_plugin/ship_plugin';
import { SystemIdResource } from '../nova_plugin/system_id_resource';
import { adjustedOutfitCount } from './debug_menu_model';

/** The pilot's live flight entity and the star-system world it flies in. */
export interface DebugPlayer {
    entity: Entity;
    world: World;
}

export interface DebugClientHost {
    gameData: GameDataInterface;
    /** Undefined while landed, on the menu, or between systems. */
    player(): DebugPlayer | undefined;
    /** Destination context for forced mission accepts (the mission-board world). */
    missionWorld?(state: PlayerState): Promise<Pick<MissionDestinationOptions,
        'planets' | 'systems' | 'governments'>>;
}

export interface DebugServerResult {
    ok: true;
    balance?: CombatResources;
    credits?: number;
    destroyed?: boolean;
    message?: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'text' | 'json'>>;

function detachedCopy(state: PlayerState): PlayerState {
    const decoded = decodePlayerState(JSON.parse(JSON.stringify(plainSnapshot(state))));
    if (decoded._tag === 'Left') throw new Error('Pilot state could not be copied');
    return decoded.right;
}

function outfitsCopy(entity: Entity): Map<string, { count: number }> {
    const live = plainSnapshot(entity.components.get(OutfitsStateComponent));
    return new Map([...(live ?? new Map())].map(([id, value]) => [id, { count: value.count }]));
}

/**
 * Everything the debug menu does. Server-owned values (hull, fuel, ammo,
 * credits, health, stellar destruction) go through the gated `/debug/action`
 * route and the returned receipt is applied locally, so the server ledger and
 * the client agree. Owner-authored values (control bits, missions, outfits,
 * date, legal records, jumps) are changed on the pilot's own PlayerState and
 * replicate like normal play; the server is told so it can log them.
 */
export class DebugClient {
    constructor(
        private readonly debugToken: string,
        private readonly playerToken: string,
        private readonly host: DebugClientHost,
        private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    ) { }

    requirePlayer(): DebugPlayer {
        const player = this.host.player();
        if (!player || !player.entity.components.has(PlayerStateComponent)) {
            throw new Error('Not in flight (take off first)');
        }
        return player;
    }

    /** A detached copy of the pilot's state, safe to keep across awaits. */
    snapshot(): PlayerState | undefined {
        const state = this.host.player()?.entity.components.get(PlayerStateComponent);
        return state ? detachedCopy(state) : undefined;
    }

    outfits(): Map<string, { count: number }> {
        const player = this.host.player();
        return player ? outfitsCopy(player.entity) : new Map();
    }

    async server(body: Record<string, unknown>): Promise<DebugServerResult> {
        const response = await this.fetchImpl('/debug/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, token: this.debugToken, playerToken: this.playerToken }),
        });
        if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
        return await response.json() as DebugServerResult;
    }

    /** Server audit log for changes the client applies itself. */
    note(what: string, detail?: string): void {
        void this.server({ action: 'note', what, detail: detail?.slice(0, 2000) })
            .catch(error => console.warn('[DEBUG] note failed', error));
    }

    /** Adopt a server receipt: wallet, fuel, hull id and ledger ammunition. */
    applyReceipt(result: DebugServerResult): void {
        const player = this.host.player();
        if (!player || !result.balance) return;
        const state = player.entity.components.get(PlayerStateComponent);
        if (state) {
            applyCombatReceipt(state, { balance: result.balance, credits: result.credits ?? state.credits });
        }
        const outfits = outfitsCopy(player.entity);
        let changed = false;
        for (const [id, count] of Object.entries(result.balance.ammo)) {
            if ((outfits.get(id)?.count ?? 0) === count) continue;
            if (count === 0) outfits.delete(id);
            else outfits.set(id, { count });
            changed = true;
        }
        if (changed) player.entity.components.set(OutfitsStateComponent, outfits);
    }

    async switchShip(shipId: string): Promise<ShipData> {
        this.requirePlayer();
        const hull = await this.host.gameData.data.Ship.get(shipId);
        const result = await this.server({ action: 'ship', shipId });
        const { entity } = this.requirePlayer();
        this.applyReceipt(result);
        const state = entity.components.get(PlayerStateComponent);
        if (state) setCargoCapacity(state, hull.cargoCapacity);
        // Hull data before Ship so Ship-keyed providers read the new hull;
        // then the stock loadout, like a shipyard purchase.
        entity.components.set(ShipDataComponent, hull);
        entity.components.set(ShipComponent, { id: hull.id });
        entity.components.set(OutfitsStateComponent, new Map(
            Object.entries(hull.outfits).map(([id, count]) => [id, { count }])));
        return hull;
    }

    /** Give (delta > 0) or remove (delta < 0) outfits. Ammo goes through the ledger. */
    async adjustOutfit(outfitId: string, delta: number): Promise<number> {
        const { entity } = this.requirePlayer();
        const outfit = await this.host.gameData.data.Outfit.get(outfitId);
        const current = outfitsCopy(entity).get(outfitId)?.count ?? 0;
        const next = adjustedOutfitCount(current, delta);
        if (isCombatAmmoId(outfitId)) {
            this.applyReceipt(await this.server({ action: 'ammo', outfitId, count: next }));
            return next;
        }
        const live = this.requirePlayer().entity;
        const outfits = outfitsCopy(live);
        if (next === 0) outfits.delete(outfitId);
        else outfits.set(outfitId, { count: next });
        live.components.set(OutfitsStateComponent, outfits);
        this.note('outfit', `${outfitId} (${outfit.name}) ${current} -> ${next}`);
        return next;
    }

    givePlanetBuster(): Promise<number> {
        const current = this.outfits().get(PLANET_BUSTER_OUTFIT_ID)?.count ?? 0;
        return this.adjustOutfit(PLANET_BUSTER_OUTFIT_ID, current > 0 ? -current : 1);
    }

    /**
     * Credits travel in the owner's PlayerState as well as the ledger, so a
     * write already in flight could undo a server-only change. Set the same
     * absolute value on both sides; whichever arrives last agrees.
     */
    async credits(mode: 'set' | 'add', amount: number): Promise<number> {
        const current = this.snapshot();
        const target = Math.min(2_000_000_000, Math.max(0,
            (mode === 'add' ? current?.credits ?? 0 : 0) + amount));
        this.editState(state => { state.credits = target; });
        const result = await this.server({ action: 'credits', mode: 'set', amount: target });
        this.applyReceipt(result);
        return result.credits ?? target;
    }

    async refuel(): Promise<void> {
        this.applyReceipt(await this.server({ action: 'refuel' }));
    }

    async repair(): Promise<void> {
        await this.server({ action: 'repair' });
    }

    async setStellar(planetId: string, destroyed: boolean): Promise<DebugServerResult> {
        this.requirePlayer();
        return this.server({ action: 'stellar', planetId, destroyed });
    }

    /**
     * Edit a detached copy and install it. The DOM calls these between ECS
     * steps, when the component is a revoked or frozen draft: mutating it in
     * place was silently lost.
     */
    private editState(edit: (state: PlayerState) => void): PlayerState {
        const { entity } = this.requirePlayer();
        const state = detachedCopy(entity.components.get(PlayerStateComponent)!);
        edit(state);
        entity.components.set(PlayerStateComponent, state);
        return state;
    }

    setBit(bit: number, value: boolean): void {
        this.editState(state => { state.missionBits[bit] = value; });
        this.note('bit', `b${bit}=${value ? 1 : 0}`);
    }

    getBit(bit: number): boolean {
        return this.snapshot()?.missionBits[bit] ?? false;
    }

    /** Run an NCB set expression, then start any missions its `S` queued. */
    async runNcb(expression: string): Promise<void> {
        await this.mutateDetached('ncb', expression, (state, player, context) => {
            const runtime = player.world.resources.get(NcbRuntimeResource);
            if (!runtime) throw new Error('No NCB runtime in this system');
            runtime.apply(expression, player.entity, state);
            void context;
        });
    }

    async acceptMission(missionId: string): Promise<void> {
        const mission = await this.loadMission(missionId);
        await this.mutateDetached('accept', `${mission.id} (${mission.name})`, (state, _player, context) => {
            const accepted = acceptMission(state, mission, { ...context, ncb: context.ncb });
            if (!accepted) throw new Error('Mission could not be accepted (mission limit, cargo space or unresolved destination)');
        });
    }

    async completeMission(missionUuid: string): Promise<void> {
        const entry = this.findEntry(missionUuid);
        const mission = await this.missionForEntry(entry);
        const governments = await this.governments();
        await this.mutateDetached('complete', `${mission.id} (${mission.name})`, (state, _player, context) => {
            const target = state.activeMissions.find(candidate => entryKey(candidate) === missionUuid);
            if (!target) throw new Error('Mission is no longer active');
            forceCompleteMission(state, target, mission, context.ncb, governments);
        });
    }

    async abortMission(missionUuid: string): Promise<void> {
        const entry = this.findEntry(missionUuid);
        const mission = await this.missionForEntry(entry);
        const governments = await this.governments();
        await this.mutateDetached('abort', `${mission.id} (${mission.name})`, (state, _player, context) => {
            const target = state.activeMissions.find(candidate => entryKey(candidate) === missionUuid);
            if (!target) throw new Error('Mission is no longer active');
            if (!abortMission(state, target, mission, console.warn, context.ncb, governments)) {
                // Not abortable in retail (or already failed): drop it anyway.
                releaseMissionCargo(state, target.missionId);
                state.activeMissions.splice(state.activeMissions.indexOf(target), 1);
            }
        });
    }

    /** Advance the date; the mission runtime then runs crons, expiry and regeneration. */
    advanceDays(days: number): number {
        let date = 0;
        this.editState(state => { date = advanceGameDate(state, days); });
        this.note('date', `+${days} days -> ${date}`);
        return date;
    }

    setLegalRecord(governmentId: string, value: number): void {
        this.editState(state => {
            state.legalRecords = { ...state.legalRecords, [governmentId]: value };
        });
        this.note('legal', `${governmentId}=${value}`);
    }

    /** Jump straight to any system, like the NCB `M` operator (no fuel, no adjacency). */
    jumpTo(systemId: string): void {
        const { entity, world } = this.requirePlayer();
        if (world.resources.get(SystemIdResource) === systemId) throw new Error('Already in that system');
        entity.components.set(PendingMissionJumpComponent, { systemId, relative: false });
        this.note('jump', systemId);
    }

    private findEntry(missionUuid: string): ActiveMission {
        const entry = this.snapshot()?.activeMissions.find(candidate => entryKey(candidate) === missionUuid);
        if (!entry) throw new Error('Mission is not active');
        return entry;
    }

    private async missionForEntry(entry: ActiveMission): Promise<MissionData> {
        return entry.missionData as MissionData | undefined ?? this.loadMission(entry.missionId);
    }

    private async loadMission(id: string): Promise<MissionData> {
        const mission = await this.host.gameData.data.Mission?.get(id);
        if (!mission) throw new Error(`Unknown mission ${id}`);
        return mission;
    }

    private async governments() {
        const runtime = this.host.player()?.world.resources.get(MissionRuntimeResource);
        return runtime ? await runtime.governments() : [];
    }

    /**
     * Run `work` on a detached copy of the pilot's state, start missions its
     * NCB `S` operators queued, then merge only what changed back onto the
     * pilot's current state (the same delta merge server goal recording uses).
     */
    private async mutateDetached(what: string, detail: string,
        work: (state: PlayerState, player: DebugPlayer, context: MissionDestinationOptions & {
            ncb: NonNullable<MissionDestinationOptions['ncb']>;
        }) => void): Promise<void> {
        // Load everything first, then copy, work and start missions: ECS
        // component drafts are revoked at the end of each step, so nothing
        // read from the entity may be held across an await.
        const initial = this.snapshot();
        if (!initial) throw new Error('Not in flight (take off first)');
        const world = await this.host.missionWorld?.(initial);
        const governments = await this.governments();
        const player = this.requirePlayer();
        const before = detachedCopy(player.entity.components.get(PlayerStateComponent)!);
        const working = detachedCopy(before);
        const outfitsBefore = JSON.stringify([...outfitsCopy(player.entity)]);
        const outfits = outfitsCopy(player.entity);
        const systemId = player.world.resources.get(SystemIdResource) ?? working.currentSystem;
        const system = this.host.gameData.data.System.getCached(systemId);
        const runtime = player.world.resources.get(NcbRuntimeResource);
        const ncb = { ...(runtime?.setContext(player.entity, working) ?? {}), outfits };
        const context = {
            initialPlanetId: working.lastLandedPlanet || system?.planets[0] || '',
            initialSystemId: systemId,
            currentSystemId: systemId,
            ...world,
            governments,
            ncb,
        };
        work(working, player, context);
        await startPendingNcbMissions(this.host.gameData, working, context);
        const current = this.requirePlayer();
        const live = detachedCopy(current.entity.components.get(PlayerStateComponent)!);
        // Usually nothing else touched the pilot meanwhile: keep every field
        // the expression changed (crons, escorts, regen dates, ...). Otherwise
        // merge only the delta, like server-side goal recording.
        const merged = JSON.stringify(live) === JSON.stringify(before)
            ? working : applyGoalRecordingDelta(live, before, working);
        current.entity.components.set(PlayerStateComponent, merged);
        if (JSON.stringify([...outfits]) !== outfitsBefore) {
            current.entity.components.set(OutfitsStateComponent, outfits);
        }
        this.note(what, detail);
    }
}

export function entryKey(entry: Pick<ActiveMission, 'missionUuid' | 'missionId' | 'acceptedDate'>): string {
    return entry.missionUuid ?? `${entry.missionId}:${entry.acceptedDate ?? 0}`;
}
