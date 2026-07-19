import 'jasmine';
import { getDefaultGovtData, GovtData } from 'novadatainterface/govt_data';
import { Entity } from 'nova_ecs/entity';
import { GovtComponent } from '../nova_plugin/govt_component.js';
import { NpcComponent } from '../nova_plugin/npc_ai_plugin.js';
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

    it('shows neutral corners for a trader going about its business', () => {
        const trader = new Entity('trader')
            .addComponent(GovtComponent, { id: 'nova:157' })
            .addComponent(NpcComponent, { aiType: 1, mode: 'travel' });
        expect(styleForTarget(trader, PLAYER, player, gameData))
            .toBe('neutral');
    });

    it('shows hostile corners for a pirate (xenophobic govt), even when ' +
        'it is busy attacking someone else', () => {
            const pirate = new Entity('pirate')
                .addComponent(GovtComponent, { id: 'nova:137' })
                .addComponent(NpcComponent, { aiType: 3, mode: 'attack' })
                .addComponent(TargetComponent, { target: 'someone else' });
            expect(styleForTarget(pirate, PLAYER, player, gameData))
                .toBe('hostile');
        });

    it('shows hostile corners for a neutral-govt ship currently attacking ' +
        'the player (brave trader fighting back)', () => {
            const trader = new Entity('brave trader')
                .addComponent(GovtComponent, { id: 'nova:157' })
                .addComponent(NpcComponent, { aiType: 2, mode: 'attack' })
                .addComponent(TargetComponent, { target: PLAYER });
            expect(styleForTarget(trader, PLAYER, player, gameData))
                .toBe('hostile');
        });

    it('keeps neutral corners for a ship merely fleeing the player', () => {
        const trader = new Entity('wimpy trader')
            .addComponent(GovtComponent, { id: 'nova:157' })
            .addComponent(NpcComponent, {
                aiType: 1, mode: 'flee', aggressor: PLAYER,
            })
            .addComponent(TargetComponent, { target: PLAYER });
        expect(styleForTarget(trader, PLAYER, player, gameData))
            .toBe('neutral');
    });

    it('keeps neutral corners for an attacker whose target is not the ' +
        'player', () => {
            const warship = new Entity('warship')
                .addComponent(GovtComponent, { id: 'nova:157' })
                .addComponent(NpcComponent, { aiType: 3, mode: 'attack' })
                .addComponent(TargetComponent, { target: 'someone else' });
            expect(styleForTarget(warship, PLAYER, player, gameData))
                .toBe('neutral');
        });

    it('shows hostile corners for a legacy dev enemy (ShootAllWeapons) ' +
        'targeting the player', () => {
            const enemy = new Entity('dev enemy')
                .addComponent(ShootAllWeaponsComponent, undefined)
                .addComponent(TargetComponent, { target: PLAYER });
            expect(styleForTarget(enemy, PLAYER, player, gameData))
                .toBe('hostile');
        });

    it('shows friendly corners for a ship sharing the player government',
        () => {
            const playerWithGovt = new Entity('player')
                .addComponent(GovtComponent, { id: 'nova:157' });
            const wingman = new Entity('wingman')
                .addComponent(GovtComponent, { id: 'nova:157' })
                .addComponent(NpcComponent, { aiType: 3, mode: 'patrol' });
            expect(styleForTarget(wingman, PLAYER, playerWithGovt, gameData))
                .toBe('friendly');
        });

    it('shows neutral corners while govt data is not yet cached', () => {
        const unknown = new Entity('unknown')
            .addComponent(GovtComponent, { id: 'nova:999' });
        expect(styleForTarget(unknown, PLAYER, player, gameData))
            .toBe('neutral');
    });
});
