import "jasmine";
import { getDefaultPersData } from "novadatainterface/PersData";
import { getDefaultShipData } from "novadatainterface/ShipData";
import { Entity } from "nova_ecs/entity";
import { DeltaPlugin } from "nova_ecs/plugins/delta_plugin";
import { World } from "nova_ecs/world";
import { AppliedDamageEvent, DeathEvent } from "./death_plugin";
import {
    PersAppearanceComponent,
    PersComponent,
    PersConfiguredComponent,
    PersInvincibleComponent,
    PersLinkAcceptedRequestComponent,
    PersBecomesSpecialShipComponent,
    PersPlugin,
    PersStateResource,
    PersWeaponsConfiguredComponent,
} from "./pers_plugin";
import { GovtComponent, NpcDepartureComponent } from "./npc_components";
import { MultiplayerData } from "nova_ecs/plugins/multiplayer_plugin";
import { MockGameData } from "novadatainterface/MockGameData";
import { getDefaultSystemData } from "novadatainterface/SystemData";
import { GameDataResource } from "./game_data_resource";
import { InitiateJumpEvent } from "./jump_plugin";
import { PlatformResource } from "./platform_plugin";
import { createInitialPlayerState, PlayerStateComponent } from "./player_state";
import { SystemIdResource } from "./system_id_resource";
import { PersFlags } from "./pers";
import { PlayerShipSelector } from "./player_ship_plugin";
import { ShipComponent, ShipDataComponent } from "./ship_plugin";
import { WeaponsStateComponent } from "./weapons_state";

function person() {
    return {
        ...getDefaultPersData(),
        id: "nova:131",
        name: "Jack Folstam",
        prefix: "nova",
        shipType: "nova:279",
        government: 157,
        aiType: 3,
        shieldMod: -1,
        flags: PersFlags.holdsGrudge,
        shipSubtitle: "Night-Master",
        weaponTypes: ["nova:133", null, null, null],
        weaponCounts: [1, 0, 0, 0],
    };
}

describe("PersPlugin", () => {
    it("configures identity, AI, government, and invincibility", async () => {
        const world = new World("pers-configure-test");
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(PersPlugin);
        const stock = {
            ...getDefaultShipData(),
            id: "nova:279",
            name: "Stock Ship",
            physics: {
                ...getDefaultShipData().physics,
                shield: 100,
            },
        };
        const entity = new Entity("stock")
            .addComponent(ShipComponent, { id: stock.id })
            .addComponent(ShipDataComponent, stock)
            .addComponent(PersComponent, {
                data: person(),
                state: { alive: true },
            })
            .addComponent(WeaponsStateComponent, new Map());
        world.entities.set("pers", entity);

        world.step();

        expect(entity.name).toBe("Jack Folstam");
        expect(entity.components.get(ShipDataComponent)!.name)
            .toBe("Jack Folstam");
        expect(entity.components.get(ShipDataComponent)!.inherentAI).toBe(3);
        expect(entity.components.has(PersConfiguredComponent)).toBeTrue();
        expect(entity.components.has(PersInvincibleComponent)).toBeTrue();
        expect(entity.components.has(PersWeaponsConfiguredComponent)).toBeTrue();
        expect(entity.components.get(WeaponsStateComponent)?.get("nova:133")?.count)
            .toBe(1);
        expect(entity.components.get(GovtComponent)).toEqual({ id: 157 });
        expect(entity.components.get(PersAppearanceComponent)?.shipSubtitle)
            .toBe("Night-Master");
    });

    it("records player attacks and removes killable people", async () => {
        const world = new World("pers-state-test");
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(PersPlugin);
        const data = person();
        const pers = new Entity("pers")
            .addComponent(PersComponent, { data, state: {} });
        const player = new Entity("player")
            .addComponent(ShipComponent, { id: "nova:128" })
            .addComponent(PlayerShipSelector, undefined);
        world.entities.set("pers", pers);
        world.entities.set("player", player);

        world.emitNow(AppliedDamageEvent, {
            shield: 10,
            armor: 0,
            damager: "player",
        }, ["pers"]);
        expect(pers.components.get(PersComponent)!.state.grudge).toBeTrue();

        world.emitNow(DeathEvent, { time: 0, delta_ms: 0, delta_s: 0, frame: 0 },
            ["pers"]);
        expect(world.resources.get(PersStateResource)?.get("nova:131")?.alive)
            .toBeFalse();
    });
});

describe("PersLinkAcceptedSystem", () => {
    async function setup(flags: number) {
        const world = new World("pers-link-test");
        world.resources.set(PlatformResource, "node");
        world.resources.set(SystemIdResource, "nova:130");
        const gameData = new MockGameData();
        gameData.data.System.map.set("nova:130", {
            ...getDefaultSystemData(), id: "nova:130", links: ["nova:131"],
        });
        world.resources.set(GameDataResource, gameData);
        await world.addPlugin(DeltaPlugin);
        await world.addPlugin(PersPlugin);
        const data = { ...person(), linkMission: "nova:141", flags };
        const pers = new Entity("pers")
            .addComponent(PersComponent, { data, state: { alive: true } })
            .addComponent(MultiplayerData, { owner: "server" });
        const player = new Entity("player")
            .addComponent(PlayerStateComponent, createInitialPlayerState())
            .addComponent(MultiplayerData, { owner: "player" });
        world.entities.set("pers", pers);
        world.entities.set("player", player);
        const jumps: unknown[] = [];
        world.events.get(InitiateJumpEvent).subscribe(event => jumps.push(event));
        return { world, pers, player, jumps };
    }

    it("makes a linkLeave ship jump out and deactivates a linkDeactivate përs", async () => {
        const { world, pers, player, jumps } = await setup(
            PersFlags.linkLeave | PersFlags.linkDeactivate);
        player.components.set(PersLinkAcceptedRequestComponent, {
            target: "pers", missionId: "nova:141", sequence: 1,
        });
        world.step();
        expect(player.components.has(PersLinkAcceptedRequestComponent)).toBeFalse();
        expect(jumps).toEqual([{ to: "nova:131" }]);
        expect(pers.components.has(NpcDepartureComponent)).toBeTrue();
        expect(pers.components.get(PersComponent)!.state.alive).toBeFalse();
        expect(world.resources.get(PersStateResource)?.get("nova:131")?.alive)
            .toBeFalse();
    });

    it("ignores requests for another mission or a replayed sequence", async () => {
        const { world, pers, player, jumps } = await setup(
            PersFlags.linkLeave | PersFlags.linkDeactivate);
        player.components.set(PersLinkAcceptedRequestComponent, {
            target: "pers", missionId: "nova:999", sequence: 1,
        });
        world.step();
        expect(jumps).toEqual([]);
        expect(pers.components.get(PersComponent)!.state.alive).toBeTrue();

        player.components.set(PersLinkAcceptedRequestComponent, {
            target: "pers", missionId: "nova:141", sequence: 1,
        });
        world.step();
        expect(jumps).toEqual([]);
    });

    it("hands a Flags 0x0040 përs to the accepted mission instead of leaving", async () => {
        const { world, pers, player, jumps } = await setup(
            PersFlags.linkSpecialShip | PersFlags.linkLeave);
        player.components.set(PersLinkAcceptedRequestComponent, {
            target: "pers", missionId: "nova:141", sequence: 1, missionUuid: "m-1",
        });
        world.step();
        expect(jumps).toEqual([]);
        expect(pers.components.get(PersBecomesSpecialShipComponent))
            .toEqual({ missionUuid: "m-1", playerUuid: "player" });
    });

    it("leaves a përs without link flags in play", async () => {
        const { world, pers, player, jumps } = await setup(0);
        player.components.set(PersLinkAcceptedRequestComponent, {
            target: "pers", missionId: "nova:141", sequence: 1,
        });
        world.step();
        expect(jumps).toEqual([]);
        expect(pers.components.get(PersComponent)!.state.alive).toBeTrue();
    });
});
