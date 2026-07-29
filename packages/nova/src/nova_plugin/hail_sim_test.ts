import 'jasmine';
import { getDefaultGovtData } from 'novadatainterface/govt_data';
import { MockGameData } from 'novadatainterface/mock_game_data';
import { getDefaultShipData } from 'novadatainterface/ship_data';
import { WeaponDamage } from 'novadatainterface/weapon_data';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { World } from 'nova_ecs/world';
import { DamagedEvent } from './death_plugin.js';
import { DisabledComponent } from './disabled_component.js';
import { SourceComponent } from './fire_weapon_plugin.js';
import { completeEntity } from './entity_data_loader.js';
import { GovtComponent } from './govt_component.js';
import { AssistingComponent } from './hail_component.js';
import { applyHail, BRIBE_PACIFY_MS } from './hail_plugin.js';
import { ArmorComponent, FuelComponent } from './health_plugin.js';
import { makeShip } from './make_ship.js';
import { makeSystem } from './make_system.js';
import { NpcComponent } from './npc_ai_plugin.js';
import { CreditsComponent } from './player_state_plugin.js';
import { ControlledByComponent } from './ship_control.js';
import { TargetComponent } from './target_component.js';

const PEER = 'test peer';

async function makeWorld() {
    const gameData = new MockGameData();
    gameData.data.Ship.map.set('test:ship', {
        ...getDefaultShipData(),
        id: 'test:ship',
    });

    // A hostile, bribe-taking pirate govt.
    const pirate = getDefaultGovtData();
    pirate.id = 'test:pirate';
    pirate.flags.xenophobic = true;
    pirate.flags.largerBribes = true;
    gameData.data.Govt.map.set('test:pirate', pirate);
    // A peaceful govt that will lend a hand.
    const meek = getDefaultGovtData();
    meek.id = 'test:meek';
    gameData.data.Govt.map.set('test:meek', meek);
    // A politically NEUTRAL govt whose warships take bribes — used to test
    // behavioral hostility: only "currently attacking the player" makes one of
    // its ships bargain / refuse assistance, not its (neutral) politics.
    const armed = getDefaultGovtData();
    armed.id = 'test:armed';
    armed.flags.warshipsTakeBribes = true;
    gameData.data.Govt.map.set('test:armed', armed);
    await gameData.data.Govt.get('test:pirate');
    await gameData.data.Govt.get('test:meek');
    await gameData.data.Govt.get('test:armed');

    const world = await makeSystem('test:system', gameData);

    async function addShip(uuid: string, x: number, y: number,
        setup: (ship: ReturnType<typeof makeShip>) => void = () => { }) {
        const ship = makeShip(gameData.data.Ship.map.get('test:ship')!);
        ship.components.set(MovementStateComponent, {
            accelerating: 0,
            position: new Position(x, y),
            rotation: new Angle(0),
            turnBack: false,
            turning: 0,
            velocity: new Vector(0, 0),
        });
        setup(ship);
        await completeEntity(world, ship);
        world.entities.set(uuid, ship);
    }

    await addShip('player', 0, 0, ship => {
        ship.components.set(ControlledByComponent, { peerId: PEER });
        ship.components.set(CreditsComponent, { credits: 100_000 });
    });
    world.step();
    return { world, addShip };
}

function player(world: World) {
    return world.entities.get('player')!;
}
function target(world: World) {
    return world.entities.get('target')!;
}

describe('applyHail: bribe / beg for mercy', () => {
    it('deducts the demanded credits and pacifies a hostile pirate',
        async () => {
            const { world, addShip } = await makeWorld();
            await addShip('target', 500, 0, ship => {
                ship.components.set(GovtComponent, { id: 'test:pirate' });
                ship.components.set(NpcComponent,
                    { aiType: 3, mode: 'attack', aggressor: 'player' });
                ship.components.set(TargetComponent, { target: 'player' });
            });
            applyHail(world, PEER, { kind: 'bribe', target: 'target' });

            // 30% of 100k for a largerBribes govt.
            expect(player(world).components.get(CreditsComponent)!.credits)
                .toBe(70_000);
            const npc = target(world).components.get(NpcComponent)!;
            expect(npc.pacifiedFrom).toBe('player');
            expect(npc.pacifiedUntil).toBeGreaterThan(0);
            expect(npc.aggressor).toBeUndefined();
            // The pacified pirate drops its attack on the briber.
            expect(target(world).components.get(TargetComponent)!.target)
                .toBeUndefined();
        });

    it('does nothing to a non-hostile ship the player is not fighting',
        async () => {
            // Neutral politics AND not attacking the player: no bribe to make.
            const { world, addShip } = await makeWorld();
            await addShip('target', 500, 0, ship => {
                ship.components.set(GovtComponent, { id: 'test:meek' });
                ship.components.set(NpcComponent, { aiType: 3 });
            });
            applyHail(world, PEER, { kind: 'bribe', target: 'target' });
            expect(player(world).components.get(CreditsComponent)!.credits)
                .toBe(100_000);
        });

    it('bribes a NEUTRAL-govt ship that is attacking the player', async () => {
        // Behavioral hostility: a bribe-taking neutral warship the player
        // provoked (mode 'attack' aimed at the player) bargains just like a
        // politically hostile pirate — credits deducted, attack dropped.
        const { world, addShip } = await makeWorld();
        await addShip('target', 500, 0, ship => {
            ship.components.set(GovtComponent, { id: 'test:armed' });
            ship.components.set(NpcComponent,
                { aiType: 3, mode: 'attack', aggressor: 'player' });
            ship.components.set(TargetComponent, { target: 'player' });
        });
        applyHail(world, PEER, { kind: 'bribe', target: 'target' });
        // 10% of 100k (armed is not a largerBribes govt).
        expect(player(world).components.get(CreditsComponent)!.credits)
            .toBe(90_000);
        const npc = target(world).components.get(NpcComponent)!;
        expect(npc.pacifiedFrom).toBe('player');
        expect(npc.pacifiedUntil).toBeGreaterThan(0);
        expect(target(world).components.get(TargetComponent)!.target)
            .toBeUndefined();
    });

    it('the pacify reprieve lapses after BRIBE_PACIFY_MS', async () => {
        const { world, addShip } = await makeWorld();
        await addShip('target', 500, 0, ship => {
            ship.components.set(GovtComponent, { id: 'test:pirate' });
            ship.components.set(NpcComponent, { aiType: 3 });
        });
        applyHail(world, PEER, { kind: 'bribe', target: 'target' });
        const npc = target(world).components.get(NpcComponent)!;
        expect(npc.pacifiedUntil).toBeGreaterThanOrEqual(BRIBE_PACIFY_MS);
    });

    it('the reprieve is voided when the briber shoots the ship again',
        async () => {
            // A bribe lasts only "until the player provokes them again": once
            // the briber damages the pacified ship, NpcAggressionSystem clears
            // the reprieve so the ship resumes hostility.
            const { world, addShip } = await makeWorld();
            await addShip('target', 500, 0, ship => {
                ship.components.set(GovtComponent, { id: 'test:pirate' });
                ship.components.set(NpcComponent, { aiType: 3 });
            });
            applyHail(world, PEER, { kind: 'bribe', target: 'target' });
            const npc = target(world).components.get(NpcComponent)!;
            expect(npc.pacifiedFrom).toBe('player');
            expect(npc.pacifiedUntil).toBeGreaterThan(0);

            // A projectile fired by the player (its SourceComponent) hits the
            // pacified ship. NpcAggressionSystem reads the source off the
            // damager entity, so add the shot as a real entity.
            const zeroDamage: WeaponDamage = {
                shield: 0, armor: 0, ionization: 0, ionizationColor: 0,
                passThroughShield: 0, knockback: 0,
            };
            world.entities.set('playerShot',
                new Entity().addComponent(SourceComponent, 'player'));
            world.emit(DamagedEvent,
                { damage: zeroDamage, damager: 'playerShot' }, ['target']);
            world.step();

            const after = target(world).components.get(NpcComponent)!;
            expect(after.aggressor).toBe('player');
            expect(after.pacifiedFrom).toBeUndefined();
            expect(after.pacifiedUntil).toBeUndefined();
        });
});

describe('applyHail: request assistance', () => {
    it('marks a friendly ship as assisting when the player is disabled',
        async () => {
            const { world, addShip } = await makeWorld();
            player(world).components.set(DisabledComponent, { repairAt: null });
            await addShip('target', 150, 0, ship => {
                ship.components.set(GovtComponent, { id: 'test:meek' });
                ship.components.set(NpcComponent, { aiType: 3 });
            });
            applyHail(world, PEER,
                { kind: 'requestAssistance', target: 'target' });
            expect(target(world).components.get(AssistingComponent))
                .toEqual({ client: 'player' });
        });

    it('does nothing when the player is healthy', async () => {
        const { world, addShip } = await makeWorld();
        await addShip('target', 150, 0, ship => {
            ship.components.set(GovtComponent, { id: 'test:meek' });
            ship.components.set(NpcComponent, { aiType: 3 });
        });
        applyHail(world, PEER,
            { kind: 'requestAssistance', target: 'target' });
        expect(target(world).components.has(AssistingComponent)).toBeFalse();
    });

    it('refuses a neutral-govt ship ATTACKING the disabled player', async () => {
        // The assistance exploit: a neutral warship the player provoked is
        // shooting the disabled player — it must not also be able to fly over
        // and fully repair them. Behavioral hostility bars the request.
        const { world, addShip } = await makeWorld();
        player(world).components.set(DisabledComponent, { repairAt: null });
        await addShip('target', 150, 0, ship => {
            ship.components.set(GovtComponent, { id: 'test:meek' });
            ship.components.set(NpcComponent,
                { aiType: 3, mode: 'attack' });
            ship.components.set(TargetComponent, { target: 'player' });
        });
        applyHail(world, PEER,
            { kind: 'requestAssistance', target: 'target' });
        expect(target(world).components.has(AssistingComponent)).toBeFalse();
    });

    it('an alongside assister repairs and refuels the client, then leaves',
        async () => {
            const { world, addShip } = await makeWorld();
            const p = player(world);
            p.components.set(DisabledComponent, { repairAt: null });
            const armor = p.components.get(ArmorComponent)!;
            armor.current = 1;
            const fuel = p.components.get(FuelComponent);
            if (fuel) {
                fuel.current = 0;
            }
            // Place the helper already alongside (within ASSIST_ARRIVAL_RANGE).
            await addShip('target', 150, 0, ship => {
                ship.components.set(GovtComponent, { id: 'test:meek' });
                ship.components.set(NpcComponent, { aiType: 3 });
            });
            applyHail(world, PEER,
                { kind: 'requestAssistance', target: 'target' });
            world.step();
            expect(p.components.get(ArmorComponent)!.current)
                .toBe(p.components.get(ArmorComponent)!.max);
            if (fuel) {
                expect(p.components.get(FuelComponent)!.current)
                    .toBe(p.components.get(FuelComponent)!.max);
            }
            // The helper releases back to normal AI once done.
            expect(target(world).components.has(AssistingComponent))
                .toBeFalse();
        });
});
