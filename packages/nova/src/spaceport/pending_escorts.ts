import { Component } from 'nova_ecs/component';

/**
 * Ship ids of escorts hired in the bar this landing, carried on the
 * docked player entity until launch. Display-side bookkeeping only:
 * browser.ts pops this component off the entity before re-adding it
 * to the simulation and spawns each escort through the same
 * input-record addEntity path the relaunched player ship uses, so the
 * spawns are deterministic across peers.
 *
 * This component covers only escorts hired THIS landing. Escorts the
 * player already had are a different mechanism: they follow the player's
 * lifecycle (landing with them, departing with them, jumping with them)
 * through PlayerEscortComponent and the carried-escort roster — see
 * nova_plugin/player_escort_plugin.ts and landed_escorts.ts.
 *
 * SCOPE LIMIT (documented gap): escorts are not persisted to the save
 * game, so they do not survive a reload (see save_game.ts).
 */
export const PendingEscortsComponent =
    new Component<string[]>('PendingEscorts');
