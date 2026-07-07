import "jasmine";
import { once } from "events";
import { Worker } from "worker_threads";
import { makeWorkerThreadSimulationBridgeClient } from "./simulation_bridge_worker_threads.js";
import { makeSimulationBridgeHarness } from "./simulation_test_fixture.js";


describe("SimulationBridge worker integration", () => {
    it("runs the simulation bridge across a worker thread", async () => {
        const harness = await makeSimulationBridgeHarness();
        const serializer = harness.client.getSerializer();
        const ship = harness.world.entities.get(harness.shipUuid);
        if (!ship) {
            throw new Error("Expected harness ship to exist");
        }

        const worker = new Worker(
            new URL("./simulation_bridge_worker_entry.js", import.meta.url),
            {
                workerData: {
                    systemId: harness.systemId,
                    communicatorId: "server",
                },
            },
        );
        await once(worker, "online");

        const client = makeWorkerThreadSimulationBridgeClient(worker, serializer);
        try {
            // Planets are loaded before the world ever steps, so the
            // initial frame already contains them.
            const initialFrame = await client.snapshot();
            for (const [uuid] of initialFrame.added) {
                expect(uuid).toContain('planet');
            }

            await client.addEntity(harness.shipUuid, ship);
            await client.step();
            const addedFrame = await client.snapshot();
            const addedShips = addedFrame.added.filter(([uuid]) => !uuid.includes('planet'));
            expect(addedShips.length).toBe(1);
            expect(addedShips[0]?.[0]).toBe(harness.shipUuid);
            const decoded = client.decodeEntity(addedShips[0]![1]);
            expect(decoded.name).toBe(ship.name);

            await client.step();
            const steppedFrame = await client.snapshot();
            expect(steppedFrame.time?.frame).toBe((addedFrame.time?.frame ?? 0) + 1);

            await client.removeEntity(harness.shipUuid);
            await client.step();
            const removedFrame = await client.snapshot();
            expect(removedFrame.added).toEqual([]);
            expect(removedFrame.removed).toContain(harness.shipUuid);
        } finally {
            await client.close();
        }
    });
});
