import { EmitFunction } from 'nova_ecs/arg_types';
import { Component } from 'nova_ecs/component';
import { Entity } from 'nova_ecs/entity';
import { GameDataInterface } from 'novadatainterface/GameDataInterface';
import {
    executeSetOperations,
    NcbTestContext,
    parseSetExpression,
} from './ncb';
import {
    createNcbHandlers,
    NcbHandlerContext,
} from './ncb_handlers';
import { OutfitsStateComponent } from './outfit_plugin';
import { Resource } from 'nova_ecs/resource';
import {
    PlayerState,
    PlayerStateComponent,
} from './player_state';
import { ShipComponent, ShipDataComponent } from './ship_plugin';
import { SoundEvent } from './sound_event';

export type MissionSetContext = Omit<NcbHandlerContext, 'state'>;

export const PendingMissionJumpComponent = new Component<{
    systemId: string;
    relative: boolean;
}>('PendingMissionJumpComponent');

export const PendingMissionSoundComponent = new Component<{
    soundId: string;
}>('PendingMissionSoundComponent');

export const NcbRuntimeResource =
    new Resource<NcbRuntime>('NcbRuntimeResource');

function normalizeNcbIds(
    ids: Iterable<string | number>,
): ReadonlySet<string | number> {
    const normalized = new Set<string | number>();
    for (const id of ids) {
        normalized.add(id);
        if (typeof id === 'string') {
            normalized.add(id.replace(/^.*:/, ''));
        }
    }
    return normalized;
}

/**
 * Build the complete NCB test context available from player state and the
 * current outfit inventory. Callers that do not have outfit data still get
 * the other state-backed operands instead of silently reducing NCB to bits.
 */
export function ncbTestContext(
    state: Pick<
        PlayerState,
        'missionBits' | 'gender' | 'exploredSystems'
    > & Partial<Pick<PlayerState, 'registered' | 'daysSinceRegistration'>>,
    outfits?: ReadonlyMap<string, unknown>,
): NcbTestContext {
    return {
        missionBits: state.missionBits,
        gender: state.gender,
        outfits: outfits
            ? normalizeNcbIds(outfits.keys())
            : undefined,
        exploredSystems: normalizeNcbIds(state.exploredSystems),
        registered: state.registered,
        daysSinceRegistration: state.daysSinceRegistration,
    };
}

export interface NcbRuntimeOptions {
    readonly emit?: EmitFunction;
    readonly logger?: (message: string) => void;
}

/**
 * Own the ECS-facing effects of NCB set expressions. In particular, every
 * ship change reloads ShipData, regardless of whether default outfits are
 * requested; defaults and reset semantics are applied only after that load.
 */
export class NcbRuntime {
    private readonly shipGenerations = new WeakMap<Entity, number>();

    constructor(
        private readonly gameData: GameDataInterface,
        private readonly options: NcbRuntimeOptions = {},
    ) { }

    testContext(
        state: PlayerState,
        outfits?: ReadonlyMap<string, unknown>,
    ): NcbTestContext {
        return ncbTestContext(state, outfits);
    }

    setContext(entity: Entity, state: PlayerState): MissionSetContext {
        const outfits = entity.components.get(OutfitsStateComponent)
            ?? new Map();
        return {
            outfits,
            onMoveToSystem: (systemId, relative) => {
                entity.components.set(PendingMissionJumpComponent, {
                    systemId,
                    relative,
                });
            },
            onPlaySound: soundId => {
                if (this.options.emit) {
                    this.options.emit(SoundEvent, { id: `nova:${soundId}` });
                } else {
                    entity.components.set(PendingMissionSoundComponent, {
                        soundId: `nova:${soundId}`,
                    });
                }
            },
            onChangeShip: (shipId, includeDefaults, resetNonPersistent) => {
                entity.components.set(ShipComponent, { id: shipId });
                const generation = (this.shipGenerations.get(entity) ?? 0) + 1;
                this.shipGenerations.set(entity, generation);
                void this.gameData.data.Ship.get(shipId).then(ship => {
                    if (this.shipGenerations.get(entity) !== generation
                        || entity.components.get(ShipComponent)?.id !== shipId) {
                        return;
                    }
                    entity.components.set(ShipDataComponent, ship);
                    const current = entity.components.get(
                        OutfitsStateComponent) ?? outfits;
                    if (resetNonPersistent) {
                        current.clear();
                    }
                    if (includeDefaults) {
                        for (const [outfitId, count] of Object.entries(
                            ship.outfits)) {
                            const previous = current.get(outfitId);
                            current.set(outfitId, {
                                count: (previous?.count ?? 0) + count,
                            });
                        }
                    }
                    entity.components.set(OutfitsStateComponent, current);
                }).catch(error => {
                    this.options.logger?.(
                        `Could not load ship data for ${shipId}: ${error}`);
                });
            },
        };
    }

    apply(
        expression: string | undefined,
        entity: Entity,
        state: PlayerState,
    ): void {
        if (!expression?.trim()) {
            return;
        }
        try {
            const operations = parseSetExpression(expression, {
                logger: this.options.logger,
            });
            executeSetOperations(
                operations,
                state.missionBits,
                {
                    handlers: createNcbHandlers({
                        ...this.setContext(entity, state),
                        state,
                        logger: this.options.logger,
                    }),
                    logger: this.options.logger,
                },
            );
        } catch (error) {
            this.options.logger?.(
                `Could not execute NCB set expression '${expression}': ${error}`);
        }
    }
}

export function playerStateFromEntity(entity: Entity): PlayerState | undefined {
    return entity.components.get(PlayerStateComponent);
}
