import { Emit, Entities, UUID } from 'nova_ecs/arg_types';
import { Plugin } from 'nova_ecs/plugin';
import { Query } from 'nova_ecs/query';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { SingletonComponent } from 'nova_ecs/world';
import { EscortOrderComponent, HiredEscortComponent } from '../nova_plugin/escort_plugin';
import { pickVoiceClip, resolveVoice, VoiceLine } from '../nova_plugin/escort_voice';
import { GameDataResource } from '../nova_plugin/game_data_resource';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin';
import { ShipDataComponent } from '../nova_plugin/ship_plugin';
import { SoundEvent } from '../nova_plugin/sound_event';
import { TargetComponent } from '../nova_plugin/target_component';

interface EscortVoiceState {
    lastOrderSequence?: number;
    /** Escort uuid -> its current target, to notice a kill. */
    targets: Map<string, string | undefined>;
    availableSounds?: Set<number>;
    voiceTypes: Map<string, number | undefined>;
    lastSpokeAt: number;
}

const EscortVoiceStateResource = new Resource<EscortVoiceState>('EscortVoiceState');

const PlayerOrderQuery = new Query([UUID, PlayerShipSelector] as const);
const EscortsQuery = new Query([UUID, HiredEscortComponent, TargetComponent,
    ShipDataComponent] as const);

/** Minimum time between two voice lines, so a wing does not talk over itself. */
const VOICE_COOLDOWN_MS = 1200;

const EscortVoiceSystem = new System({
    name: 'EscortVoiceSystem',
    args: [PlayerOrderQuery, EscortsQuery, Entities, EscortVoiceStateResource,
        GameDataResource, Emit, SingletonComponent] as const,
    step(players, escorts, entities, state, gameData, emit) {
        const playerUuid = players[0]?.[0];
        if (!playerUuid) return;
        if (!state.availableSounds) {
            state.availableSounds = new Set();
            void gameData.ids.then(ids => {
                state.availableSounds = new Set((ids.SoundFile ?? [])
                    .map(id => Number(id.split(':')[1]))
                    .filter(Number.isFinite));
            }).catch(() => undefined);
        }
        const mine = escorts.filter(([, hired]) => hired.ownerUuid === playerUuid);
        const now = Date.now();

        const speak = (escortUuid: string, govt: number, line: VoiceLine) => {
            if (now - state.lastSpokeAt < VOICE_COOLDOWN_MS) return;
            if (!state.voiceTypes.has(String(govt))) {
                state.voiceTypes.set(String(govt), undefined);
                if (govt >= 128 && gameData.data.Govt) {
                    void gameData.data.Govt.get(`nova:${govt}`)
                        .then(data => state.voiceTypes.set(String(govt), data.voiceType ?? 0))
                        .catch(() => state.voiceTypes.set(String(govt), 0));
                } else {
                    state.voiceTypes.set(String(govt), 0);
                }
            }
            const voice = resolveVoice(state.voiceTypes.get(String(govt)) ?? 0);
            if (!voice) return;
            const clip = pickVoiceClip(voice, line, escortUuid, state.availableSounds!);
            if (!clip) return;
            state.lastSpokeAt = now;
            emit(SoundEvent, { id: clip });
        };

        // Acknowledge a new order (target line for "attack").
        const order = entities.get(playerUuid)?.components.get(EscortOrderComponent);
        if (order && order.sequence !== state.lastOrderSequence) {
            const first = state.lastOrderSequence === undefined;
            state.lastOrderSequence = order.sequence;
            const speaker = mine[0];
            if (speaker && !first) {
                speak(speaker[0], speaker[3].inherentGovt,
                    order.mode === 'attack' ? 'target' : 'acknowledge');
            }
        }

        // Victory: an escort's target vanished right after being engaged.
        for (const [escortUuid, , target, shipData] of mine) {
            const previous = state.targets.get(escortUuid);
            if (previous && previous !== target.target && !entities.has(previous)) {
                speak(escortUuid, shipData.inherentGovt, 'victory');
            }
            state.targets.set(escortUuid, target.target);
        }
        for (const uuid of [...state.targets.keys()]) {
            if (!mine.some(([escortUuid]) => escortUuid === uuid)) state.targets.delete(uuid);
        }
    },
});

export const EscortVoicePlugin: Plugin = {
    name: 'EscortVoicePlugin',
    build(world) {
        world.resources.set(EscortVoiceStateResource, {
            targets: new Map(), voiceTypes: new Map(), lastSpokeAt: -Infinity,
        });
        world.addSystem(EscortVoiceSystem);
    },
    remove(world) {
        world.removeSystem(EscortVoiceSystem);
        world.resources.delete(EscortVoiceStateResource);
    },
};
