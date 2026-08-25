import * as t from 'io-ts';
import { PlanetData } from "novadatainterface/PlanetData";
import { Emit, UUID } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { EcsEvent } from 'nova_ecs/events';
import { Plugin } from 'nova_ecs/plugin';
import { Optional } from 'nova_ecs/optional';
import { DeltaResource } from 'nova_ecs/plugins/delta_plugin';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { replicationPolicies } from 'nova_ecs/plugins/multiplayer_plugin';
import { Provide } from 'nova_ecs/provide';
import { ProvideAsync } from "nova_ecs/provide_async";
import { Query } from 'nova_ecs/query';
import { System } from 'nova_ecs/system';
import { AnimationComponent } from './animation_plugin';
import { ControlStateEvent } from './control_state_event';
import { GameDataResource } from './game_data_resource';
import { PlayerShipSelector } from './player_ship_plugin';
import { ShipComponent } from './ship_plugin';
import { SoundEvent } from './sound_event';
import { Target } from './target_component';
import { ArmorComponent } from './health_plugin';
import { DestructionStartedComponent } from './destruction_state';

export const PlanetType = t.intersection([
    t.type({
        id: t.string, // Not a UUID. A nova id.
    }),
    // Optional for wire compatibility with older peers which only sent id.
    t.partial({
        name: t.string,
        flags: t.number,
        techLevel: t.number,
        specialTech: t.array(t.number),
        canLand: t.boolean,
        inhabited: t.boolean,
    }),
]);
export type PlanetType = t.TypeOf<typeof PlanetType>;

export const PlanetComponent = new Component<PlanetType>('Planet');

export const PlanetDataComponent = new Component<PlanetData>('PlanetData');

export const PlanetDataProvider = ProvideAsync({
    name: "PlanetDataProvider",
    provided: PlanetDataComponent,
    args: [GameDataResource, PlanetComponent] as const,
    factory: async (gameData, planet) => {
        return await gameData.data.Planet.get(planet.id);
    }
});

export const PlanetTargetComponent = new Component<Target>('PlanetTargetComponent');

const LandingInputComponent = new Component<{ held: boolean }>(
    'LandingInputComponent');
replicationPolicies.register(PlanetTargetComponent, {
    codec: Target,
    authority: 'local-only',
});
replicationPolicies.register(LandingInputComponent, {
    codec: t.type({ held: t.boolean }),
    authority: 'local-only',
});

const PlanetTargetProvider = Provide({
    name: "PlanetTargetProvider",
    provided: PlanetTargetComponent,
    args: [ShipComponent] as const,
    factory: () => ({ target: undefined }),
});

const LandingInputProvider = Provide({
    name: "LandingInputProvider",
    provided: LandingInputComponent,
    args: [ShipComponent] as const,
    factory: () => ({ held: false }),
});

export const LandEvent = new EcsEvent<{ id: string, uuid: string }>('LandEvent');

export type LandingRejectionReason =
    | 'no-planet'
    | 'too-far'
    | 'too-fast'
    | 'cannot-land'
    | 'uninhabited'
    | 'metadata-unavailable'
    | 'destroyed'
    | 'spaceport-unavailable';

export type LandingResult =
    | { outcome: 'selected', planetName: string }
    | { outcome: 'landed', planetName: string }
    | {
        outcome: 'rejected',
        reason: LandingRejectionReason,
        planetName?: string,
    };
export const LandingResultEvent =
    new EcsEvent<LandingResult>('LandingResultEvent');

// Retail permits landing while visibly near a stellar; requiring the ship's
// center to overlap the body's center made ordinary approach impractical.
export const LANDING_RANGE = 500;
export const LANDING_RANGE_SQUARED = LANDING_RANGE ** 2;
export const LANDING_MAX_SPEED_SQUARED = 3_000;

export interface LandingCandidate {
    uuid: string;
    id: string;
    name: string;
    distanceSquared: number;
    canLand: boolean | undefined;
    inhabited: boolean | undefined;
}

export interface LandingMetadata {
    flags?: number;
    canLand?: boolean;
    inhabited?: boolean;
}

export function landingCapabilities(
    planet: LandingMetadata,
): Pick<LandingCandidate, 'canLand' | 'inhabited'> {
    const flags = typeof planet.flags === 'number'
        && Number.isFinite(planet.flags)
        ? planet.flags : undefined;
    return {
        canLand: typeof planet.canLand === 'boolean'
            ? planet.canLand
            : flags === undefined ? undefined : (flags & 0x1) !== 0,
        inhabited: typeof planet.inhabited === 'boolean'
            ? planet.inhabited
            : flags === undefined ? undefined : (flags & 0x20) === 0,
    };
}

export function resolveLandingCapabilities(
    authoritative: LandingMetadata,
    local?: LandingMetadata,
): Pick<LandingCandidate, 'canLand' | 'inhabited'> {
    const server = landingCapabilities(authoritative);
    const fallback = local ? landingCapabilities(local) : {
        canLand: undefined,
        inhabited: undefined,
    };
    return {
        canLand: server.canLand ?? fallback.canLand,
        inhabited: server.inhabited ?? fallback.inhabited,
    };
}

export type LandingDecision =
    | { action: 'none', reason: 'no-planet' }
    | { action: 'select' }
    | { action: 'land' }
    | { action: 'refuse', reason: LandingRejectionReason };

export function chooseLandingCandidate(
    candidates: readonly LandingCandidate[],
): LandingCandidate | undefined {
    return candidates
        .reduce<LandingCandidate | undefined>((closest, candidate) =>
            !closest || candidate.distanceSquared < closest.distanceSquared
                ? candidate
                : closest, undefined);
}

export function landingDecision(
    currentTarget: string | undefined,
    candidate: LandingCandidate,
    velocitySquared: number,
): LandingDecision {
    if (currentTarget !== candidate.uuid) {
        return { action: 'select' };
    }
    if (candidate.canLand === false) {
        return { action: 'refuse', reason: 'cannot-land' };
    }
    if (candidate.inhabited === false) {
        return { action: 'refuse', reason: 'uninhabited' };
    }
    if (candidate.canLand === undefined
        || candidate.inhabited === undefined) {
        return { action: 'refuse', reason: 'metadata-unavailable' };
    }
    if (candidate.distanceSquared > LANDING_RANGE_SQUARED) {
        return { action: 'refuse', reason: 'too-far' };
    }
    if (velocitySquared > LANDING_MAX_SPEED_SQUARED) {
        return { action: 'refuse', reason: 'too-fast' };
    }
    return { action: 'land' };
}

export function canInitiateLanding(
    candidate: LandingCandidate,
    velocitySquared: number,
): boolean {
    return landingDecision(candidate.uuid, candidate, velocitySquared).action
        === 'land';
}

export function landingAction(
    currentTarget: string | undefined,
    candidate: LandingCandidate | undefined,
    velocitySquared: number,
): 'none' | 'select' | 'land' | 'refuse' {
    if (!candidate) {
        return 'none';
    }
    return landingDecision(
        currentTarget, candidate, velocitySquared).action;
}

export function landingResultMessage(result: LandingResult): string {
    if (result.outcome === 'selected') {
        return `${result.planetName} targeted — press L again to land.`;
    }
    if (result.outcome === 'landed') {
        return '';
    }
    const name = result.planetName ?? 'This stellar';
    switch (result.reason) {
        case 'no-planet':
            return 'No stellar is available for landing.';
        case 'too-far':
            return `${name} is too far away to land.`;
        case 'too-fast':
            return `Slow down before landing on ${name}.`;
        case 'cannot-land':
            return `Landing is not permitted on ${name}.`;
        case 'uninhabited':
            return `${name} has no usable spaceport.`;
        case 'metadata-unavailable':
            return `Landing data for ${name} is unavailable.`;
        case 'destroyed':
            return `${name} has been destroyed.`;
        case 'spaceport-unavailable':
            return `${name}'s spaceport is unavailable.`;
    }
}

export function updateLandingInput(
    held: boolean,
    state: false | 'start' | 'repeat' | true | undefined,
): { held: boolean, begin: boolean } {
    if (!state) {
        return { held: false, begin: false };
    }
    return {
        held: true,
        begin: state === 'start' && !held,
    };
}

const AttemptLandingSystem = new System({
    name: 'AttemptLandingSystem',
    events: [ControlStateEvent] as const,
    args: [new Query([
        UUID,
        MovementStateComponent,
        PlanetComponent,
        Optional(PlanetDataComponent),
    ] as const),
        MovementStateComponent, PlanetTargetComponent, LandingInputComponent,
        ControlStateEvent, Emit,
        Optional(DestructionStartedComponent), Optional(ArmorComponent),
        PlayerShipSelector] as const,
    step(planets, { position, velocity }, planetTarget, landingInput,
        controls, emit, destructionStarted, armor) {
        const input = updateLandingInput(
            landingInput.held,
            controls.get('land'),
        );
        landingInput.held = input.held;
        if (!input.begin || destructionStarted || armor && armor.current <= 0) {
            return;
        }

        const candidate = chooseLandingCandidate(planets.map(([
            uuid,
            { position: planetPosition },
            planet,
            planetData,
        ]) => {
            const capabilities =
                resolveLandingCapabilities(planet, planetData);
            return {
                uuid,
                id: planet.id,
                name: planet.name ?? planetData?.name ?? planet.id,
                distanceSquared:
                    planetPosition.subtract(position).lengthSquared,
                ...capabilities,
            };
        }));
        if (!candidate) {
            planetTarget.target = undefined;
            emit(LandingResultEvent, {
                outcome: 'rejected',
                reason: 'no-planet',
            });
            emit(SoundEvent, { id: 'nova:153' });
            return;
        }

        const decision = landingDecision(
            planetTarget.target,
            candidate,
            velocity.lengthSquared,
        );
        if (decision.action === 'land') {
            emit(LandEvent, { id: candidate.id, uuid: candidate.uuid });
            emit(LandingResultEvent, {
                outcome: 'landed',
                planetName: candidate.name,
            });
        } else if (decision.action === 'refuse') {
            emit(LandingResultEvent, {
                outcome: 'rejected',
                reason: decision.reason,
                planetName: candidate.name,
            });
            emit(SoundEvent, { id: 'nova:153' });
        } else {
            emit(LandingResultEvent, {
                outcome: 'selected',
                planetName: candidate.name,
            });
        }
        planetTarget.target = candidate.uuid;
    }
});

const PlanetAnimationProvider = Provide({
    name: "PlanetAnimationProvider",
    provided: AnimationComponent,
    update: [PlanetDataComponent],
    args: [PlanetDataComponent],
    factory: planetData => planetData.animation,
});

// TODO: Make planets multiplayer aware
export const PlanetPlugin: Plugin = {
    name: 'PlanetPlugin',
    build(world) {
        const deltaMaker = world.resources.get(DeltaResource);
        if (!deltaMaker) {
            throw new Error('Expected delta maker resource to exist');
        }

        world.addComponent(PlanetComponent);
        world.addComponent(PlanetDataComponent);
        deltaMaker.addComponent(PlanetComponent, {
            componentType: PlanetType,
        });
        // Planet navigation is local UI state. Replicating it lets the
        // authoritative server's always-undefined copy overwrite the browser
        // selection between the first and second distinct L presses.
        world.addSystem(PlanetTargetProvider);
        world.addSystem(LandingInputProvider);
        world.addSystem(PlanetAnimationProvider);
        world.addSystem(PlanetDataProvider);
        world.addSystem(AttemptLandingSystem);
    }
};
