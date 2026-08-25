import { Component } from 'nova_ecs/component';

/**
 * Present from the first zero-armour destruction step until entity removal or
 * player respawn. Systems which can originate combat actions must treat this
 * as an immediate, entity-scoped lockout.
 */
export const DestructionStartedComponent =
    new Component<boolean>('DestructionStartedComponent');
