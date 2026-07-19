import { Component } from 'nova_ecs/component';

/**
 * Ship ids of escorts hired in the bar this landing, carried on the
 * docked player entity until launch. Display-side bookkeeping only:
 * browser.ts pops this component off the entity before re-adding it
 * to the simulation and spawns each escort through the same
 * input-record addEntity path the relaunched player ship uses, so the
 * spawns are deterministic across peers.
 *
 * SCOPE LIMIT (documented gap): hired escorts are in-system sim
 * entities only. They do NOT follow the player through hyperspace
 * jumps or persist across landings — cross-jump escorts are future
 * work tied to persistence.
 */
export const PendingEscortsComponent =
    new Component<string[]>('PendingEscorts');
