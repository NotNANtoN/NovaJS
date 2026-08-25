import 'jasmine';
import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { GameDataResource } from './game_data_resource';
import { PlatformResource } from './platform_plugin';
import {
    ShootAllWeaponsAI,
    ShootAllWeaponsComponent,
} from './npc_plugin';
import { TargetComponent } from './target_component';
import { WeaponsStateComponent } from './weapons_state';
import { DestructionStartedComponent } from './destruction_state';

describe('NPC destruction lockout', () => {
    it('clears NPC firing instead of restarting it after death begins', () => {
        const world = new World('npc-destruction-lock-test');
        world.resources.set(PlatformResource, 'node');
        world.resources.set(GameDataResource, {
            data: {
                Weapon: {
                    getCached: () => ({ type: 'ProjectileWeaponData' }),
                },
            },
        } as never);
        world.addSystem(ShootAllWeaponsAI);

        const weapon = { count: 1, firing: true, target: 'player' };
        world.entities.set('player', new Entity('player'));
        world.entities.set('npc', new Entity('npc')
            .addComponent(WeaponsStateComponent, new Map([
                ['weapon', weapon],
            ]))
            .addComponent(TargetComponent, { target: 'player' })
            .addComponent(ShootAllWeaponsComponent, undefined)
            .addComponent(MultiplayerData, { owner: 'server' })
            .addComponent(DestructionStartedComponent, true));

        world.step();

        expect(weapon.firing).toBeFalse();
        expect(weapon.target).toBeUndefined();
    });
});
