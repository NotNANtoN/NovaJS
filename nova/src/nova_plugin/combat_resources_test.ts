import 'jasmine';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { MockCommunicator } from 'nova_ecs/plugins/mock_communicator';
import { multiplayer, MultiplayerData, Message, Comms, ReplicationMergeContext, replicationPolicies } from 'nova_ecs/plugins/multiplayer_plugin';
import { MockGameData } from 'novadatainterface/MockGameData';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { getDefaultPlanetData } from 'novadatainterface/PlanetData';
import { getDefaultOutfitData } from 'novadatainterface/OutfitData';
import { getDefaultSystemData } from 'novadatainterface/SystemData';
import { getDefaultProjectileWeaponData } from 'novadatainterface/WeaponData';
import { OutfitsStateComponent, OutfitPlugin } from './outfit_plugin';
import { GameDataResource } from './game_data_resource';
import { PlayerStateComponent, PlayerStateCodec, PlayerStatePlugin, PlayerStorePort, createInitialPlayerState } from './player_state';
import { CombatAuthority, CombatAuthorityComponent, CombatLedger, bindCombatOwner, canPay, consumeShot,
    copyCombatResources, mergeCombatPlayerState, mergeCombatOutfits, withCost, fetchCombatShop, combatShopTransaction } from './combat_resources';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

const ownerContext: ReplicationMergeContext = {
    source: 'player', owner: 'player', localUuid: 'server', localIsAdmin: true, peerIsAdmin: false,
};

async function setup() {
    const gameData = new MockGameData();
    gameData.data.Weapon.map.set('weapon', { ...getDefaultProjectileWeaponData(), id: 'weapon', ammoType: ['outfit', 'ammo'] });
    gameData.data.Ship.map.set('nova:128', { ...getDefaultShipData(), id: 'nova:128', fuelCapacity: 300, cost: 1000, outfits: { ammo: 3 } });
    gameData.data.Ship.map.set('upgrade', { ...getDefaultShipData(), id: 'upgrade', fuelCapacity: 200, cost: 2000, outfits: { ammo: 5 }, displayWeight: 1, buyRandom: 100, techLevel: 0 });
    gameData.data.Planet.map.set('port', { ...getDefaultPlanetData(), id: 'port', canLand: true, inhabited: true, hasOutfitter: true, hasShipyard: true, techLevel: 100, position: [0, 0] });
    gameData.data.Outfit.map.set('ammo', { ...getDefaultOutfitData(), id: 'ammo', price: 20, max: 10, techLevel: 0, displayWeight: 1, availabilityNCB: '' });
    gameData.data.System.map.set('nova:130', { ...getDefaultSystemData(), id: 'nova:130', planets: ['port'] });
    const saved: unknown[] = [];
    const store = {
        get: async () => ({ ...createInitialPlayerState(), fuel: 150 }),
        saveCombatResources: (_token: string, balance: unknown) => saved.push(balance),
    } as unknown as PlayerStorePort;
    const ledger = new CombatLedger(store, gameData);
    const authority = await ledger.get('pilot');
    authority.position = [0, 0];
    authority.system = 'nova:130';
    const entity = new Entity()
        .addComponent(PlayerStateComponent, createInitialPlayerState())
        .addComponent(OutfitsStateComponent, new Map([['ammo', { count: 999 }]]))
        .addComponent(CombatAuthorityComponent, authority);
    authority.project(entity);
    bindCombatOwner('player', authority);
    return { ledger, authority, entity, saved, gameData };
}

describe('authoritative combat resources', () => {
    it('fails closed before initialization, including unlimited player shots', () => {
        const entity = new Entity().addComponent(PlayerStateComponent, createInitialPlayerState());
        expect(canPay(entity, ['energy', 1])).toBeFalse();
        expect(consumeShot(entity, ['outfit', 'ammo'])).toBeFalse();
        expect(canPay(entity, 'unlimited')).toBeFalse();
    });

    it('seeds from server stock, charges fuel units, and persists detached ammo-only changes', async () => {
        const { entity, authority, saved } = await setup();
        expect(authority.balance.ammo.ammo).toBe(3);
        expect(consumeShot(entity, ['outfit', 'ammo'])).toBeTrue();
        const snapshot = saved.at(-1) as { ammo: Record<string, number> };
        expect(snapshot.ammo.ammo).toBe(2);
        expect(consumeShot(entity, ['energy', 50])).toBeTrue();
        expect(entity.components.get(PlayerStateComponent)!.fuel).toBe(100);
        expect(consumeShot(entity, ['energy', 101])).toBeFalse();
        expect(consumeShot(entity, ['energy', -1])).toBeFalse();
        expect(consumeShot(entity, ['energy', NaN])).toBeFalse();
        consumeShot(entity, ['outfit', 'ammo']);
        expect(snapshot.ammo.ammo).toBe(2);
    });

    it('uses one available alternative ammunition outfit and stops when all are empty', async () => {
        const { entity, authority } = await setup();
        authority.balance.ammo.ammo = 1;
        authority.balance.ammo.alternative = 2;
        authority.commit();
        authority.project(entity);
        const cost: ['outfits', string[]] = ['outfits', ['ammo', 'alternative']];
        expect(consumeShot(entity, cost)).toBeTrue();
        expect(authority.balance.ammo.ammo).toBe(0);
        expect(authority.balance.ammo.alternative).toBe(2);
        expect(consumeShot(entity, cost)).toBeTrue();
        expect(consumeShot(entity, cost)).toBeTrue();
        expect(authority.balance.ammo.alternative).toBe(0);
        expect(consumeShot(entity, cost)).toBeFalse();
    });

    it('does not debit failed spawns or execute an unaffordable callback', async () => {
        const { entity, authority } = await setup();
        expect(withCost(entity, ['energy', 20], () => undefined)).toBeUndefined();
        expect(authority.balance.fuel).toBe(150);
        const fire = jasmine.createSpy('fire').and.returnValue({ spawned: true });
        expect(withCost(entity, ['energy', 151], fire)).toBeUndefined();
        expect(fire).not.toHaveBeenCalled();
        expect(withCost(entity, ['energy', 20], fire)).toEqual({ spawned: true });
        expect(authority.balance.fuel).toBe(130);
    });

    it('protects ammo additions/removals but preserves non-ammo shop state', async () => {
        await setup();
        const local = new Map([['ammo', { count: 2 }]]);
        const remote = new Map([['ammo', { count: 999 }], ['engine', { count: 2 }]]);
        expect(mergeCombatOutfits(local, remote, ownerContext).get('ammo')?.count).toBe(2);
        expect(mergeCombatOutfits(local, remote, ownerContext).get('engine')?.count).toBe(2);
        expect(mergeCombatOutfits(local, new Map(), ownerContext).get('ammo')?.count).toBe(2);
        expect(mergeCombatOutfits(new Map(), remote, ownerContext).has('ammo')).toBeFalse();
    });

    it('applies a delayed jump debit once without rolling back server fuel gains', async () => {
        const { authority, entity } = await setup();
        const remote = { ...entity.components.get(PlayerStateComponent)!, fuel: 50,
            combatResources: copyCombatResources(authority.balance) };
        // Assistance or another player's transfer happens before this intent arrives.
        entity.components.get(PlayerStateComponent)!.fuel = 250;
        authority.capture(entity);
        const merged = mergeCombatPlayerState(entity.components.get(PlayerStateComponent)!, remote, ownerContext);
        expect(merged.fuel).toBe(150);
        entity.components.set(PlayerStateComponent, merged);
        authority.capture(entity);
        expect(mergeCombatPlayerState(merged, remote, ownerContext).fuel).toBe(150);
        expect(mergeCombatPlayerState(merged, { ...remote, fuel: 10000, shipId: 'forged' }, ownerContext).shipId).toBe('nova:128');
        expect(authority.balance.fuel).toBe(150);
    });

    it('does not refill from a stale second entity or a stock provider refresh', async () => {
        const { authority, entity } = await setup();
        const second = new Entity().addComponent(PlayerStateComponent, createInitialPlayerState())
            .addComponent(OutfitsStateComponent, new Map([['ammo', { count: 3 }]]));
        authority.project(second);
        consumeShot(entity, ['outfit', 'ammo']);
        consumeShot(entity, ['energy', 50]);
        authority.capture(second);
        expect(authority.balance.fuel).toBe(100);
        expect(authority.balance.ammo.ammo).toBe(2);
        entity.components.get(OutfitsStateComponent)!.set('ammo', { count: 999 });
        authority.capture(entity);
        expect(entity.components.get(OutfitsStateComponent)!.get('ammo')?.count).toBe(2);
    });

    it('authorizes landed refuel, ammo buy/sell and hull stock once per revision', async () => {
        const { ledger, authority, entity } = await setup();
        const state = entity.components.get(PlayerStateComponent)!;
        const request = (action: 'open' | 'refuel' | 'buy' | 'sell' | 'ship' | 'close', item?: string) => ({
            action, item, planet: 'port', state, revision: authority.balance.revision,
        });
        await expectAsync(ledger.transact('pilot', request('buy', 'ammo'))).toBeRejected();
        await ledger.transact('pilot', request('open'));
        expect(canPay(entity, ['energy', 1])).toBeFalse();
        const buy = request('buy', 'ammo');
        const receipt = await ledger.transact('pilot', buy);
        expect(receipt.balance.ammo.ammo).toBe(4);
        expect(receipt.credits).toBe(9980);
        expect(await ledger.transact('pilot', buy)).toEqual(receipt);
        expect(authority.balance.ammo.ammo).toBe(4);
        await expectAsync(ledger.transact('pilot', { ...buy, action: 'sell' })).toBeRejected();
        expect((await ledger.transact('pilot', request('sell', 'ammo'))).balance.ammo.ammo).toBe(3);
        const refuel = await ledger.transact('pilot', request('refuel'));
        expect(refuel.balance.fuel).toBe(300);
        expect(refuel.credits).toBe(9800);
        const ship = await ledger.transact('pilot', request('ship', 'upgrade'));
        expect(ship.balance.shipId).toBe('upgrade');
        expect(ship.balance.ammo.ammo).toBe(5);
        expect(ship.balance.fuel).toBe(200);
        await ledger.transact('pilot', request('close'));
        expect(authority.landed).toBeUndefined();
    });

    it('does not reland when a duplicate open resumes after close at the final catalog await', async () => {
        const { ledger, authority, entity, gameData } = await setup();
        const entered = deferred<void>();
        const release = deferred<void>();
        const system = await gameData.data.System.get('nova:130');
        let reads = 0;
        spyOn(gameData.data.System, 'get').and.callFake(async () => {
            if (++reads === 1) { entered.resolve(); await release.promise; }
            return system;
        });
        const open = { action: 'open' as const, planet: 'port', revision: authority.balance.revision,
            state: entity.components.get(PlayerStateComponent)! };
        const delayed = ledger.transact('pilot', open);
        await entered.promise;
        const receipt = await ledger.transact('pilot', open);
        await ledger.transact('pilot', { ...open, action: 'close', revision: authority.balance.revision });
        const closedRevision = authority.balance.revision;
        release.resolve();
        expect(await delayed).toEqual(receipt);
        expect(authority.landed).toBeUndefined();
        expect(authority.balance.revision).toBe(closedRevision);
    });

    it('fences an unresolved open before flight recovery, including late delivery', async () => {
        const { ledger, authority, entity, gameData } = await setup();
        const entered = deferred<void>();
        const release = deferred<void>();
        const system = await gameData.data.System.get('nova:130');
        spyOn(gameData.data.System, 'get').and.callFake(async () => {
            entered.resolve(); await release.promise; return system;
        });
        const open = { action: 'open' as const, planet: 'port', revision: authority.balance.revision,
            state: entity.components.get(PlayerStateComponent)! };
        const delayed = ledger.transact('pilot', open);
        await entered.promise;
        const recovery = await ledger.transact('pilot', { ...open, action: 'recover' });
        expect(recovery.landed).toBeNull();
        const rejection = expectAsync(delayed).toBeRejectedWithError('Stale combat transaction');
        release.resolve();
        await rejection;
        await expectAsync(ledger.transact('pilot', open)).toBeRejectedWithError('Stale combat transaction');
        expect(authority.landed).toBeUndefined();
    });

    it('rechecks authority identity after the final open await', async () => {
        const { ledger, authority, entity, gameData } = await setup();
        const entered = deferred<void>();
        const release = deferred<void>();
        const system = await gameData.data.System.get('nova:130');
        spyOn(gameData.data.System, 'get').and.callFake(async () => {
            entered.resolve(); await release.promise; return system;
        });
        const state = entity.components.get(PlayerStateComponent)!;
        const delayed = ledger.transact('pilot', { action: 'open', planet: 'port', revision: authority.balance.revision, state });
        await entered.promise;
        const replacement = new CombatAuthority(ledger, 'pilot', copyCombatResources(authority.balance), state);
        ledger.records.set('pilot', replacement);
        const rejected = expectAsync(delayed).toBeRejectedWithError('Pilot session replaced');
        release.resolve();
        await rejected;
        expect(authority.landed).toBeUndefined();
        expect(replacement.landed).toBeUndefined();
    });

    it('reconciles a committed purchase after both responses are lost without charging twice', async () => {
        const { ledger, authority, entity } = await setup();
        const state = entity.components.get(PlayerStateComponent)!;
        await ledger.transact('pilot', { action: 'open', planet: 'port', revision: authority.balance.revision, state });
        authority.project(entity);
        const actions: string[] = [];
        spyOn(globalThis, 'fetch').and.callFake(async (_url, options) => {
            const request = JSON.parse(String(options?.body));
            actions.push(request.action);
            const result = await ledger.transact('pilot', request);
            if (request.action === 'buy') throw new Error('Lost purchase response');
            return new Response(JSON.stringify(result));
        });
        const receipt = await combatShopTransaction(state, 'port', 'buy', 'ammo');
        expect(actions).toEqual(['buy', 'buy', 'sync']);
        expect(receipt.resolved).toBeTrue();
        expect(state.credits).toBe(9980);
        expect(authority.balance.ammo.ammo).toBe(4);
        authority.capture(entity);
        expect(authority.state.credits).toBe(9980);
    });

    it('bounds HTTP header and body waits even when fetch ignores abort', async () => {
        const fetchSpy = spyOn(globalThis, 'fetch').and.callFake(() => new Promise<Response>(() => {}));
        await expectAsync(fetchCombatShop('{}', 5)).toBeRejectedWithError(/timed out/);
        const signal = fetchSpy.calls.mostRecent().args[1]?.signal;
        expect(signal?.aborted).toBeTrue();
        fetchSpy.and.resolveTo({ ok: true, json: () => new Promise(() => {}) } as Response);
        await expectAsync(fetchCombatShop('{}', 5)).toBeRejectedWithError(/timed out/);
    });

    it('retires old flight handles when explicitly creating a new pilot', async () => {
        const { ledger, authority, entity } = await setup();
        consumeShot(entity, ['energy', 100]);
        const oldState = { ...entity.components.get(PlayerStateComponent)!, fuel: 0 };
        Object.assign(ledger.store, {
            startNewPilot: async () => {},
            get: async () => createInitialPlayerState(),
        });
        await ledger.startNewPilot('pilot', { pilotName: 'New', shipName: 'New Ship', gender: 'female' });
        const fresh = await ledger.get('pilot');
        expect(authority.retired).toBeTrue();
        expect(canPay(entity, 'unlimited')).toBeFalse();
        expect(fresh.balance.fuel).toBe(300);
        expect(fresh.balance.ammo.ammo).toBe(3);
        expect(fresh.acceptOwnerFuel(oldState)).toBe(0);
    });

    it('keeps protected components on owner removal and applies protection to codec deltas', async () => {
        const { authority, entity, gameData } = await setup();
        const world = new World();
        world.resources.set(GameDataResource, gameData);
        const communicator = new MockCommunicator('server');
        await world.addPlugin(multiplayer(communicator));
        world.singletonEntity.components.get(Comms)!.admins = new Set(['server']);
        await world.addPlugin(PlayerStatePlugin);
        await world.addPlugin(OutfitPlugin);
        entity.components.set(MultiplayerData, { owner: 'player' });
        world.entities.set('player', entity);
        world.step();
        expect(replicationPolicies.get(PlayerStateComponent.name)?.allowOwnerRemoval).toBeFalse();
        expect(replicationPolicies.get(OutfitsStateComponent.name)?.allowOwnerRemoval).toBeFalse();
        const delta = world.resources.get(DeltaResource)!;
        delta.applyRemoteDelta(entity, {
            componentStates: new Map([['OutfitsStateComponent', [['ammo', { count: 999 }]]]]),
        }, (component, local, remote) => replicationPolicies.get(component.name)?.merge?.(local, remote, ownerContext) ?? remote);
        authority.capture(entity);
        expect(entity.components.get(OutfitsStateComponent)!.get('ammo')?.count).toBe(3);
        const forged = { ...createInitialPlayerState(), fuel: 9999, shipId: 'forged',
            combatResources: { ...copyCombatResources(authority.balance), fuel: 9999 } };
        const send = (message: Parameters<typeof Message.encode>[0]) => {
            communicator.messages.next({ source: 'player', message: Message.encode(message) });
            world.step();
        };
        send({ state: new Map([['player', { components: [
            [MultiplayerData.name, { owner: 'player' }],
            [PlayerStateComponent.name, PlayerStateCodec.encode(forged)],
            [OutfitsStateComponent.name, [['ammo', { count: 999 }]]],
        ] }]]) });
        send({ delta: new Map([['player', { componentDeltas: new Map([
            [PlayerStateComponent.name, [{ op: 'replace', path: ['fuel'], value: 8888 }]],
            [OutfitsStateComponent.name, [{ op: 'replace', path: ['ammo', 'count'], value: 8888 }]],
        ]) }]]) });
        send({ delta: new Map([['player', { removeComponents: new Set([
            PlayerStateComponent.name, OutfitsStateComponent.name,
        ]) }]]) });
        const protectedEntity = world.entities.get('player')!;
        expect(protectedEntity.components.get(PlayerStateComponent)!.fuel).toBe(150);
        expect(protectedEntity.components.get(PlayerStateComponent)!.shipId).toBe('nova:128');
        expect(protectedEntity.components.get(OutfitsStateComponent)!.get('ammo')?.count).toBe(3);
    });
});
