import { EcsEvent } from "nova_ecs/events";
import { Serializer } from "nova_ecs/plugins/serializer_plugin";
import { World } from "nova_ecs/world";
import { isLeft } from "fp-ts/lib/Either.js";

export interface EncodedSimulationBridgeEvent {
    name: string;
    data: unknown;
    entityUuids?: string[];
}

interface SimulationBridgeEventRegistration<Data, Encoded = Data> {
    event: EcsEvent<Data, Encoded>;
    name: string;
    encode(data: Data, serializer: Serializer): Encoded;
    decode(data: Encoded, serializer: Serializer): Data;
    includeEntityUuids: boolean;
}

type SimulationBridgeEventOptions<Data, Encoded = Data> = {
    event: EcsEvent<Data, Encoded>;
    name?: string;
    encode?: (data: Data, serializer: Serializer) => Encoded;
    decode?: (data: Encoded, serializer: Serializer) => Data;
    includeEntityUuids?: boolean;
};

const eventRegistrationsByEvent = new Map<EcsEvent<unknown>, SimulationBridgeEventRegistration<unknown, unknown>>();
const eventRegistrationsByName = new Map<string, SimulationBridgeEventRegistration<unknown, unknown>>();

export function registerSimulationBridgeEvent<Data, Encoded = Data>({
    event,
    name,
    encode,
    decode,
    includeEntityUuids,
}: SimulationBridgeEventOptions<Data, Encoded>) {
    const eventName = name ?? event.name;
    if (!eventName) {
        throw new Error("Simulation bridge events need a stable name");
    }

    const existingByEvent = eventRegistrationsByEvent.get(event as EcsEvent<unknown>);
    if (existingByEvent) {
        if (existingByEvent.name !== eventName) {
            throw new Error(`Simulation bridge event ${eventName} conflicts with ${existingByEvent.name}`);
        }
        return;
    }
    if (eventRegistrationsByName.has(eventName)) {
        throw new Error(`Simulation bridge event name ${eventName} is already registered`);
    }

    const registration: SimulationBridgeEventRegistration<Data, Encoded> = {
        event,
        name: eventName,
        encode: encode ?? ((data: Data) => {
            if (event.type) {
                return event.type.encode(data) as unknown as Encoded;
            }
            return data as unknown as Encoded;
        }),
        decode: decode ?? ((data: Encoded) => {
            if (event.type) {
                const decoded = event.type.decode(data);
                if (isLeft(decoded)) {
                    throw new Error(`Failed to decode simulation bridge event ${eventName}`);
                }
                return decoded.right;
            }
            return data as unknown as Data;
        }),
        includeEntityUuids: includeEntityUuids ?? true,
    };
    eventRegistrationsByEvent.set(event as EcsEvent<unknown>, registration as SimulationBridgeEventRegistration<unknown, unknown>);
    eventRegistrationsByName.set(eventName, registration as SimulationBridgeEventRegistration<unknown, unknown>);
}

export function getRegisteredSimulationBridgeEvents() {
    return [...eventRegistrationsByEvent.values()];
}

function decodeSimulationBridgeEvent(
    event: EncodedSimulationBridgeEvent,
    serializer: Serializer,
): { event: EcsEvent<unknown>, data: unknown, entityUuids?: string[] } {
    const registration = eventRegistrationsByName.get(event.name);
    if (!registration) {
        throw new Error(`Unknown simulation bridge event ${event.name}`);
    }
    return {
        event: registration.event,
        data: registration.decode(event.data, serializer),
        entityUuids: event.entityUuids,
    };
}

export function emitSimulationBridgeEvent(
    event: EncodedSimulationBridgeEvent,
    serializer: Serializer,
    world: World,
) {
    const decoded = decodeSimulationBridgeEvent(event, serializer);
    world.emit(decoded.event, decoded.data, decoded.entityUuids);
}
