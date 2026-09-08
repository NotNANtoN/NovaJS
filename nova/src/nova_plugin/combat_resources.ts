import * as t from 'io-ts';
import { Component } from 'nova_ecs/component';
import { Entity } from 'nova_ecs/entity';
import { ReplicationMergeContext, replicationPolicies } from 'nova_ecs/plugins/multiplayer_plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { AmmoType, ammoOutfitIds } from 'novadatainterface/WeaponData';
import { CombatResources, CombatResourcesCodec, PlayerState, PlayerStateComponent, PlayerStorePort, createInitialPlayerState, toPersistentPlayerState } from './player_state';
export { CombatResources, CombatResourcesCodec } from './player_state';
import { OutfitsState, OutfitsStateComponent } from './outfit_plugin';
import { ArmorComponent, IonizationComponent, ShieldComponent } from './health_plugin';
import { buyFuel, clampFuel, refuelsOnLanding } from './fuel';

import { getPersistentPlayerToken } from '../communication/player_identity';
import { makePlayerData, StoredPlayerData } from './player_data_projection';

/** Extend the legacy explicit PlayerData whitelist without exposing store metadata. */
export function makePlayerDataWithCombatResources(uuid: string, stored: StoredPlayerData | undefined) {
    const data = makePlayerData(uuid, stored);
    const balance = (stored?.state as { combatResources?: CombatResources } | undefined)?.combatResources;
    if (data.playerState && balance && CombatResourcesCodec.is(balance)) {
        data.playerState.combatResources = copyCombatResources(balance);
    }
    return data;
}

const Nonnegative = new t.Type<number, number, unknown>('CombatBalance',
    (v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0,
    (v, c) => typeof v === 'number' && Number.isFinite(v) && v >= 0
        ? t.success(v) : t.failure(v, c), v => v);
const Count = new t.Type<number, number, unknown>('AmmoCount',
    (v): v is number => Nonnegative.is(v) && Number.isSafeInteger(v),
    (v, c) => Nonnegative.is(v) && Number.isSafeInteger(v)
        ? t.success(v) : t.failure(v, c), v => v);

export function copyCombatResources(value: CombatResources): CombatResources {
    return { ...value, ammo: { ...value.ammo } };
}

// Filled from the weapon catalog, never from an owner's proposed inventory.
const ammoIds = new Set<string>();
const owners = new Map<string, CombatAuthority>();
export function bindCombatOwner(owner: string, authority: CombatAuthority): void {
    owners.set(owner, authority);
}
export function registerCombatAmmoIds(ids: Iterable<string>): void {
    for (const id of ids) ammoIds.add(id);
}
function ownerWrite(context: ReplicationMergeContext): boolean {
    return context.localIsAdmin && !context.peerIsAdmin && context.source === context.owner;
}
export function mergeCombatPlayerState(local: PlayerState, remote: PlayerState,
    context: ReplicationMergeContext): PlayerState {
    if (!ownerWrite(context)) return remote;
    // A decrease is an intent relative to a server-issued fuel basis, consumed
    // once. Absolute min(local, remote) would erase transfers/refills when an
    // older client snapshot arrives; trusting the submitted basis would mint fuel.
    const authority = owners.get(context.owner);
    const debit = local.combatResources ? authority?.acceptOwnerFuel(remote) ?? 0 : 0;
    const fuel = Math.max(0, (local.fuel ?? 0) - debit);
    return { ...remote, fuel, shipId: local.shipId,
        combatResources: local.combatResources };
}
export function mergeCombatOutfits(local: OutfitsState, remote: OutfitsState,
    context: ReplicationMergeContext): OutfitsState {
    if (!ownerWrite(context)) return remote;
    const result = new Map(remote);
    for (const id of ammoIds) {
        const held = local.get(id);
        if (held) result.set(id, { ...held });
        else result.delete(id);
    }
    return result;
}

/** Not serialized: class instances are intentionally not Immer drafts. */
export class CombatAuthority {
    constructor(readonly ledger: CombatLedger, readonly token: string,
        public balance: CombatResources, public state: PlayerState) {}
    retired = false;
    storeRevision?: number;
    readonly receipts = new Map<string, CombatShopResult>();
    landed?: string;
    shield?: number;
    armor?: number;
    ionization?: number;
    position?: readonly [number, number];
    system?: string;
    private readonly issuedFuel = new Map<number, { fuel: number; spent: number }>();
    advancePast(revision: number): void {
        this.issuedFuel.clear();
        this.balance.revision = Math.max(this.balance.revision, revision + 1);
        this.commit();
    }
    acceptOwnerFuel(state: PlayerState): number {
        const basis = this.issuedFuel.get(state.combatResources?.revision ?? this.balance.revision);
        if (!basis || !Nonnegative.is(state.fuel)) return 0;
        const spent = Math.max(0, basis.fuel - state.fuel);
        const debit = Math.max(0, spent - basis.spent);
        basis.spent = Math.max(basis.spent, spent);
        return debit;
    }
    project(entity: Entity): void {
        if (this.retired) return;
        const state = entity.components.get(PlayerStateComponent);
        if (!state) return;
        state.fuel = this.balance.fuel;
        state.shipId = this.balance.shipId;
        // A very short landing can be coalesced into an entity replacement
        // rather than a remove/add. Apply the approved hull even in that case.
        const shipComponent = [...entity.components.keys()].find(component => component.name === 'Ship');
        if (shipComponent && (entity.components.get(shipComponent) as { id?: string })?.id !== this.balance.shipId) {
            entity.components.set(shipComponent, { id: this.balance.shipId });
        }
        const projected = state.combatResources;
        if (!projected || projected.revision !== this.balance.revision
            || projected.shipId !== this.balance.shipId || projected.fuel !== this.balance.fuel
            || Object.keys(projected.ammo).length !== Object.keys(this.balance.ammo).length
            || Object.entries(this.balance.ammo).some(([id, count]) => projected.ammo[id] !== count)) {
            state.combatResources = copyCombatResources(this.balance);
            // A newer receipt also owns its credit debit. Do not attach its
            // revision to an old wallet and later persist that wallet as fresh.
            state.credits = this.state.credits;
        }
        const outfits = entity.components.get(OutfitsStateComponent);
        if (outfits) {
            for (const [id, count] of Object.entries(this.balance.ammo)) {
                if (count === 0) outfits.delete(id);
                else if (outfits.get(id)?.count !== count) outfits.set(id, { count });
            }
        }
        if (typeof this.shield === 'number') {
            const shield = entity.components.get(ShieldComponent);
            if (shield) shield.current = Math.min(shield.max, Math.max(0, this.shield));
        }
        if (typeof this.armor === 'number') {
            const armor = entity.components.get(ArmorComponent);
            if (armor) armor.current = Math.min(armor.max, Math.max(0, this.armor));
        }
        if (typeof this.ionization === 'number') {
            const ionization = entity.components.get(IonizationComponent);
            if (ionization) ionization.current = Math.min(ionization.max, Math.max(0, this.ionization));
        }
    }
    /** Observe only already-filtered gameplay state; also captures server
     * assistance/transfer/respawn mutations without retaining an ECS draft. */
    capture(entity: Entity): void {
        if (this.retired) return;
        const state = entity.components.get(PlayerStateComponent);
        if (!state) return;
        if (state.combatResources?.revision !== this.balance.revision) {
            this.project(entity);
            return;
        }
        let changed = false;
        const hullChanged = state.shipId !== this.balance.shipId;
        if (Nonnegative.is(state.fuel) && state.fuel !== this.balance.fuel) {
            this.balance.fuel = state.fuel;
            changed = true;
        }
        if (state.shipId !== this.balance.shipId) {
            // PlayerState merge prevents owner hull changes. Server recovery
            // is allowed to replace hull and its explicit stock inventory.
            this.balance.shipId = state.shipId;
            changed = true;
        }
        const outfits = entity.components.get(OutfitsStateComponent);
        if (outfits && hullChanged) for (const id of ammoIds) {
            const count = outfits.get(id)?.count ?? 0;
            if (Count.is(count) && count !== this.balance.ammo[id]) {
                this.balance.ammo[id] = count;
                changed = true;
            }
        }
        this.state = toPersistentPlayerState(state) as PlayerState;
        const movement = entity.components.get(MovementStateComponent);
        if (movement) this.position = [movement.position.x, movement.position.y];
        const shield = entity.components.get(ShieldComponent);
        if (shield) this.shield = Math.max(0, shield.current);
        const armor = entity.components.get(ArmorComponent);
        if (armor) this.armor = Math.max(0, armor.current);
        const ionization = entity.components.get(IonizationComponent);
        if (ionization) this.ionization = Math.max(0, ionization.current);
        this.system = state.currentSystem;
        if (changed) this.commit();
        this.project(entity);
    }
    commit(): void {
        this.balance.revision++;
        this.state.fuel = this.balance.fuel;
        this.state.shipId = this.balance.shipId;
        this.state.combatResources = copyCombatResources(this.balance);
        this.issuedFuel.set(this.balance.revision, { fuel: this.balance.fuel, spent: 0 });
        while (this.issuedFuel.size > 256) this.issuedFuel.delete(this.issuedFuel.keys().next().value!);
        this.ledger.persist(this);
    }
}
export const CombatAuthorityComponent = new Component<CombatAuthority>('CombatAuthority');
replicationPolicies.register(CombatAuthorityComponent, { codec: t.unknown as any, authority: 'local-only' });
replicationPolicies.registerName('Ship', {
    codec: t.type({ id: t.string }), authority: 'entity-owner', allowOwnerRemoval: false,
    merge: (local, remote, context) => ownerWrite(context) ? local : remote,
});

/** Paid player shots fail closed until a server ledger is attached. */
export function canPay(entity: Entity, ammoType: AmmoType): boolean {
    const authority = entity.components.get(CombatAuthorityComponent);
    if (!authority || authority.retired || authority.landed) return false;
    authority.capture(entity);
    if (ammoType === 'unlimited') return true;
    if (ammoType[0] === 'energy') return Nonnegative.is(ammoType[1])
        && authority.balance.fuel >= ammoType[1];
    return ammoOutfitIds(ammoType).some(id => (authority.balance.ammo[id] ?? 0) >= 1);
}
export function consumeShot(entity: Entity, ammoType: AmmoType): boolean {
    if (!canPay(entity, ammoType)) return false;
    const authority = entity.components.get(CombatAuthorityComponent)!;
    if (ammoType === 'unlimited') return true;
    if (ammoType[0] === 'energy') authority.balance.fuel -= ammoType[1];
    else {
        const id = ammoOutfitIds(ammoType).find(id => (authority.balance.ammo[id] ?? 0) >= 1);
        if (id === undefined) return false;
        authority.balance.ammo[id]--;
    }
    authority.commit();
    authority.project(entity);
    return true;
}
/** The callback must be synchronous. Undefined/false means no shot, no debit. */
export function withCost<T>(entity: Entity, ammoType: AmmoType,
    fire: () => T | undefined): T | undefined {
    if (!canPay(entity, ammoType)) return undefined;
    const fired = fire();
    if (fired !== undefined && fired !== false) consumeShot(entity, ammoType);
    return fired;
}

export type CombatShopRequest = {
    action: 'open' | 'close' | 'refuel' | 'buy' | 'sell' | 'ship' | 'recover' | 'sync';
    planet: string;
    revision: number;
    item?: string;
    state: PlayerState;
    outfits?: Array<[string, number]>;
    resolveAction?: CombatShopRequest['action'];
};
export type CombatShopResult = { balance: CombatResources; credits: number; landed?: string | null; resolved?: boolean };

/** One ledger per PlayerStore, shared across rooms and retained while landed. */
export class CombatLedger {
    readonly records = new Map<string, CombatAuthority>();
    private readonly loading = new Map<string, Promise<CombatAuthority>>();
    readonly ready: Promise<void>;
    constructor(readonly store: PlayerStorePort, readonly gameData: GameDataInterface) {
        this.ready = (async () => {
            const ids = await gameData.ids;
            const weapons = await Promise.all(ids.Weapon.map(id => gameData.data.Weapon.get(id)));
            registerCombatAmmoIds(weapons.flatMap(weapon => [...ammoOutfitIds(weapon.ammoType)]));
        })();
    }
    getSync(token: string): CombatAuthority | undefined {
        return this.records.get(token);
    }
    get(token: string): Promise<CombatAuthority> {
        const existing = this.records.get(token);
        if (existing) return Promise.resolve(existing);
        let loading = this.loading.get(token);
        if (!loading) {
            loading = this.initialize(token);
            this.loading.set(token, loading);
            void loading.catch(() => this.loading.delete(token));
        }
        return loading;
    }
    private async initialize(token: string): Promise<CombatAuthority> {
        await this.ready;
        const stored = await this.store.get(token);
        const state = (stored ?? createInitialPlayerState()) as PlayerState;
        const hull = await this.gameData.data.Ship.get(state.shipId);
        const saved = state.combatResources;
        const stock = new Map(Object.entries(hull.outfits).map(([id, count]) => [id, { count }]));
        const encoded = stored?.ship?.components.find(([name]) => name === 'OutfitsStateComponent')?.[1];
        if (!saved && Array.isArray(encoded)) for (const entry of encoded) {
            if (Array.isArray(entry) && typeof entry[0] === 'string' && Count.is(entry[1]?.count)) {
                stock.set(entry[0], { count: entry[1].count });
            }
        }
        const balance: CombatResources = saved && CombatResourcesCodec.is(saved)
            ? copyCombatResources(saved) : {
                shipId: state.shipId, fuel: clampFuel(state.fuel ?? hull.fuelCapacity, hull.fuelCapacity),
                ammo: {}, revision: 0,
            };
        for (const id of ammoIds) if (balance.ammo[id] === undefined) {
            balance.ammo[id] = saved ? 0 : Math.max(0, Math.floor(stock.get(id)?.count ?? 0));
        }
        const authority = new CombatAuthority(this, token, balance,
            toPersistentPlayerState(state) as PlayerState);
        this.records.set(token, authority);
        authority.commit();
        return authority;
    }
    async startNewPilot(token: string, metadata: Pick<PlayerState, 'pilotName' | 'shipName' | 'gender'>): Promise<void> {
        if (!this.store.startNewPilot) throw new Error('Pilot replacement unavailable');
        const old = await this.get(token);
        old.retired = true;
        try {
            await this.store.startNewPilot(token, metadata);
        } catch (error) {
            old.retired = false;
            throw error;
        }
        this.records.delete(token);
        this.loading.delete(token);
        for (const [owner, authority] of owners) if (authority === old) owners.delete(owner);
        const fresh = await this.get(token);
        // Do not reuse old revision numbers: delayed old-pilot fuel intents
        // must not be interpreted against the new pilot's starting tank.
        fresh.advancePast(old.balance.revision);
    }
    persist(authority: CombatAuthority): void {
        if (authority.retired) return;
        const revision = this.store.saveCombatResources?.(authority.token, copyCombatResources(authority.balance), authority.state.credits);
        if (typeof revision === 'number') authority.storeRevision = revision;
    }
    async transact(token: string, request: CombatShopRequest): Promise<CombatShopResult> {
        // Do not initialize a pilot from an HTTP request or trust its balances.
        const authority = this.records.get(token) ?? await this.loading.get(token);
        if (!authority || authority.retired || this.records.get(token) !== authority) throw new Error('Player combat resources are not ready');
        // Recovery is a synchronous fence: once acknowledged, no older open
        // or purchase can resume after an await and change the landing state.
        if (request.action === 'recover' || request.action === 'sync') {
            const fenceKey = JSON.stringify([request.revision, request.action, request.planet, request.item, request.resolveAction]);
            const receipt = authority.receipts.get(fenceKey);
            if (receipt) return { ...receipt, balance: copyCombatResources(receipt.balance) };
            if (authority.landed && authority.landed !== request.planet) throw new Error('Landed elsewhere');
            if (request.action === 'recover') authority.landed = undefined;
            const resolved = request.resolveAction !== undefined && authority.receipts.has(
                JSON.stringify([request.revision, request.resolveAction, request.planet, request.item]));
            authority.commit();
            const result = { balance: copyCombatResources(authority.balance), credits: authority.state.credits,
                landed: authority.landed ?? null, resolved };
            authority.receipts.set(fenceKey, result);
            while (authority.receipts.size > 128) authority.receipts.delete(authority.receipts.keys().next().value!);
            return { ...result, balance: copyCombatResources(result.balance) };
        }
        const originalRevision = authority.balance.revision;
        request = { ...request, state: toPersistentPlayerState(request.state) as PlayerState,
            outfits: request.outfits?.map(([id, count]) => [id, count]) };
        const key = JSON.stringify([request.revision, request.action, request.planet, request.item]);
        const previous = authority.receipts.get(key);
        if (previous) return { ...previous, balance: copyCombatResources(previous.balance) };
        // Availability imports the mission runtime; load it at transaction
        // time rather than creating an outfit/provider initialization cycle.
        const { hasSpaceportService, isPurchaseAvailable } = await import('../spaceport/availability');
        const planet = await this.gameData.data.Planet.get(request.planet);
        const hull = await this.gameData.data.Ship.get(authority.balance.shipId);
        const item = request.action === 'ship' && request.item
            ? await this.gameData.data.Ship.get(request.item) : undefined;
        const outfit = (request.action === 'buy' || request.action === 'sell') && request.item
            ? await this.gameData.data.Outfit.get(request.item) : undefined;
        const inventory = new Map<string, number>();
        if (request.outfits !== undefined) {
            if (!Array.isArray(request.outfits) || request.outfits.length > 1024) throw new Error('Invalid shop inventory');
            for (const entry of request.outfits) {
                if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Count.is(entry[1])) throw new Error('Invalid shop inventory');
                inventory.set(entry[0], entry[1]);
            }
        }
        for (const [id, count] of Object.entries(authority.balance.ammo)) inventory.set(id, count);
        const installed = outfit ? await Promise.all([...inventory].map(async ([id, count]) =>
            [await this.gameData.data.Outfit.get(id), count] as const)) : [];
        const system = request.action === 'open'
            ? await this.gameData.data.System.get(authority.system ?? authority.state.currentSystem)
            : undefined;
        // No await is allowed below this point. Recheck after the FINAL catalog
        // read, including System.get: a close/recovery may have run meanwhile.
        if (authority.retired || this.records.get(token) !== authority) throw new Error('Pilot session replaced');
        const completed = authority.receipts.get(key);
        if (completed) return { ...completed, balance: copyCombatResources(completed.balance) };
        if (authority.balance.revision !== originalRevision
            || request.revision !== originalRevision) throw new Error('Stale combat transaction');
        let credits = request.state.credits;
        if (!Nonnegative.is(credits)) throw new Error('Invalid credits');
        if (request.action === 'open') {
            if (!planet.canLand || !system!.planets.includes(planet.id)
                || !authority.position || Math.hypot(authority.position[0] - planet.position[0],
                    authority.position[1] - planet.position[1]) > 500) throw new Error('Not at this spaceport');
            if (authority.retired) throw new Error('Pilot session replaced');
            if (authority.landed) throw new Error('Already landed');
            const debit = authority.acceptOwnerFuel(request.state);
            authority.balance.fuel = Math.max(0, authority.balance.fuel - debit);
            authority.landed = planet.id;
            delete authority.shield;
            delete authority.armor;
            delete authority.ionization;
        } else {
            if (authority.landed !== planet.id
                && !(request.action === 'close' && !authority.landed)) throw new Error('Not landed');
            if (request.action === 'close') authority.landed = undefined;
            else if (request.action === 'refuel') {
                if (!refuelsOnLanding(planet)) throw new Error('No refuelling here');
                const result = buyFuel(authority.balance.fuel, hull.fuelCapacity, credits);
                authority.balance.fuel = result.fuel;
                credits = result.credits;
            } else if (item) {
                if (!hasSpaceportService(planet, 'shipyard') || !isPurchaseAvailable(item, planet, request.state)) {
                    throw new Error('Ship unavailable');
                }
                const price = Math.max(0, Math.floor(item.cost) - Math.floor(hull.cost * 0.8));
                if (credits < price) throw new Error('Insufficient credits');
                credits -= price;
                authority.balance.shipId = item.id;
                authority.balance.fuel = clampFuel(authority.balance.fuel, item.fuelCapacity);
                for (const id of ammoIds) authority.balance.ammo[id] = item.outfits[id] ?? 0;
            } else if (outfit && ammoIds.has(outfit.id)) {
                if (!hasSpaceportService(planet, 'outfitter')) throw new Error('No outfitter');
                const held = authority.balance.ammo[outfit.id] ?? 0;
                if (request.action === 'buy') {
                    if (!isPurchaseAvailable(outfit, planet, request.state, inventory)
                        || outfit.max > 0 && held >= outfit.max) throw new Error('Ammo unavailable');
                    const usedMass = installed.reduce((sum, [data, count]) => sum + (data.physics.freeMass ?? 0) * count, 0);
                    const flags = outfit.flags ?? 0;
                    const mounts = (mask: number) => installed.reduce((sum, [data, count]) => sum + (((data.flags ?? 0) & mask) !== 0 ? count : 0), 0);
                    if ((outfit.physics.freeMass ?? 0) > Math.max(0, hull.physics.freeMass - usedMass)
                        || (flags & 1) !== 0 && mounts(1) >= hull.maxGuns
                        || (flags & 2) !== 0 && mounts(2) >= hull.maxTurrets) throw new Error('No outfit capacity');
                    const price = Math.max(0, Math.floor(outfit.price));
                    if (credits < price) throw new Error('Insufficient credits');
                    credits -= price;
                    authority.balance.ammo[outfit.id] = (flags & 0x0010) === 0 ? held + 1 : held;
                } else {
                    if (held < 1 || ((outfit.flags ?? 0) & 0x0008) !== 0) throw new Error('Cannot sell ammo');
                    authority.balance.ammo[outfit.id] = held - 1;
                    credits += Math.floor(Math.max(0, outfit.price) * 0.25);
                }
            } else throw new Error('Invalid combat transaction');
        }
        authority.state = toPersistentPlayerState(request.state) as PlayerState;
        authority.state.credits = credits;
        authority.commit();
        const result = { balance: copyCombatResources(authority.balance), credits, landed: authority.landed ?? null };
        authority.receipts.set(key, result);
        while (authority.receipts.size > 128) authority.receipts.delete(authority.receipts.keys().next().value!);
        return { ...result, balance: copyCombatResources(result.balance) };
    }
}
const ledgers = new WeakMap<PlayerStorePort, CombatLedger>();
export function combatLedger(store: PlayerStorePort, gameData: GameDataInterface): CombatLedger {
    let ledger = ledgers.get(store);
    if (!ledger) { ledger = new CombatLedger(store, gameData); ledgers.set(store, ledger); }
    return ledger;
}

export const COMBAT_SHOP_TIMEOUT_MS = 5_000;
class CombatShopRejected extends Error {}

/** Bounds headers AND body reading, even if a transport ignores abort. */
export async function fetchCombatShop(body: string, timeoutMs = COMBAT_SHOP_TIMEOUT_MS): Promise<CombatShopResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Spaceport request timed out; retry to reconcile with the server.'));
        }, timeoutMs);
    });
    try {
        return await Promise.race([timeout, (async () => {
            const response = await fetch('/player/combat/shop', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
                signal: controller.signal,
            });
            if (!response.ok) throw new CombatShopRejected(await response.text());
            const result = await response.json() as CombatShopResult;
            if (!CombatResourcesCodec.is(result.balance) || !Nonnegative.is(result.credits)
                || result.landed !== undefined && result.landed !== null && typeof result.landed !== 'string') {
                throw new Error('Invalid combat receipt');
            }
            return result;
        })()]);
    } finally { clearTimeout(timer); }
}

function applyCombatReceipt(state: PlayerState, result: CombatShopResult): void {
    state.combatResources = copyCombatResources(result.balance);
    state.fuel = result.balance.fuel;
    state.credits = result.credits;
    state.shipId = result.balance.shipId;
}

/** Retry one identical request. On an uncertain shop spend, fence pending
 * requests and reconcile its receipt before allowing the dialog to continue. */
export async function combatShopTransaction(state: PlayerState, planet: string,
    action: CombatShopRequest['action'], item?: string,
    outfits?: ReadonlyMap<string, number>): Promise<CombatShopResult> {
    const request = { token: getPersistentPlayerToken(), action, planet, item,
        outfits: outfits ? [...outfits] : undefined,
        revision: state.combatResources?.revision ?? -1, state: toPersistentPlayerState(state) };
    const body = JSON.stringify(request);
    try {
        const result = await fetchCombatShop(body).catch(error => {
            if (error instanceof CombatShopRejected) throw error;
            return fetchCombatShop(body);
        });
        applyCombatReceipt(state, result);
        return result;
    } catch (error) {
        if (action !== 'open' && action !== 'recover' && action !== 'sync') {
            const result = await fetchCombatShop(JSON.stringify({ ...request, action: 'sync', resolveAction: action }));
            applyCombatReceipt(state, result);
            if (result.resolved || action === 'close' && result.landed === null) return result;
        }
        throw error;
    }
}
