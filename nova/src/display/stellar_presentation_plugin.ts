import { GetEntity } from "nova_ecs/arg_types";
import { Component } from "nova_ecs/component";
import { Position } from "nova_ecs/datatypes/position";
import { Optional } from "nova_ecs/optional";
import { Plugin } from "nova_ecs/plugin";
import { MovementStateComponent } from "nova_ecs/plugins/movement_plugin";
import { replicationPolicies } from "nova_ecs/plugins/multiplayer_plugin";
import { Query } from "nova_ecs/query";
import { System } from "nova_ecs/system";
import * as t from 'io-ts';
import { v4 } from "uuid";
import { AnimationComponent } from "../nova_plugin/animation_plugin";
import { EntityBudgetResource, reserveEntity } from "../nova_plugin/entity_budget";
import { GameDataResource } from "../nova_plugin/game_data_resource";
import { PlanetDataComponent } from "../nova_plugin/planet_plugin";
import { PlayerShipSelector } from "../nova_plugin/player_ship_plugin";
import { PlayerStateComponent } from "../nova_plugin/player_state";
import { StellarBlastComponent } from "../nova_plugin/stellar_blast";
import { stellarPresentation } from "../nova_plugin/stellar_visibility";
import { AnimationGraphicComponent } from "./animation_graphic_plugin";
import { makeExplosion } from "./explosion_plugin";
import { Entities } from "nova_ecs/arg_types";

const LocalPilotStateQuery = new Query([PlayerShipSelector, PlayerStateComponent] as const);

function imageId(animation: { images?: { baseImage?: { id?: string } } } | undefined) {
    return animation?.images?.baseImage?.id;
}

/**
 * Each client shows stellars its own pilot destroyed as their DeadType
 * graphic, or hides them. Reacts to destroyedStellars changing, so a stellar
 * reappears when MissionRuntime.regenerateStellars restores it.
 */
export const StellarPresentationSystem = new System({
    name: 'StellarPresentationSystem',
    args: [PlanetDataComponent, GetEntity, LocalPilotStateQuery,
        Optional(AnimationComponent), Optional(AnimationGraphicComponent)] as const,
    step(planetData, entity, pilots, animation, graphic) {
        const state = pilots[0]?.[1];
        const presentation = stellarPresentation(state, planetData);
        const wanted = presentation === 'dead'
            ? planetData.deadAnimation!
            : planetData.animation;
        if (animation && imageId(animation) !== imageId(wanted)) {
            entity.components.set(AnimationComponent, wanted);
        }
        if (graphic && !graphic.managed.disposed) {
            graphic.container.visible = presentation !== 'hidden';
        }
    },
});

/** Last StellarBlast sequence this client has presented. */
const StellarBlastSeen = new Component<number>('StellarBlastSeen');
replicationPolicies.register(StellarBlastSeen, { codec: t.number, authority: 'local-only' });

/**
 * Cosmetic: play the spöb ExplodType explosion for everyone in the room when
 * the server reports the shared pool broke. The first observation only
 * records the sequence so a late joiner does not replay old blasts.
 */
export const StellarExplosionSystem = new System({
    name: 'StellarExplosionSystem',
    args: [StellarBlastComponent, PlanetDataComponent, MovementStateComponent,
        GetEntity, GameDataResource, Entities, EntityBudgetResource,
        Optional(StellarBlastSeen)] as const,
    step(blast, planetData, movement, entity, gameData, entities, budget, seen) {
        if (seen === undefined || blast.seq < seen) {
            entity.components.set(StellarBlastSeen, blast.seq);
            return;
        }
        if (blast.seq === seen) {
            return;
        }
        entity.components.set(StellarBlastSeen, blast.seq);
        const primary = planetData.explosion
            ? gameData.data.Explosion.getCached(planetData.explosion) : undefined;
        if (!primary) {
            return;
        }
        const secondary = planetData.secondaryExplosion
            ? gameData.data.Explosion.getCached(planetData.secondaryExplosion) : undefined;
        const explosion = makeExplosion(primary,
            Position.fromVectorLike(movement.position), secondary);
        if (reserveEntity(budget, explosion, 'explosion')) {
            entities.set(v4(), explosion);
        }
    },
});

export const StellarPresentationPlugin: Plugin = {
    name: 'StellarPresentationPlugin',
    build(world) {
        world.addComponent(StellarBlastSeen);
        world.addSystem(StellarPresentationSystem);
        world.addSystem(StellarExplosionSystem);
    },
    remove(world) {
        world.removeSystem(StellarPresentationSystem);
        world.removeSystem(StellarExplosionSystem);
    },
};
