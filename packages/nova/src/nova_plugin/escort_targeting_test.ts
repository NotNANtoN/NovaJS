import 'jasmine';
import { MockGameData } from 'novadatainterface/mock_game_data';
import { getDefaultShipData } from 'novadatainterface/ship_data';
import { Position } from 'nova_ecs/datatypes/position';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { World } from 'nova_ecs/world';
import { DisabledComponent } from './disabled_component.js';
import { ExplodingComponent } from './death_plugin.js';
import { completeEntity } from './entity_data_loader.js';
import { makeShip } from './make_ship.js';
import { makeSystem } from './make_system.js';
import { ArmorComponent } from './health_plugin.js';
import { FormationComponent } from './npc_ai_plugin.js';
import { ShipDataComponent } from './ship_plugin.js';
import { applyControlEvents, ControlledByComponent } from './ship_control.js';
import { applySetTarget } from './target_plugin.js';
import { TargetComponent } from './target_component.js';

const PEER = 'test peer';

/**
 * A world with the player's ship, a hired escort following the player,
 * that escort's own bay fighter (following the escort — the transitive
 * flock case), and one enemy ship. Positions put the ESCORT nearest the
 * player, so nearest-target would pick it if it weren't excluded.
 */
async function makeTargetingWorld() {
    const gameData = new MockGameData();
    gameData.data.Ship.map.set('test:ship', {
        ...getDefaultShipData(), id: 'test:ship',
    });

    const world = await makeSystem('test:system', gameData);

    const at = (x: number) => ({
        accelerating: 0,
        position: new Position(x, 0),
        rotation: (makeShip(gameData.data.Ship.map.get('test:ship')!)
            .components.get(MovementStateComponent)!).rotation,
        turnBack: false,
        turning: 0,
        velocity: (makeShip(gameData.data.Ship.map.get('test:ship')!)
            .components.get(MovementStateComponent)!).velocity,
    });

    async function addShip(uuid: string, x: number,
        components: (entity: ReturnType<typeof makeShip>) => void) {
        const ship = makeShip(gameData.data.Ship.map.get('test:ship')!);
        ship.components.set(MovementStateComponent, at(x));
        components(ship);
        await completeEntity(world, ship);
        world.entities.set(uuid, ship);
    }

    await addShip('player', 0, ship => {
        ship.components.set(ControlledByComponent, { peerId: PEER });
    });
    await addShip('escort', 50, ship => {
        ship.components.set(FormationComponent, { leader: 'player', slot: 0 });
    });
    await addShip('fighter', 80, ship => {
        // The escort's own launched fighter: follows the ESCORT.
        ship.components.set(FormationComponent, { leader: 'escort', slot: 0 });
    });
    await addShip('enemy', 400, () => { });

    world.step();
    return world;
}

function press(world: World, action: string) {
    applyControlEvents(world, PEER,
        [{ action: action as never, state: 'start' }]);
    world.step();
    applyControlEvents(world, PEER,
        [{ action: action as never, state: false }]);
    world.step();
}

function playerTarget(world: World) {
    return world.entities.get('player')!
        .components.get(TargetComponent)?.target;
}

describe('escort targeting', () => {
    it('nearest-target (r) skips the whole flock and picks the enemy',
        async () => {
            const world = await makeTargetingWorld();
            press(world, 'nearestTarget');
            expect(playerTarget(world)).toBe('enemy');
        });

    it('target cycling (tab) never lands on flock members', async () => {
        const world = await makeTargetingWorld();
        const seen = new Set<string | undefined>();
        for (let i = 0; i < 8; i++) {
            press(world, 'nextTarget');
            seen.add(playerTarget(world));
        }
        expect(seen.has('escort')).toBeFalse();
        expect(seen.has('fighter')).toBeFalse();
        expect(seen.has('enemy')).toBeTrue();
    });

    it('the escort control cycles the flock in uuid order, including ' +
        "the escort's own fighter", async () => {
            const world = await makeTargetingWorld();
            press(world, 'escortTarget');
            expect(playerTarget(world)).toBe('escort');
            press(world, 'escortTarget');
            expect(playerTarget(world)).toBe('fighter');
            // A "no target" step closes the cycle before it wraps.
            press(world, 'escortTarget');
            expect(playerTarget(world)).toBeUndefined();
            press(world, 'escortTarget');
            expect(playerTarget(world)).toBe('escort');
        });

    it('the escort cycle passes through a no-target step every lap',
        async () => {
            const world = await makeTargetingWorld();
            const seen: (string | undefined)[] = [];
            for (let i = 0; i < 6; i++) {
                press(world, 'escortTarget');
                seen.push(playerTarget(world));
            }
            expect(seen).toEqual(['escort', 'fighter', undefined,
                'escort', 'fighter', undefined]);
        });

    it('a single escort alternates with the no-target step', async () => {
        const world = await makeTargetingWorld();
        world.entities.delete('fighter');
        world.step();
        press(world, 'escortTarget');
        expect(playerTarget(world)).toBe('escort');
        press(world, 'escortTarget');
        expect(playerTarget(world)).toBeUndefined();
        press(world, 'escortTarget');
        expect(playerTarget(world)).toBe('escort');
    });

    it('entering the escort cycle from a normal target picks the first ' +
        'escort rather than clearing', async () => {
            // A non-flock target reads as "not in the cycle", so the
            // first press must enter the flock, not land on no-target.
            const world = await makeTargetingWorld();
            applySetTarget(world, PEER, 'enemy');
            expect(playerTarget(world)).toBe('enemy');
            press(world, 'escortTarget');
            expect(playerTarget(world)).toBe('escort');
        });

    it('the escort control does nothing with no escorts', async () => {
        const world = await makeTargetingWorld();
        world.entities.delete('escort');
        world.entities.delete('fighter');
        world.step();
        press(world, 'escortTarget');
        expect(playerTarget(world)).toBeUndefined();
    });

    it('an explicit click DOES target a flock member', async () => {
        const world = await makeTargetingWorld();
        applySetTarget(world, PEER, 'escort');
        expect(playerTarget(world)).toBe('escort');
        applySetTarget(world, PEER, 'fighter');
        expect(playerTarget(world)).toBe('fighter');
    });

    it('clicking empty space still clears the target', async () => {
        const world = await makeTargetingWorld();
        applySetTarget(world, PEER, 'enemy');
        expect(playerTarget(world)).toBe('enemy');
        applySetTarget(world, PEER, null);
        expect(playerTarget(world)).toBeUndefined();
    });
});

describe('a DISABLED flock member rejoins the normal cycle', () => {
    function disable(world: World, uuid: string) {
        // Drop armor below the disable threshold; ShipDisableSystem then
        // attaches DisabledComponent on the next step (armor stays > 0 so
        // the ship isn't destroyed).
        const entity = world.entities.get(uuid)!;
        const armor = entity.components.get(ArmorComponent)!;
        const fraction = entity.components
            .get(ShipDataComponent)!.disableArmorFraction;
        armor.current = Math.max(1, fraction * armor.max * 0.5);
        world.step();
        if (!entity.components.has(DisabledComponent)) {
            throw new Error(`${uuid} did not become disabled`);
        }
    }

    it('nearest-target (r) picks the disabled escort over the enemy',
        async () => {
            // The escort sits at x=50 (nearer than the enemy at x=400);
            // disabled, it is no longer skipped, so it wins on distance.
            const world = await makeTargetingWorld();
            disable(world, 'escort');
            press(world, 'nearestTarget');
            expect(playerTarget(world)).toBe('escort');
        });

    it('tab cycling now lands on the disabled escort', async () => {
        const world = await makeTargetingWorld();
        disable(world, 'escort');
        const seen = new Set<string | undefined>();
        for (let i = 0; i < 8; i++) {
            press(world, 'nextTarget');
            seen.add(playerTarget(world));
        }
        expect(seen.has('escort')).toBeTrue();
        // The still-healthy fighter stays excluded from the normal cycle.
        expect(seen.has('fighter')).toBeFalse();
        expect(seen.has('enemy')).toBeTrue();
    });

    it('a healthy escort is still excluded from tab cycling', async () => {
        // Regression guard: only the disabled exception opens the cycle.
        const world = await makeTargetingWorld();
        const seen = new Set<string | undefined>();
        for (let i = 0; i < 8; i++) {
            press(world, 'nextTarget');
            seen.add(playerTarget(world));
        }
        expect(seen.has('escort')).toBeFalse();
    });

    it('the disabled escort stays in the option+tab escort cycle too',
        async () => {
            const world = await makeTargetingWorld();
            disable(world, 'escort');
            press(world, 'escortTarget');
            expect(playerTarget(world)).toBe('escort');
            press(world, 'escortTarget');
            expect(playerTarget(world)).toBe('fighter');
        });
});

describe('exploding ships are untargetable', () => {
    function markExploding(world: World, uuid: string) {
        world.entities.get(uuid)!.components.set(ExplodingComponent, 1e12);
    }

    it('anyone targeting a ship loses the lock the moment it starts ' +
        'exploding', async () => {
            const world = await makeTargetingWorld();
            press(world, 'nearestTarget');
            expect(playerTarget(world)).toBe('enemy');
            markExploding(world, 'enemy');
            world.step();
            expect(playerTarget(world)).toBeUndefined();
        });

    it('nearest-target (r) skips exploding ships', async () => {
        const world = await makeTargetingWorld();
        markExploding(world, 'enemy');
        world.step();
        press(world, 'nearestTarget');
        expect(playerTarget(world)).toBeUndefined();
    });

    it('tab cycling never lands on an exploding ship', async () => {
        const world = await makeTargetingWorld();
        markExploding(world, 'enemy');
        world.step();
        const seen = new Set<string | undefined>();
        for (let i = 0; i < 6; i++) {
            press(world, 'nextTarget');
            seen.add(playerTarget(world));
        }
        expect(seen.has('enemy')).toBeFalse();
    });

    it('clicking an exploding ship is rejected', async () => {
        const world = await makeTargetingWorld();
        markExploding(world, 'enemy');
        world.step();
        applySetTarget(world, PEER, 'enemy');
        expect(playerTarget(world)).toBeUndefined();
    });

    it('the escort-cycle control skips an exploding flock member',
        async () => {
            const world = await makeTargetingWorld();
            markExploding(world, 'escort');
            world.step();
            press(world, 'escortTarget');
            expect(playerTarget(world)).toBe('fighter');
            // Only the fighter is left in the cycle, so it alternates
            // with the no-target step.
            press(world, 'escortTarget');
            expect(playerTarget(world)).toBeUndefined();
            press(world, 'escortTarget');
            expect(playerTarget(world)).toBe('fighter');
        });
});
