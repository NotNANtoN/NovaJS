import 'jasmine';
import { getDefaultGovtData } from 'novadatainterface/govt_data';
import { MockGameData } from 'novadatainterface/mock_game_data';
import { getDefaultOutfitData } from 'novadatainterface/outfit_data';
import { getDefaultShipData } from 'novadatainterface/ship_data';
import { getDefaultProjectileWeaponData, ProjectileWeaponData } from 'novadatainterface/weapon_data';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { World } from 'nova_ecs/world';
import { ReturnWhenTargetRemovedComponent, startReturnHome } from './bay_plugin.js';
import { completeEntity } from './entity_data_loader.js';
import { EscortCommandComponent, EscortOrdersComponent } from './escort_command.js';
import { DEFEND_RADIUS, inFrontQuadrant } from './escort_command_plugin.js';
import { OwnerComponent, SourceComponent } from './fire_weapon_plugin.js';
import { GovtComponent } from './govt_component.js';
import { makeShip } from './make_ship.js';
import { makeSystem } from './make_system.js';
import { FormationComponent } from './npc_ai_plugin.js';
import { applyControlEvents, ControlledByComponent } from './ship_control.js';
import { TargetComponent } from './target_component.js';
import { WeaponsStateComponent } from './weapons_state.js';

const PEER = 'test peer';
const FQ_WEAPON = 'test:fq';
const GUN_WEAPON = 'test:gun';
// Range: speed 500 px/s * 2 s = 1000 px.
const FQ_RANGE = 1000;

async function makeWorld() {
    const gameData = new MockGameData();

    const fqWeapon: ProjectileWeaponData = {
        ...getDefaultProjectileWeaponData(),
        id: FQ_WEAPON,
        guidance: 'frontQuadrant',
        reload: 1,
        shotDuration: 2000,
        fireGroup: 'primary',
    };
    fqWeapon.physics = { ...fqWeapon.physics, speed: 500 };
    gameData.data.Weapon.map.set(FQ_WEAPON, fqWeapon);
    gameData.data.Weapon.map.set(GUN_WEAPON, {
        ...getDefaultProjectileWeaponData(),
        id: GUN_WEAPON,
        guidance: 'unguided',
        reload: 1,
        shotDuration: 2000,
        fireGroup: 'primary',
    });
    gameData.data.Outfit.map.set('test:fqOutfit', {
        ...getDefaultOutfitData(),
        id: 'test:fqOutfit',
        weapons: { [FQ_WEAPON]: 1 },
    });
    gameData.data.Outfit.map.set('test:gunOutfit', {
        ...getDefaultOutfitData(),
        id: 'test:gunOutfit',
        weapons: { [GUN_WEAPON]: 1 },
    });
    gameData.data.Ship.map.set('test:ship', {
        ...getDefaultShipData(),
        id: 'test:ship',
        outfits: { 'test:fqOutfit': 1, 'test:gunOutfit': 1 },
    });

    const pirate = getDefaultGovtData();
    pirate.id = 'test:pirate';
    pirate.flags.xenophobic = true;
    gameData.data.Govt.map.set('test:pirate', pirate);
    const meek = getDefaultGovtData();
    meek.id = 'test:meek';
    gameData.data.Govt.map.set('test:meek', meek);
    // Warm the caches the sim reads synchronously.
    await gameData.data.Govt.get('test:pirate');
    await gameData.data.Govt.get('test:meek');

    const world = await makeSystem('test:system', gameData);

    async function addShip(uuid: string, x: number, y: number,
        setup: (ship: ReturnType<typeof makeShip>) => void = () => { }) {
        const ship = makeShip(gameData.data.Ship.map.get('test:ship')!);
        ship.components.set(MovementStateComponent, {
            accelerating: 0,
            position: new Position(x, y),
            // Angle π/2: facing +x.
            rotation: new Angle(Math.PI / 2),
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
    });
    await addShip('escort', 0, 200, ship => {
        ship.components.set(FormationComponent, { leader: 'player', slot: 0 });
        ship.components.set(EscortCommandComponent, { command: 'formation' });
    });
    world.step();
    return { world, addShip };
}

function press(world: World, action: string) {
    applyControlEvents(world, PEER,
        [{ action: action as never, state: 'start' }]);
    world.step();
    applyControlEvents(world, PEER,
        [{ action: action as never, state: false }]);
    world.step();
}

function command(world: World, uuid = 'escort') {
    return world.entities.get(uuid)!.components.get(EscortCommandComponent)!;
}

function setPlayerTarget(world: World, target: string | undefined) {
    world.entities.get('player')!.components
        .set(TargetComponent, { target });
}

describe('escort commands', () => {
    it('attack: fights the player target until it is destroyed, then ' +
        'returns to formation', async () => {
            const { world, addShip } = await makeWorld();
            await addShip('enemy', 500, 0);
            setPlayerTarget(world, 'enemy');
            press(world, 'attack');
            expect(command(world)).toEqual(
                { command: 'attack', target: 'enemy' });
            // The escort locks on and opens fire in range.
            world.step();
            expect(world.entities.get('escort')!.components
                .get(TargetComponent)!.target).toBe('enemy');
            const weapons = world.entities.get('escort')!.components
                .get(WeaponsStateComponent)!;
            expect([...weapons.values()].some(w => w.firing)).toBeTrue();
            // Victim destroyed: back to formation, guns silent.
            world.entities.delete('enemy');
            world.step();
            expect(command(world).command).toBe('formation');
            expect([...weapons.values()].every(w => !w.firing)).toBeTrue();
        });

    it('attack without a player target is ignored', async () => {
        const { world } = await makeWorld();
        setPlayerTarget(world, undefined);
        press(world, 'attack');
        expect(command(world).command).toBe('formation');
    });

    it('a new command interrupts the current one', async () => {
        const { world, addShip } = await makeWorld();
        await addShip('enemy', 500, 0);
        setPlayerTarget(world, 'enemy');
        press(world, 'attack');
        expect(command(world).command).toBe('attack');
        press(world, 'holdPosition');
        expect(command(world).command).toBe('holdPosition');
        press(world, 'formation');
        expect(command(world).command).toBe('formation');
    });

    it('commands only reach DIRECT escorts; wings mirror their ' +
        'carrier instead', async () => {
            const { world, addShip } = await makeWorld();
            // A wing fighter launched from the ESCORT's bay.
            await addShip('wing', 30, 230, ship => {
                ship.components.set(FormationComponent,
                    { leader: 'escort', slot: 0 });
                ship.components.set(EscortCommandComponent,
                    { command: 'formation' });
                ship.components.set(OwnerComponent, { owner: 'escort' });
                ship.components.set(SourceComponent, 'escort');
            });
            await addShip('enemy', 500, 0);
            setPlayerTarget(world, 'enemy');
            press(world, 'attack');
            // Direct escort commanded; the wing was NOT commanded
            // directly, but mirrors its carrier on the next tick.
            expect(command(world, 'escort'))
                .toEqual({ command: 'attack', target: 'enemy' });
            world.step();
            expect(command(world, 'wing'))
                .toEqual({ command: 'attack', target: 'enemy' });
            // Carrier completes (victim gone) -> wing follows it back.
            world.entities.delete('enemy');
            world.step();
            world.step();
            expect(command(world, 'escort').command).toBe('formation');
            expect(command(world, 'wing').command).toBe('formation');
        });

    it('defend: engages an iff-hostile intruder inside DEFEND_RADIUS, ' +
        'ignores ships outside it', async () => {
            const { world, addShip } = await makeWorld();
            await addShip('farPirate', DEFEND_RADIUS + 800, 200, ship => {
                ship.components.set(GovtComponent, { id: 'test:pirate' });
            });
            await addShip('meek', 300, 200, ship => {
                ship.components.set(GovtComponent, { id: 'test:meek' });
            });
            press(world, 'defend');
            world.step();
            // Nothing hostile in range: still watching, on station.
            expect(command(world).command).toBe('defend');
            expect(command(world).target).toBeUndefined();
            // A pirate wanders into the bubble.
            await addShip('nearPirate', 400, 200, ship => {
                ship.components.set(GovtComponent, { id: 'test:pirate' });
            });
            world.step();
            world.step();
            expect(command(world).target).toBe('nearPirate');
            // TODO(disabling): when DisabledComponent lands, this
            // engagement should end at disable, not destruction.
            world.entities.delete('nearPirate');
            world.step();
            expect(command(world).command).toBe('defend');
            expect(command(world).target).toBeUndefined();
        });

    it('holdPosition: brakes to rest and stays put; knocked around, it ' +
        'stops again without returning', async () => {
            const { world } = await makeWorld();
            const movement = world.entities.get('escort')!.components
                .get(MovementStateComponent)!;
            movement.velocity = new Vector(120, 0);
            press(world, 'holdPosition');
            for (let i = 0; i < 600; i++) {
                world.step();
            }
            const stopped = world.entities.get('escort')!.components
                .get(MovementStateComponent)!;
            expect(stopped.velocity.length).toBeLessThan(1);
            const restingPosition = Position.fromVectorLike(stopped.position);
            // A hit knocks it away: it re-stops where it ends up.
            stopped.velocity = new Vector(0, 80);
            for (let i = 0; i < 600; i++) {
                world.step();
            }
            const after = world.entities.get('escort')!.components
                .get(MovementStateComponent)!;
            expect(after.velocity.length).toBeLessThan(1);
            // It did NOT fly back to the original hold point.
            expect(after.position.subtract(restingPosition).length)
                .toBeGreaterThan(20);
        });

    it('returnToBay: bay-launched fighters fly home to dock; plain ' +
        'escorts just return to formation', async () => {
            const { world, addShip } = await makeWorld();
            await addShip('fighter', 40, 220, ship => {
                ship.components.set(FormationComponent,
                    { leader: 'player', slot: 1 });
                ship.components.set(EscortCommandComponent,
                    { command: 'formation' });
                ship.components.set(ReturnWhenTargetRemovedComponent,
                    undefined);
                ship.components.set(OwnerComponent, { owner: 'player' });
                ship.components.set(SourceComponent, 'player');
            });
            press(world, 'returnToBay');
            world.step();
            const fighter = world.entities.get('fighter')!;
            expect([...fighter.components.keys()]
                .some(component => component.name === 'ReturnComponent'))
                .toBeTrue();
            // The plain hired escort has no bay: back to formation.
            expect(command(world, 'escort').command).toBe('formation');
        });

    it('front-quadrant turrets fire opportunistically in formation — ' +
        'and no other weapon type does', async () => {
            const { world, addShip } = await makeWorld();
            const escort = () => world.entities.get('escort')!;
            const rotation = () => escort().components
                .get(MovementStateComponent)!.rotation;
            const position = () => escort().components
                .get(MovementStateComponent)!.position;
            // A pirate dead ahead, well inside the weapon's range.
            const ahead = rotation().getUnitVector().scale(FQ_RANGE * 0.5);
            await addShip('pirate', position().x + ahead.x,
                position().y + ahead.y, ship => {
                    ship.components.set(GovtComponent, { id: 'test:pirate' });
                });
            // Re-place ahead of the CURRENT facing each tick so slow
            // formation turning can't move it out of the quadrant.
            for (let i = 0; i < 3; i++) {
                const unit = rotation().getUnitVector();
                world.entities.get('pirate')!.components
                    .get(MovementStateComponent)!.position =
                    position().add(unit.scale(FQ_RANGE * 0.5)) as Position;
                world.step();
            }
            const weapons = escort().components
                .get(WeaponsStateComponent)!;
            expect(weapons.get(FQ_WEAPON)!.firing).toBeTrue();
            expect(weapons.get(FQ_WEAPON)!.target).toBe('pirate');
            // The plain gun holds fire: front-quadrant turrets ONLY.
            expect(weapons.get(GUN_WEAPON)!.firing).toBeFalse();

            // Behind the escort: out of the front quadrant, no fire.
            for (let i = 0; i < 3; i++) {
                const unit = rotation().getUnitVector();
                world.entities.get('pirate')!.components
                    .get(MovementStateComponent)!.position =
                    position().add(unit.scale(-FQ_RANGE * 0.5)) as Position;
                world.step();
            }
            expect(weapons.get(FQ_WEAPON)!.firing).toBeFalse();

            // Ahead but out of range: no fire.
            for (let i = 0; i < 3; i++) {
                const unit = rotation().getUnitVector();
                world.entities.get('pirate')!.components
                    .get(MovementStateComponent)!.position =
                    position().add(unit.scale(FQ_RANGE * 3)) as Position;
                world.step();
            }
            expect(weapons.get(FQ_WEAPON)!.firing).toBeFalse();
        });

    it('front-quadrant turrets ignore non-hostile ships', async () => {
        const { world, addShip } = await makeWorld();
        const escort = () => world.entities.get('escort')!;
        for (let i = 0; i < 3; i++) {
            const m = escort().components.get(MovementStateComponent)!;
            if (!world.entities.has('meek')) {
                const unit = m.rotation.getUnitVector();
                await addShip('meek', m.position.x + unit.x * 300,
                    m.position.y + unit.y * 300, ship => {
                        ship.components.set(GovtComponent,
                            { id: 'test:meek' });
                    });
            } else {
                const unit = m.rotation.getUnitVector();
                world.entities.get('meek')!.components
                    .get(MovementStateComponent)!.position =
                    m.position.add(unit.scale(300)) as Position;
            }
            world.step();
        }
        const weapons = escort().components.get(WeaponsStateComponent)!;
        expect(weapons.get(FQ_WEAPON)!.firing).toBeFalse();
    });

    it('the restrict-turrets order limits opportunistic fire to the ' +
        "player's current target", async () => {
            const { world, addShip } = await makeWorld();
            const escort = () => world.entities.get('escort')!;
            const place = (uuid: string, along: number) => {
                const m = escort().components.get(MovementStateComponent)!;
                const unit = m.rotation.getUnitVector();
                const perpendicular = new Vector(-unit.y, unit.x);
                world.entities.get(uuid)!.components
                    .get(MovementStateComponent)!.position =
                    m.position.add(unit.scale(400))
                        .add(perpendicular.scale(along)) as Position;
            };
            await addShip('pirateA', 400, 200, ship => {
                ship.components.set(GovtComponent, { id: 'test:pirate' });
            });
            await addShip('pirateB', 450, 200, ship => {
                ship.components.set(GovtComponent, { id: 'test:pirate' });
            });
            // Restrict on; the player targets pirateB.
            press(world, 'escortRestrictFire');
            expect(world.entities.get('player')!.components
                .get(EscortOrdersComponent)?.restrictTurretsToTarget)
                .toBeTrue();
            setPlayerTarget(world, 'pirateB');
            for (let i = 0; i < 3; i++) {
                place('pirateA', -50);
                place('pirateB', 50);
                world.step();
            }
            const weapons = escort().components
                .get(WeaponsStateComponent)!;
            expect(weapons.get(FQ_WEAPON)!.firing).toBeTrue();
            expect(weapons.get(FQ_WEAPON)!.target).toBe('pirateB');
            // No player target: restricted turrets stay silent even
            // with hostiles in the quadrant.
            setPlayerTarget(world, undefined);
            for (let i = 0; i < 3; i++) {
                place('pirateA', -50);
                place('pirateB', 50);
                world.step();
            }
            expect(weapons.get(FQ_WEAPON)!.firing).toBeFalse();
        });
});

describe('inFrontQuadrant', () => {
    const movement = {
        position: new Position(0, 0),
        velocity: new Vector(0, 0),
        rotation: new Angle(Math.PI / 2), // Facing +x.
        accelerating: 0,
        turning: 0,
        turnBack: false,
    };

    it('accepts targets within ±45° of the facing', () => {
        expect(inFrontQuadrant(movement, { x: 100, y: 0 })).toBeTrue();
        expect(inFrontQuadrant(movement, { x: 100, y: 90 })).toBeTrue();
        expect(inFrontQuadrant(movement, { x: 100, y: -90 })).toBeTrue();
    });

    it('rejects targets beside or behind', () => {
        expect(inFrontQuadrant(movement, { x: 0, y: 100 })).toBeFalse();
        expect(inFrontQuadrant(movement, { x: -100, y: 0 })).toBeFalse();
        expect(inFrontQuadrant(movement, { x: 100, y: 110 })).toBeFalse();
    });
});
