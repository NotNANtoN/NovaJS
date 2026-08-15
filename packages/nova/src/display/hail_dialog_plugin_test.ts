import 'jasmine';
import { getDefaultPersData } from 'novadatainterface/pers_data';
import { getDefaultShipData } from 'novadatainterface/ship_data';
import { MockGameData } from 'novadatainterface/mock_game_data';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { OwnerComponent, SourceComponent } from '../nova_plugin/fire_weapon_plugin.js';
import { GovtComponent } from '../nova_plugin/govt_component.js';
import { FormationComponent, NpcComponent } from '../nova_plugin/npc_ai_plugin.js';
import { PersComponent } from '../nova_plugin/pers_plugin.js';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin.js';
import { ShipDataComponent } from '../nova_plugin/ship_plugin.js';
import { TargetComponent } from '../nova_plugin/target_component.js';
import { DisplayAssetDataInterface } from '../client/gamedata/display_asset_data.js';
import { DisabledComponent } from '../nova_plugin/disabled_component.js';
import {
    BUSY_RESPONSE_FALLBACK, BUSY_RESPONSE_FIRST_INDEX, HAIL_RESPONSE_TABLE,
} from '../nova_plugin/hail.js';
import { ShootAllWeaponsComponent } from '../nova_plugin/npc_plugin.js';
import {
    assistRefusal, computeContext, targetIsFighting,
} from './hail_dialog_plugin.js';

const PLAYER = 'player-uuid';
const TARGET = 'target-uuid';

function shipData(overrides: Partial<ReturnType<typeof getDefaultShipData>> = {}) {
    return { ...getDefaultShipData(), ...overrides };
}

/**
 * A minimal world with a player ship targeting one other ship, plus a
 * MockGameData carrying the target's govt / pers / ship records. computeContext
 * only reads world.entities and the game data, so no systems are needed.
 */
function makeWorld(configureTarget: (target: Entity) => void) {
    const gameData = new MockGameData();
    // A ship record the target can resolve (its class name / pict).
    gameData.data.Ship.map.set('nova:128', shipData({
        id: 'nova:128', name: 'Target Class', pict: 'nova:3001',
    }));

    const world = new World();
    world.entities.set(PLAYER, new Entity()
        .addComponent(PlayerShipSelector, undefined)
        .addComponent(TargetComponent, { target: TARGET }));

    const target = new Entity()
        .addComponent(ShipDataComponent, gameData.data.Ship.map.get('nova:128')!);
    configureTarget(target);
    world.entities.set(TARGET, target);
    return { world, gameData };
}

describe('computeContext: target image (pers hailPict is not re-prefixed)',
    () => {
        it('uses a pers hailPict verbatim (already a global id)', async () => {
            const pers = getDefaultPersData();
            pers.id = 'nova:131';
            // The parser emits hailPict already prefixed.
            pers.hailPict = 'nova:4001';
            const { world, gameData } = makeWorld(target => {
                target.components.set(PersComponent,
                    { id: 'nova:131', name: 'Captain Nemo', subtitle: '' });
            });
            gameData.data.Pers.map.set('nova:131', pers);

            const result = await computeContext(world, gameData);
            expect(result?.context.image).toBe('nova:4001');
        });

        it('falls back to the ship pict when the pers has no hailPict',
            async () => {
                const pers = getDefaultPersData();
                pers.id = 'nova:131';
                pers.hailPict = null;
                const { world, gameData } = makeWorld(target => {
                    target.components.set(PersComponent,
                        { id: 'nova:131', name: 'Captain Nemo', subtitle: '' });
                });
                gameData.data.Pers.map.set('nova:131', pers);

                const result = await computeContext(world, gameData);
                expect(result?.context.image).toBe('nova:3001');
            });
    });

describe('computeContext: bay fighters vs hired escorts (SourceComponent)',
    () => {
        it('labels a hired escort (no SourceComponent) "Hired Escort:"',
            async () => {
                const { world, gameData } = makeWorld(target => {
                    target.components.set(FormationComponent,
                        { leader: PLAYER, slot: 0 });
                });
                const result = await computeContext(world, gameData);
                expect(result?.context.variant).toBe('escort');
                expect(result?.context.heading).toBe('Hired Escort:');
                expect(result?.isEscort).toBeTrue();
            });

        it('labels a carrier-bay fighter (has SourceComponent) "Fighter:", ' +
            'not "Hired Escort:", with no management buttons', async () => {
                const { world, gameData } = makeWorld(target => {
                    // Bay fighters carry BOTH formation/owner links to the
                    // player AND a SourceComponent (the launching carrier).
                    target.components.set(FormationComponent,
                        { leader: PLAYER, slot: 0 });
                    target.components.set(OwnerComponent, { owner: PLAYER });
                    target.components.set(SourceComponent, PLAYER);
                });
                const result = await computeContext(world, gameData);
                expect(result?.context.heading).toBe('Fighter:');
                expect(result?.isEscort).toBeFalse();
                // No escort-management seam buttons for a bay fighter.
                expect(result?.context.escort).toBeFalsy();
            });
    });

describe('computeContext: behavioral hostility (attacking neutral)', () => {
    it('a neutral ship attacking the player greets with hostility', async () => {
        const govt = { id: 'test:neutral' };
        const { world, gameData } = makeWorld(target => {
            target.components.set(GovtComponent, govt);
            target.components.set(NpcComponent,
                { aiType: 3, mode: 'attack' });
            target.components.set(TargetComponent, { target: PLAYER });
        });
        // A plain neutral govt (no hostility, no bribe flags).
        gameData.data.Govt.map.set('test:neutral',
            { ...gameData.data.Govt.defaultValue!, id: 'test:neutral' });

        const result = await computeContext(world, gameData);
        // Behavioral hostility → the hostile body line, and NO assistance offer.
        expect(result?.context.assist).toBeUndefined();
        expect(result?.context.body).toContain('hostility');
    });
});

/**
 * The "I'm busy" refusal. The OFFER is still made to a fighting ship — the
 * player asks and is told no, as the original's comm dialog answers with a
 * line from the response table — so the decision happens on the press, which
 * is what assistRefusal answers.
 */
describe('hail assistance refusal (busy ships)', () => {
    /** A display-asset stub carrying the stock busy group of STR# 3000. */
    function fakeDisplayAssets(): DisplayAssetDataInterface {
        const strings: string[] = [];
        strings[BUSY_RESPONSE_FIRST_INDEX] = "I'm busy.";
        strings[BUSY_RESPONSE_FIRST_INDEX + 1] = "I'm a little busy right now.";
        strings[BUSY_RESPONSE_FIRST_INDEX + 2] = "I'm too busy to help you.";
        strings[BUSY_RESPONSE_FIRST_INDEX + 3] = 'I have other business.';
        strings[BUSY_RESPONSE_FIRST_INDEX + 4] = "I've got other things to do.";
        return {
            data: {
                StringTable: {
                    get: async (id: string) => id === HAIL_RESPONSE_TABLE
                        ? { strings } : { strings: [] },
                },
            },
        } as unknown as DisplayAssetDataInterface;
    }

    /** A world whose player needs help (disabled) so an offer is made. */
    function needyWorld(configureTarget: (target: Entity) => void) {
        const built = makeWorld(configureTarget);
        built.world.entities.get(PLAYER)!.components
            .set(DisabledComponent, { repairAt: null });
        return built;
    }

    it('reads the target\'s combat state the same way the sim does', () => {
        const fighting = new Entity()
            .addComponent(NpcComponent, { aiType: 3, mode: 'attack' } as never)
            .addComponent(TargetComponent, { target: 'someone else' });
        expect(targetIsFighting(fighting)).toBeTrue();

        const idle = new Entity()
            .addComponent(NpcComponent, { aiType: 3 } as never)
            .addComponent(TargetComponent, { target: undefined });
        expect(targetIsFighting(idle)).toBeFalse();

        const devEnemy = new Entity()
            .addComponent(ShootAllWeaponsComponent, undefined);
        expect(targetIsFighting(devEnemy)).toBeTrue();
    });

    it('still OFFERS assistance to a ship that is busy fighting', async () => {
        const { world, gameData } = needyWorld(target => {
            target.components.set(NpcComponent,
                { aiType: 3, mode: 'attack' });
            target.components.set(TargetComponent, { target: 'someone else' });
        });
        const result = await computeContext(world, gameData);
        // The button is there; pressing it is what gets the refusal.
        expect(result?.context.assist).toBeDefined();
    });

    it('answers a press with a busy line from STR# 3000, and dispatches '
        + 'nothing', async () => {
            const { world, gameData } = needyWorld(target => {
                target.components.set(NpcComponent,
                    { aiType: 3, mode: 'attack' });
                target.components.set(TargetComponent,
                    { target: 'someone else' });
            });
            const result = await computeContext(world, gameData,
                fakeDisplayAssets());
            expect(result?.busyText).toContain('busy');

            const refusal = assistRefusal(world, TARGET, result!.busyText);
            expect(refusal).toBe(result!.busyText);
        });

    it('lets the press through for a ship that is not fighting', async () => {
        const { world, gameData } = needyWorld(target => {
            target.components.set(NpcComponent, { aiType: 3 });
            target.components.set(TargetComponent, { target: undefined });
        });
        const result = await computeContext(world, gameData,
            fakeDisplayAssets());
        expect(assistRefusal(world, TARGET, result!.busyText)).toBeUndefined();
    });

    it('lets the press through once the fight ends', async () => {
        const { world, gameData } = needyWorld(target => {
            target.components.set(NpcComponent,
                { aiType: 3, mode: 'attack' });
            target.components.set(TargetComponent, { target: 'someone else' });
        });
        const result = await computeContext(world, gameData,
            fakeDisplayAssets());
        expect(assistRefusal(world, TARGET, result!.busyText)).toBeDefined();

        // The fight ends while the channel is open: the SAME open dialog now
        // gets the request through, because the press is what decides.
        const target = world.entities.get(TARGET)!;
        target.components.get(NpcComponent)!.mode = undefined;
        target.components.get(TargetComponent)!.target = undefined;
        expect(assistRefusal(world, TARGET, result!.busyText)).toBeUndefined();
    });

    it('falls back to the pinned literal with no display assets', async () => {
        const { world, gameData } = needyWorld(target => {
            target.components.set(NpcComponent, { aiType: 3 });
        });
        const result = await computeContext(world, gameData);
        expect(result?.busyText).toBe(BUSY_RESPONSE_FALLBACK);
    });
});
