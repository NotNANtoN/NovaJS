import 'jasmine';
import { getDefaultGovtData, GovtData } from 'novadatainterface/GovtData';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { PlunderEvent } from './boarding_plugin';
import { ShipDisabledEvent } from './disabled_plugin';
import {
    GovernmentRelationResource,
    GovernmentRelationStore,
} from './govt_relations';
import {
    LegalLedger,
    LegalLedgerResource,
    LegalRecordPlugin,
    PlayerCrimeBoardingSystem,
    PlayerCrimeDisableSystem,
} from './legal_record_plugin';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { GovtComponent } from './npc_components';
import { PlatformResource } from './platform_plugin';
import {
    createInitialPlayerState,
    PlayerStateComponent,
} from './player_state';
import { ShipComponent } from './ship_plugin';

function government(flags = 0): GovtData {
    return {
        ...getDefaultGovtData(),
        id: 'nova:128',
        name: 'Federation',
        flags,
        penalties: {
            smuggling: 0,
            disabling: 10,
            boarding: 15,
            killing: 30,
            shooting: 5,
        },
    };
}

function makeWorld(govt: GovtData) {
    const world = new World('legal-record-events');
    const ledger = new LegalLedger();
    ledger.governments.set(govt.id, govt);
    world.resources.set(LegalLedgerResource, ledger);
    world.resources.set(PlatformResource, 'node');
    world.resources.set(GovernmentRelationResource, {
        getCached: () => govt,
    } as unknown as GovernmentRelationStore);
    world.addSystem(PlayerCrimeDisableSystem);
    world.addSystem(PlayerCrimeBoardingSystem);

    const player = new Entity('player')
        .addComponent(ShipComponent, { id: 'nova:200' })
        .addComponent(PlayerStateComponent, createInitialPlayerState());
    const victim = new Entity('victim')
        .addComponent(GovtComponent, { id: 128 });
    world.entities.set('player', player);
    world.entities.set('victim', victim);
    return { world, player };
}

describe('legal record crime events', () => {
    it('charges DisabPenalty when player damage disables a ship', () => {
        const { world, player } = makeWorld(government());

        world.emitNow(ShipDisabledEvent, { damager: 'player' }, ['victim']);

        expect(player.components.get(PlayerStateComponent)!
            .legalRecords?.['nova:128']).toBe(-10);
    });

    it('charges BoardPenalty when the player plunders a ship', () => {
        const { world, player } = makeWorld(government());

        world.emitNow(PlunderEvent, { boarder: 'player' }, ['victim']);

        expect(player.components.get(PlayerStateComponent)!
            .legalRecords?.['nova:128']).toBe(-15);
    });

    it('does not charge disabling or boarding against derelicts', () => {
        const { world, player } = makeWorld(government(0x0800));

        world.emitNow(ShipDisabledEvent, { damager: 'player' }, ['victim']);
        world.emitNow(PlunderEvent, { boarder: 'player' }, ['victim']);

        expect(player.components.get(PlayerStateComponent)!
            .legalRecords?.['nova:128']).toBeUndefined();
    });
});

describe('tearing the legal record plugin down', () => {
    it('releases the government relations it claimed', async () => {
        const { world } = makeWorld(government());
        world.resources.set(TimeResource, { time: 0, delta_ms: 0, delta_s: 0 });
        await world.addPlugin(LegalRecordPlugin);

        // Reproduces the server crash: NpcPlugin drops these on teardown, and
        // the world refuses while a crime system still names them.
        expect(() => world.resources.delete(GovernmentRelationResource))
            .toThrow();

        await world.removePlugin(LegalRecordPlugin);
        expect(() => world.resources.delete(GovernmentRelationResource))
            .not.toThrow();
    });
});
