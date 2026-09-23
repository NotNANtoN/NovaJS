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

/**
 * Client-side presentation of a hit the server resolved (or that this client
 * predicted for its own shot). Health itself stays server-authoritative, so
 * AppliedDamageEvent never fires in browsers; effects listen for this.
 */
export const HitFeedbackEvent = new EcsEvent<{
    damager: string,
    kind: 'projectile' | 'beam' | 'blast',
    position: { x: number, y: number },
}>('HitFeedbackEvent');

export interface PlayerDestructionComplete extends Time {
    playerUuid: string;
}
export const PlayerDestructionCompleteEvent =
    new EcsEvent<PlayerDestructionComplete>(
        'PlayerDestructionCompleteEvent');
