import 'jasmine';
import { getDefaultGovtData, GovtData } from 'novadatainterface/govt_data';
import { Entity } from 'nova_ecs/entity';
import { DisabledComponent } from '../nova_plugin/disabled_component.js';
import { GovtComponent } from '../nova_plugin/govt_component.js';
import { FormationComponent, NpcComponent } from '../nova_plugin/npc_ai_plugin.js';
import { ShootAllWeaponsComponent } from '../nova_plugin/npc_plugin.js';
import { TargetComponent } from '../nova_plugin/target_component.js';
import { styleForTarget } from './target_corners_plugin.js';

const PLAYER = 'player uuid';

/** A gameData stub exposing only the Govt.getCached the rule reads. */
function mockGameData(govts: { [id: string]: GovtData | undefined }) {
    return {
        data: {
            Govt: {
                getCached: (id: string) => govts[id],
            },
        },
    } as never;
}

function govt(over: Partial<GovtData>): GovtData {
    return { ...getDefaultGovtData(), ...over };
}

describe('styleForTarget (target corner selection)', () => {
    const pirates = govt({ id: 'nova:137' });
    pirates.flags.xenophobic = true;
    const civilians = govt({ id: 'nova:157' });
    const gameData = mockGameData({
        'nova:137': pirates,
        'nova:157': civilians,
    });
    const player = new Entity('player');

    /** Runs the rule for `entities[uuid]` with the rest as the world. */
    function style(uuid: string, entities: { [uuid: string]: Entity },
        playerEntity = player) {
        return styleForTarget(uuid, entities[uuid], PLAYER, playerEntity,
            gameData, u => entities[u]);
    }

    it('shows neutral corners for a trader going about its business', () => {
        const trader = new Entity('trader')
            .addComponent(GovtComponent, { id: 'nova:157' })
            .addComponent(NpcComponent, { aiType: 1, mode: 'travel' });
        expect(style('trader', { trader })).toBe('neutral');
    });

    it('shows hostile corners for a pirate (xenophobic govt), even when ' +
        'it is busy attacking someone else', () => {
            const pirate = new Entity('pirate')
                .addComponent(GovtComponent, { id: 'nova:137' })
                .addComponent(NpcComponent, { aiType: 3, mode: 'attack' })
                .addComponent(TargetComponent, { target: 'someone else' });
            expect(style('pirate', { pirate })).toBe('hostile');
        });

    it('shows hostile corners for a neutral-govt ship currently attacking ' +
        'the player (brave trader fighting back)', () => {
            const trader = new Entity('brave trader')
                .addComponent(GovtComponent, { id: 'nova:157' })
                .addComponent(NpcComponent, { aiType: 2, mode: 'attack' })
                .addComponent(TargetComponent, { target: PLAYER });
            expect(style('trader', { trader })).toBe('hostile');
        });

    it('keeps neutral corners for a ship merely fleeing the player', () => {
        const trader = new Entity('wimpy trader')
            .addComponent(GovtComponent, { id: 'nova:157' })
            .addComponent(NpcComponent, {
                aiType: 1, mode: 'flee', aggressor: PLAYER,
            })
            .addComponent(TargetComponent, { target: PLAYER });
        expect(style('trader', { trader })).toBe('neutral');
    });

    it('keeps neutral corners for an attacker whose target is not the ' +
        'player', () => {
            const warship = new Entity('warship')
                .addComponent(GovtComponent, { id: 'nova:157' })
                .addComponent(NpcComponent, { aiType: 3, mode: 'attack' })
                .addComponent(TargetComponent, { target: 'someone else' });
            expect(style('warship', { warship })).toBe('neutral');
        });

    it('shows hostile corners for a legacy dev enemy (ShootAllWeapons) ' +
        'targeting the player', () => {
            const enemy = new Entity('dev enemy')
                .addComponent(ShootAllWeaponsComponent, undefined)
                .addComponent(TargetComponent, { target: PLAYER });
            expect(style('enemy', { enemy })).toBe('hostile');
        });

    it('shows friendly corners for a ship sharing the player government',
        () => {
            const playerWithGovt = new Entity('player')
                .addComponent(GovtComponent, { id: 'nova:157' });
            const wingman = new Entity('wingman')
                .addComponent(GovtComponent, { id: 'nova:157' })
                .addComponent(NpcComponent, { aiType: 3, mode: 'patrol' });
            expect(style('wingman', { wingman }, playerWithGovt))
                .toBe('friendly');
        });

    it('shows neutral corners while govt data is not yet cached', () => {
        const unknown = new Entity('unknown')
            .addComponent(GovtComponent, { id: 'nova:999' });
        expect(style('unknown', { unknown })).toBe('neutral');
    });

    it("shows friendly corners for the player's own hired escort, " +
        'whatever its government', () => {
            const escort = new Entity('escort')
                .addComponent(GovtComponent, { id: 'nova:137' }) // pirate!
                .addComponent(FormationComponent,
                    { leader: PLAYER, slot: 0 });
            expect(style('escort', { escort })).toBe('friendly');
        });

    it("shows friendly corners for an escort's own bay fighter " +
        '(transitive flock)', () => {
            const escort = new Entity('escort')
                .addComponent(FormationComponent,
                    { leader: PLAYER, slot: 0 });
            const fighter = new Entity('fighter')
                .addComponent(FormationComponent,
                    { leader: 'escort', slot: 0 });
            expect(style('fighter', { escort, fighter })).toBe('friendly');
        });

    it('shows the gray disabled corners regardless of politics', () => {
        // A pirate actively attacking the player... but disabled: gray.
        const pirate = new Entity('pirate')
            .addComponent(GovtComponent, { id: 'nova:137' })
            .addComponent(NpcComponent, { aiType: 3, mode: 'attack' })
            .addComponent(TargetComponent, { target: PLAYER })
            .addComponent(DisabledComponent, { repairAt: null });
        expect(style('pirate', { pirate })).toBe('disabled');
    });

    it('shows disabled corners even for own-flock ships', () => {
        const escort = new Entity('escort')
            .addComponent(FormationComponent, { leader: PLAYER, slot: 0 })
            .addComponent(DisabledComponent, { repairAt: null });
        expect(style('escort', { escort })).toBe('disabled');
    });

    it("an NPC fleet escort (someone else's flock) is not friendly", () => {
        const npcLeader = new Entity('npc leader')
            .addComponent(GovtComponent, { id: 'nova:137' });
        const npcEscort = new Entity('npc escort')
            .addComponent(GovtComponent, { id: 'nova:137' })
            .addComponent(FormationComponent,
                { leader: 'npc leader', slot: 0 });
        expect(style('npc escort',
            { 'npc leader': npcLeader, 'npc escort': npcEscort }))
            .toBe('hostile');
    });
});
