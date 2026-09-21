import { EcsEvent } from 'nova_ecs/events';
import { Time } from 'nova_ecs/plugins/time_plugin';
import { WeaponDamage } from 'novadatainterface/WeaponData';

export const DeathEvent = new EcsEvent<Time>('DeathEvent');
export const ZeroArmorEvent = new EcsEvent<Time>('ZeroArmorEvent');

export const DamagedEvent = new EcsEvent<{
    damage: WeaponDamage,
    damager: string,
    scale?: number,
    fromExplosion?: boolean,
}>('DamagedEvent');

export const AppliedDamageEvent = new EcsEvent<{
    shield: number,
    armor: number,
    damager: string,
    fromExplosion?: boolean,
}>('AppliedDamageEvent');

export interface PlayerDestructionComplete extends Time {
    playerUuid: string;
}
export const PlayerDestructionCompleteEvent =
    new EcsEvent<PlayerDestructionComplete>(
        'PlayerDestructionCompleteEvent');
