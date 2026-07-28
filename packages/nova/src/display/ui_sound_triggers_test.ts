import "jasmine";
import { getDefaultGovtData } from "novadatainterface/govt_data";
import { Position } from "nova_ecs/datatypes/position";
import { Entity } from "nova_ecs/entity";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { TimeResource } from "nova_ecs/plugins/time_plugin";
import { World } from "nova_ecs/world";
import { Subject } from "rxjs";
import { ControlEvent, ControlsSubject } from "../nova_plugin/controls_plugin.js";
import { DisplayAssetDataInterface } from "../client/gamedata/display_asset_data.js";
import { SimulationGameDataInterface } from "../client/gamedata/simulation_game_data.js";
import { DisabledComponent } from "../nova_plugin/disabled_component.js";
import { DeathEvent, ZeroArmorEvent } from "../nova_plugin/death_plugin.js";
import { DisplayAssetDataResource, SimulationGameDataResource } from "../nova_plugin/game_data_resource.js";
import { FuelComponent } from "../nova_plugin/health_plugin.js";
import { JumpRouteComponent } from "../nova_plugin/jump_plugin.js";
import { PlanetTargetComponent } from "../nova_plugin/planet_plugin.js";
import { PlayerShipSelector } from "../nova_plugin/player_ship_plugin.js";
import { GovtComponent } from "../nova_plugin/govt_component.js";
import { ShipComponent, ShipPhysicsComponent } from "../nova_plugin/ship_plugin.js";
import { TargetComponent } from "../nova_plugin/target_component.js";
import { WeaponsStateComponent } from "../nova_plugin/weapons_state.js";
import { ExplosionPlugin } from "./explosion_plugin.js";
import { SoundPlugin } from "./sound_plugin.js";
import { UiSoundTriggersPlugin } from "./ui_sound_triggers_plugin.js";

const PLAYER = 'player';

// A spy audio layer: one memoized fake Sound per id records play()/stop().
function makeSpyAssets(played: string[], stopped: string[]) {
    const cache = new Map<string, unknown>();
    const Sound = {
        getCached(id: string) {
            if (!cache.has(id)) {
                cache.set(id, {
                    volume: 0,
                    play() { played.push(id); },
                    stop() { stopped.push(id); },
                });
            }
            return cache.get(id);
        },
        get(id: string) { return Promise.resolve(Sound.getCached(id)); },
    };
    return { data: { Sound } } as unknown as DisplayAssetDataInterface;
}

// A minimal game-data stub whose only hostile govt always attacks the player.
function makeGameData() {
    const hostileGovt = {
        ...getDefaultGovtData(),
        id: 'nova:hostile',
        flags: { ...getDefaultGovtData().flags, alwaysAttacksPlayer: true },
    };
    return {
        data: {
            Govt: { getCached: (_id: string) => hostileGovt },
        },
    } as unknown as SimulationGameDataInterface;
}

async function makeWorld() {
    const world = new World('ui sound triggers test');
    const played: string[] = [];
    const stopped: string[] = [];
    const controls = new Subject<ControlEvent>();
    world.resources.set(DisplayAssetDataResource, makeSpyAssets(played, stopped));
    world.resources.set(SimulationGameDataResource, makeGameData());
    world.resources.set(ControlsSubject, controls);
    world.resources.set(TimeResource,
        { time: 0, delta_ms: 0, delta_s: 0 } as never);
    await world.addPlugin(SoundPlugin);
    await world.addPlugin(ExplosionPlugin);
    await world.addPlugin(UiSoundTriggersPlugin);

    const player = new Entity('player');
    player.components.set(PlayerShipSelector, undefined);
    player.components.set(TargetComponent, { target: undefined });
    player.components.set(PlanetTargetComponent, { target: undefined });
    world.entities.set(PLAYER, player);
    // Clear the pre-warm plays so assertions see only trigger-driven audio.
    world.step();
    played.length = 0;
    stopped.length = 0;
    return { world, played, stopped, controls, player };
}

describe('UI sound triggers (audio-layer spy)', () => {
    it('beeps 152 when a ship is targeted, once per change', async () => {
        const { world, played, player } = await makeWorld();
        player.components.set(TargetComponent, { target: 'ship-1' });
        world.step();
        expect(played).toContain('nova:152');

        // No re-beep while the target is unchanged.
        played.length = 0;
        world.step();
        expect(played).not.toContain('nova:152');

        // Retargeting beeps again.
        player.components.set(TargetComponent, { target: 'ship-2' });
        world.step();
        expect(played).toContain('nova:152');
    });

    it('beeps 150 when a planet is targeted', async () => {
        const { world, played, player } = await makeWorld();
        player.components.set(PlanetTargetComponent, { target: 'planet nova:128' });
        world.step();
        expect(played).toContain('nova:150');
    });

    it('beeps 151 the moment your own ship becomes disabled', async () => {
        const { world, played, player } = await makeWorld();
        world.step();
        expect(played).not.toContain('nova:151');
        player.components.set(DisabledComponent, { repairAt: null });
        world.step();
        expect(played).toContain('nova:151');
        // Edge, not level: no repeat while it stays disabled.
        played.length = 0;
        world.step();
        expect(played).not.toContain('nova:151');
    });

    it('beeps 154 when a jump becomes possible', async () => {
        const { world, played, player } = await makeWorld();
        player.components.set(MovementStateComponent,
            { position: new Position(1200, 0) } as never);
        player.components.set(ShipPhysicsComponent,
            { jumpDistanceMod: 0 } as never);
        player.components.set(FuelComponent, { current: 100, max: 100 } as never);
        // No route yet: not eligible.
        player.components.set(JumpRouteComponent, { route: [] });
        world.step();
        expect(played).not.toContain('nova:154');
        // Route selected while already far enough out: eligibility flips true.
        player.components.set(JumpRouteComponent, { route: ['nova:129'] });
        world.step();
        expect(played).toContain('nova:154');
    });

    it('plays 370 on the first hostile ship, then stays quiet', async () => {
        const { world, played } = await makeWorld();
        world.step();
        expect(played).not.toContain('nova:370');

        const enemy = new Entity('enemy');
        enemy.components.set(ShipComponent, {} as never);
        enemy.components.set(GovtComponent, { id: 'nova:hostile' });
        world.entities.set('enemy-1', enemy);
        world.step();
        expect(played).toContain('nova:370');

        // A second hostile arriving does not re-fire (already non-empty).
        played.length = 0;
        const enemy2 = new Entity('enemy2');
        enemy2.components.set(ShipComponent, {} as never);
        enemy2.components.set(GovtComponent, { id: 'nova:hostile' });
        world.entities.set('enemy-2', enemy2);
        world.step();
        expect(played).not.toContain('nova:370');
    });

    it('loops 371 while your ship explodes and stops it on death', async () => {
        const { world, played, stopped } = await makeWorld();
        world.emit(ZeroArmorEvent, { time: 0, delta_ms: 0, delta_s: 0 } as never,
            [PLAYER]);
        world.step();
        expect(played).toContain('nova:371');

        world.emit(DeathEvent, { time: 0, delta_ms: 0, delta_s: 0 } as never,
            [PLAYER]);
        world.step();
        expect(stopped).toContain('nova:371');
    });

    it('beeps 153 when switching secondaries with none available', async () => {
        const { world, played, controls, player } = await makeWorld();
        player.components.set(WeaponsStateComponent, new Map());
        world.step();
        controls.next({ action: 'nextSecondary', state: 'start' });
        world.step();
        expect(played).toContain('nova:153');
    });

    it('does NOT beep 153 when a secondary weapon is available', async () => {
        const { world, played, controls, player } = await makeWorld();
        player.components.set(WeaponsStateComponent, new Map([
            ['nova:w', { fireGroup: 'secondary' } as never],
        ]));
        world.step();
        controls.next({ action: 'nextSecondary', state: 'start' });
        world.step();
        expect(played).not.toContain('nova:153');
    });
});
