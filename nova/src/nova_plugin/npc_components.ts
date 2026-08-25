import * as t from "io-ts";
import { Component } from "nova_ecs/component";

export const GovtData = t.type({
    id: t.number,
});
export type GovtData = t.TypeOf<typeof GovtData>;
export const GovtComponent = new Component<GovtData>('GovtComponent');

// This marker is intentionally not delta-serialized. It ensures that the AI
// systems run only for entities constructed by makeNpc on the authoritative
// server, never for replicated NPCs in a browser world.
export const NpcAIComponent =
    new Component<undefined>("NpcAIComponent");

export type NpcCombatRole = "civilian" | "military" | "personal";

/**
 * Spawn provenance matters for assistance: military/security düdes may defend
 * their government, while traders and unknown mission ships only keep their
 * own fights. This is authoritative server state and need not be replicated.
 */
export const NpcCombatRoleComponent =
    new Component<NpcCombatRole>("NpcCombatRoleComponent");

export const ChooseRandomTargetComponent = new Component<{
    interval: number,
    nextTime?: number,
}>('ChooseRandomTargetComponent');
