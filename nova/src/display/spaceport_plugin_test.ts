import 'jasmine';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { MockGameData } from 'novadatainterface/MockGameData';
import { getDefaultShipData } from 'novadatainterface/ShipData';
import { getDefaultPlanetData } from 'novadatainterface/PlanetData';
import { getDefaultSystemData } from 'novadatainterface/SystemData';
import { createInitialPlayerState, PlayerStateComponent, PlayerStorePort } from '../nova_plugin/player_state';
import { CombatLedger, COMBAT_SHOP_TIMEOUT_MS, combatShopTransaction } from '../nova_plugin/combat_resources';
import { OutfitsStateComponent } from '../nova_plugin/outfit_plugin';
import { PlanetDataComponent } from '../nova_plugin/planet_plugin';
import { Spaceport } from '../spaceport/spaceport';
import { LandSystem, runLandingSession } from './spaceport_plugin';

async function setupLanding() {
    const data = new MockGameData();
    data.data.Ship.map.set('nova:128', { ...getDefaultShipData(), id: 'nova:128', fuelCapacity: 300 });
    const planet = { ...getDefaultPlanetData(), id: 'port', canLand: true, inhabited: true, position: [0, 0] as [number, number] };
    data.data.Planet.map.set('port', planet);
    data.data.System.map.set('nova:130', { ...getDefaultSystemData(), id: 'nova:130', planets: ['port'] });
    const ledger = new CombatLedger({ get: async () => createInitialPlayerState() } as unknown as PlayerStorePort, data);
    const authority = await ledger.get('pilot');
    authority.position = [0, 0];
    authority.system = 'nova:130';
    const ship = new Entity().addComponent(PlayerStateComponent, createInitialPlayerState())
        .addComponent(OutfitsStateComponent, new Map());
    authority.project(ship);
    const state = ship.components.get(PlayerStateComponent)!;
    const world = new World();
    world.entities.set('player', ship);
    world.entities.set('planet', new Entity().addComponent(PlanetDataComponent, planet));
    const fetchSpy = spyOn(globalThis, 'fetch').and.callFake(async (_url, options) => {
        try {
            const receipt = await ledger.transact('pilot', JSON.parse(String(options?.body)));
            return new Response(JSON.stringify(receipt), { status: 200 });
        } catch (error) { return new Response(String(error), { status: 409 }); }
    });
    const spaceport = {
        container: { position: { x: 0, y: 0 } },
        authorizeLanding: () => combatShopTransaction(state, 'port', 'open'),
        show: jasmine.createSpy('show').and.resolveTo(ship),
        cancelLandingPresentation: jasmine.createSpy('cancelLandingPresentation'),
    };
    const land = () => (LandSystem.step as (...args: any[]) => void)(
        { id: 'port', uuid: 'planet' }, 'player', world.entities, () => [[spaceport]],
        { x: 800, y: 600 }, ship, jasmine.createSpy('emit'), {}, undefined, undefined,
        undefined, world, state, undefined, {},
    );
    const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
    return { ledger, authority, ship, state, world, spaceport, land, fetchSpy, settle };
}

describe('spaceport landing recovery', () => {
    it('restores the actual LandSystem entity after an open rejection without running landing side effects', async () => {
        const { authority, world, spaceport, land, state, settle } = await setupLanding();
        authority.position = [1000, 0];
        const date = state.gameDate;
        const landings = state.landingCount;
        land();
        expect(world.entities.has('player')).toBeFalse();
        await settle();
        expect(world.entities.has('player')).toBeTrue();
        expect(authority.landed).toBeUndefined();
        expect(spaceport.show).not.toHaveBeenCalled();
        expect(state.gameDate).toBe(date);
        expect(state.landingCount).toBe(landings);
    });

    it('does not restore flight after a lost successful open until recovery is acknowledged', async () => {
        const { authority, ledger, world, spaceport, land, fetchSpy, settle } = await setupLanding();
        const authorize = spaceport.authorizeLanding;
        spaceport.authorizeLanding = async () => { await authorize(); throw new Error('Lost open response'); };

        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        fetchSpy.and.callFake(async (_url, options) => {
            const request = JSON.parse(String(options?.body));
            if (request.action === 'recover') await gate;
            const receipt = await ledger.transact('pilot', request);
            return new Response(JSON.stringify(receipt));
        });
        land();
        await settle();
        expect(authority.landed).toBe('port');
        expect(world.entities.has('player')).toBeFalse();
        release();
        await settle();
        expect(authority.landed).toBeUndefined();
        expect(world.entities.has('player')).toBeTrue();
        expect(spaceport.show).not.toHaveBeenCalled();
    });

    it('offers a retry while recovery is unavailable instead of restoring an ambiguously landed ship', async () => {
        const { authority, ledger, ship, state, world } = await setupLanding();
        world.entities.delete('player');
        let retry: (() => Promise<void>) | undefined;
        let offline = true;
        await runLandingSession({
            authorize: async () => {
                await ledger.transact('pilot', { action: 'open', planet: 'port', revision: authority.balance.revision, state });
                throw new Error('Lost response');
            },
            land: async () => ship,
            recover: async () => {
                if (offline) throw new Error('Offline');
                await ledger.transact('pilot', { action: 'recover', planet: 'port', revision: -1, state });
                return ship;
            },
            restore: entity => {
                expect(authority.landed).toBeUndefined();
                world.entities.set('player', entity);
            },
            abort: () => {},
            failed: (_error, attempt) => { retry = attempt; },
        });
        expect(retry).toBeDefined();
        expect(world.entities.has('player')).toBeFalse();
        expect(authority.landed).toBe('port');
        offline = false;
        await retry!();
        expect(world.entities.has('player')).toBeTrue();
    });

    it('releases the real departure combatBusy guard when requests never settle', async () => {
        const { ship, fetchSpy } = await setupLanding();
        fetchSpy.and.callFake(() => new Promise<Response>(() => {}));
        const menu = Object.assign(Object.create(Spaceport.prototype), {
            input: ship, id: 'port', combatBusy: false, container: { visible: true },
        });
        jasmine.clock().install();
        try {
            const done = menu.done() as Promise<void>;
            expect(menu.combatBusy).toBeTrue();
            for (let request = 0; request < 3; request++) {
                jasmine.clock().tick(COMBAT_SHOP_TIMEOUT_MS + 1);
                for (let microtask = 0; microtask < 20; microtask++) await Promise.resolve();
            }
            await done;
            expect(menu.combatBusy).toBeFalse();
            expect(menu.container.visible).toBeTrue();
        } finally { jasmine.clock().uninstall(); }
    });
});
