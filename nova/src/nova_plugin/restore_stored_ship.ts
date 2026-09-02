import { isRight } from 'nova_ecs/either';
import { UnknownComponent } from 'nova_ecs/component';
import { Position } from 'nova_ecs/datatypes/position';
import { Entity } from 'nova_ecs/entity';
import {
    MovementStateComponent,
    RemoteMovementPresentationComponent,
} from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import {
    EncodedEntity,
    Serializer,
} from 'nova_ecs/plugins/serializer_plugin';
import {
    AssistanceOutcomeComponent,
    AssistanceRequestComponent,
} from './assistance_plugin';
import {
    BoardingOutcomeComponent,
    BoardingRequestComponent,
    BoardingStateComponent,
} from './boarding_plugin';
import {
    ExplodingComponent,
    PlayerDeathComponent,
} from './death_plugin';
import { DestructionStartedComponent } from './destruction_state';
import { JumpStateComponent } from './jump_plugin';
import { PlayerShipSelector } from './player_ship_plugin';
import { ShipComponent } from './ship_plugin';
import { TargetComponent } from './target_component';

/**
 * These components identify a live world session rather than durable ship
 * state. Ownership and local selectors are assigned by the new session;
 * jump/death phases contain expired wall-clock transitions; presentation,
 * targeting, boarding and assistance state refer to entity UUIDs that belonged
 * to the previous system world. Provider-derived ship state is intentionally
 * not excluded: providers can refresh it after all durable components exist.
 */
export const STORED_SHIP_EXCLUDED_COMPONENTS = new Set([
    MultiplayerData.name,
    PlayerShipSelector.name,
    RemoteMovementPresentationComponent.name,
    JumpStateComponent.name,
    PlayerDeathComponent.name,
    DestructionStartedComponent.name,
    ExplodingComponent.name,
    TargetComponent.name,
    BoardingRequestComponent.name,
    BoardingOutcomeComponent.name,
    BoardingStateComponent.name,
    AssistanceRequestComponent.name,
    AssistanceOutcomeComponent.name,
]);

export interface StoredShipRestoreResult {
    entity: Entity;
    restored: boolean;
    skippedComponents: string[];
    fallbackReason?: 'invalid-entity' | 'invalid-hull';
}

interface DecodedStoredShip {
    name?: string;
    components: Array<readonly [UnknownComponent, unknown]>;
    skippedComponents: string[];
}

/**
 * Decodes each component independently so one obsolete or corrupt component
 * cannot discard otherwise valid durable state.
 */
export function decodeStoredShipComponents(
    serializer: Serializer,
    stored: unknown,
): DecodedStoredShip | undefined {
    const encoded = EncodedEntity.decode(stored);
    if (!isRight(encoded)) {
        return undefined;
    }
    const components: Array<readonly [UnknownComponent, unknown]> = [];
    const skipped = new Set<string>();
    for (const [name, value] of encoded.right.components) {
        if (STORED_SHIP_EXCLUDED_COMPONENTS.has(name)) {
            continue;
        }
        const component = serializer.componentsByName.get(name);
        const codec = component
            ? serializer.componentTypes.get(component)
            : undefined;
        if (!component || !codec) {
            skipped.add(name);
            continue;
        }
        try {
            const decoded = codec.decode(value);
            if (!isRight(decoded)) {
                skipped.add(name);
                continue;
            }
            components.push([component, decoded.right]);
        } catch {
            skipped.add(name);
        }
    }
    return {
        name: encoded.right.name,
        components,
        skippedComponents: [...skipped].sort(),
    };
}

export function restoreStoredShip(
    serializer: Serializer,
    stored: unknown,
    fallback: Entity,
    expectedShipId: string,
): StoredShipRestoreResult {
    if (stored === undefined) {
        return {
            entity: fallback,
            restored: false,
            skippedComponents: [],
        };
    }
    const decoded = decodeStoredShipComponents(serializer, stored);
    if (!decoded) {
        return {
            entity: fallback,
            restored: false,
            skippedComponents: [],
            fallbackReason: 'invalid-entity',
        };
    }
    const ship = decoded.components.find(
        ([component]) => component === ShipComponent)?.[1];
    if (!ship || (ship as { id?: unknown }).id !== expectedShipId) {
        return {
            entity: fallback,
            restored: false,
            skippedComponents: decoded.skippedComponents,
            fallbackReason: 'invalid-hull',
        };
    }

    const restored = new Entity(decoded.name ?? fallback.name);
    for (const [component, value] of decoded.components) {
        restored.components.set(component, value);
    }
    if (!restored.components.has(MovementStateComponent)) {
        const movement = fallback.components.get(MovementStateComponent);
        if (movement) {
            restored.components.set(MovementStateComponent, movement);
        }
    }
    return {
        entity: restored,
        restored: true,
        skippedComponents: decoded.skippedComponents,
    };
}

export function placeShipAtLanding(
    entity: Entity,
    landing: readonly [number, number],
): void {
    const movement = entity.components.get(MovementStateComponent);
    if (!movement) {
        return;
    }
    const [rawX, rawY] = landing;
    const x = Number.isFinite(rawX) ? rawX : 0;
    const y = Number.isFinite(rawY) ? rawY : 0;
    // A stored movement snapshot precedes the completed landing. The landing
    // record is authoritative for location; all other movement state survives.
    movement.position = new Position(x, y);
}
