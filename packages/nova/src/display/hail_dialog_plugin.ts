import { EcsEvent } from 'nova_ecs/events';
import { Plugin } from 'nova_ecs/plugin';
import { Resource } from 'nova_ecs/resource';
import { World } from 'nova_ecs/world';
import { Subscription } from 'rxjs';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { ControlsSubject } from '../nova_plugin/controls_plugin.js';
import { DisabledComponent } from '../nova_plugin/disabled_component.js';
import { OwnerComponent } from '../nova_plugin/fire_weapon_plugin.js';
import { DisplayAssetDataResource, SimulationGameDataResource } from '../nova_plugin/game_data_resource.js';
import { GovtComponent } from '../nova_plugin/govt_component.js';
import {
    bribeAmount,
    canRequestAssistance,
    greetingText,
    hostileText,
    shipHailResponse,
    shipTakesBribes,
} from '../nova_plugin/hail.js';
import { HailAction } from '../nova_plugin/hail_plugin.js';
import { FuelComponent } from '../nova_plugin/health_plugin.js';
import { shipDisposition } from '../nova_plugin/iff_plugin.js';
import { FormationComponent, NpcComponent } from '../nova_plugin/npc_ai_plugin.js';
import { PersComponent } from '../nova_plugin/pers_plugin.js';
import { PlanetDataComponent, PlanetTargetComponent } from '../nova_plugin/planet_plugin.js';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin.js';
import { CreditsComponent } from '../nova_plugin/player_state_plugin.js';
import { LegalRecordsComponent } from '../nova_plugin/reputation_plugin.js';
import { ShipDataComponent } from '../nova_plugin/ship_plugin.js';
import { TargetComponent } from '../nova_plugin/target_component.js';
import { MenuControls } from '../spaceport/menu_controls.js';
import { EscortCommandName, HailContext, HailDialog } from '../spaceport/hail_dialog.js';
import { ScreenSize } from './screen_size_plugin.js';
import { Stage } from './stage_resource.js';

/**
 * Opens the communications (hail) dialog with the 'hail' key ('y') while in
 * flight. Mirrors mission_info_plugin: pull resources, add the dialog to the
 * stage, subscribe to the control, and open a modal overlay on the shared
 * MenuControls focus stack.
 *
 * Everything the dialog can DO to the simulation is dispatched as a display-
 * world event that browser.ts forwards to the deterministic bridge:
 *  - HailRequestEvent  -> bridge.hail(action)          (assist / bribe)
 *  - HailEscortCommandEvent -> bridge.controlEvents(...) (escort orders)
 * The dialog itself never touches the sim, keeping every effect on the
 * input-record path that all peers replay identically.
 *
 * ESCORT-CAPTURE SEAM: hailing a captured escort (hail_escort_upgrading /
 * captured / sell screens, PICTs tied to boarding) is out of scope — boarding
 * is a sibling agent's task. The escort variant here offers only the command
 * buttons; capture-dependent options are omitted until boarding lands.
 */

const HailDialogResource = new Resource<HailDialog>('HailDialog');
const HailControlsSubscription =
    new Resource<Subscription>('HailControlsSubscription');

/** Fired when a hail dialog action needs a deterministic sim effect. */
export const HailRequestEvent =
    new EcsEvent<{ action: HailAction }>('HailRequestEvent');
/** Fired when an escort comm button issues an escort command. */
export const HailEscortCommandEvent =
    new EcsEvent<{ command: EscortCommandName }>('HailEscortCommandEvent');

function getPlayerShip(world: World) {
    for (const [uuid, entity] of world.entities) {
        if (entity.components.has(PlayerShipSelector)) {
            return { uuid, entity };
        }
    }
    return undefined;
}

/** Whether the player ship is disabled or low on fuel (assist gate). */
function playerNeedsHelp(entity: ReturnType<typeof getPlayerShip>): boolean {
    if (!entity) {
        return false;
    }
    if (entity.entity.components.has(DisabledComponent)) {
        return true;
    }
    const fuel = entity.entity.components.get(FuelComponent);
    return !!fuel && fuel.current < fuel.max && fuel.current < 100;
}

/**
 * Computes the dialog context for the player's current target (ship or, if no
 * ship is targeted, the selected planet). Returns undefined when there is
 * nothing to hail. Async: loads govt / pers game data.
 */
async function computeContext(world: World,
    gameData: SimulationGameDataInterface):
    Promise<{ context: HailContext, target: string, isEscort: boolean }
        | undefined> {
    const player = getPlayerShip(world);
    if (!player) {
        return undefined;
    }
    const playerGovt = player.entity.components.get(GovtComponent)?.id
        ? await gameData.data.Govt.get(
            player.entity.components.get(GovtComponent)!.id).catch(() => undefined)
        : undefined;
    const playerRecords = player.entity.components.get(LegalRecordsComponent);
    const credits = player.entity.components.get(CreditsComponent)?.credits ?? 0;

    const shipTargetUuid = player.entity.components.get(TargetComponent)?.target;
    const shipTarget = shipTargetUuid
        ? world.entities.get(shipTargetUuid) : undefined;

    if (shipTargetUuid && shipTarget) {
        const govtId = shipTarget.components.get(GovtComponent)?.id;
        const govt = govtId
            ? await gameData.data.Govt.get(govtId).catch(() => undefined)
            : undefined;
        // PersComponent carries the resolved name; the pers RECORD (comm
        // quote / hail pict) is fetched by id when present.
        const persComponent = shipTarget.components.get(PersComponent);
        const pers = persComponent
            ? await gameData.data.Pers.get(persComponent.id).catch(() => undefined)
            : undefined;
        const aiType = shipTarget.components.get(NpcComponent)?.aiType;
        const disposition = shipDisposition(govt, playerGovt, playerRecords);

        const shipData = shipTarget.components.get(ShipDataComponent);
        const image = pers?.hailPict
            ? `nova:${pers.hailPict}`
            : shipData?.pict ?? null;
        const heading = persComponent?.name
            || govt?.commName || shipData?.name || 'Unidentified ship';

        // Is this the player's own direct escort? (one parent hop)
        const parent = shipTarget.components.get(FormationComponent)?.leader
            ?? shipTarget.components.get(OwnerComponent)?.owner;
        const isEscort = parent === player.uuid;

        if (isEscort) {
            return {
                context: {
                    variant: 'escort', heading, image,
                    body: 'Standing by for your orders, captain.',
                    escortCommands: true,
                },
                target: shipTargetUuid, isEscort: true,
            };
        }

        const response = shipHailResponse(govt, disposition, aiType);
        if (response.kind === 'cantHail') {
            return {
                context: {
                    variant: 'ship', heading, image,
                    body: 'There is no response.',
                },
                target: shipTargetUuid, isEscort: false,
            };
        }
        if (response.kind === 'hostile') {
            const largerBribes = !!govt?.flags.largerBribes;
            const amount = bribeAmount(credits, largerBribes);
            const bribe = response.canBribe
                ? { amount, canAfford: credits >= amount && amount > 0 }
                : undefined;
            return {
                context: {
                    variant: 'ship', heading, image,
                    body: pers?.commQuote?.trim()
                        ? pers.commQuote : hostileText(govt?.commName),
                    bribe,
                },
                target: shipTargetUuid, isEscort: false,
            };
        }
        // Ordinary greeting.
        const body = greetingText({
            persCommQuote: pers?.commQuote,
            govtCommName: govt?.commName,
            talkative: response.talkative,
        }) || 'There is no response.';
        const assist = canRequestAssistance({
            disposition, playerNeedsHelp: playerNeedsHelp(player), govt,
        }) ? { free: !!govt?.flags2.roadsideAssistance } : undefined;
        return {
            context: {
                variant: 'ship', heading, image, body, assist,
            },
            target: shipTargetUuid, isEscort: false,
        };
    }

    // No ship targeted: try the selected planet.
    const planetTargetUuid =
        player.entity.components.get(PlanetTargetComponent)?.target;
    const planetTarget = planetTargetUuid
        ? world.entities.get(planetTargetUuid) : undefined;
    if (planetTargetUuid && planetTarget) {
        const planetData = planetTarget.components.get(PlanetDataComponent);
        const govt = planetData?.govt
            ? await gameData.data.Govt.get(planetData.govt).catch(() => undefined)
            : undefined;
        const disposition = shipDisposition(govt, playerGovt, playerRecords);
        const heading = planetData?.name || 'Spaceport';
        const image = planetData?.landingPict
            ? planetData.landingPict : null;
        // No landing-DENIAL concept yet, so this is informational: a friendly
        // port clears you to land; a hostile one is noted (planet bribes are
        // a documented seam — see the plugin's module comment).
        const body = disposition === 'hostile'
            ? `${heading} refuses to answer your hail.`
            : `${heading} spaceport control: you are cleared to land.`;
        return {
            context: { variant: 'planet', heading, image, body },
            target: planetTargetUuid, isEscort: false,
        };
    }

    return undefined;
}

export const HailDialogPlugin: Plugin = {
    name: 'HailDialogPlugin',
    build(world) {
        const simulationData = world.resources.get(SimulationGameDataResource);
        const displayAssets = world.resources.get(DisplayAssetDataResource);
        const controls = world.resources.get(ControlsSubject);
        const stage = world.resources.get(Stage);
        const screenSize = world.resources.get(ScreenSize);
        if (!simulationData || !displayAssets || !controls || !stage
            || !screenSize) {
            throw new Error('HailDialogPlugin missing a required resource');
        }

        let currentTarget: string | undefined;
        let currentIsEscort = false;
        const dialog = new HailDialog(displayAssets, controls, {
            requestAssistance: () => {
                if (currentTarget) {
                    world.emit(HailRequestEvent, {
                        action: {
                            kind: 'requestAssistance', target: currentTarget,
                        },
                    });
                }
            },
            bribe: () => {
                if (currentTarget) {
                    world.emit(HailRequestEvent,
                        { action: { kind: 'bribe', target: currentTarget } });
                }
            },
            escortCommand: (command: EscortCommandName) => {
                if (currentIsEscort) {
                    world.emit(HailEscortCommandEvent, { command });
                }
            },
        });
        stage.addChild(dialog.container);
        world.resources.set(HailDialogResource, dialog);
        if (typeof window !== 'undefined') {
            (window as unknown as { novaHailDialog: HailDialog })
                .novaHailDialog = dialog;
        }

        let opening = false;
        const openHail = async (): Promise<void> => {
            if (dialog.container.visible || opening) {
                return;
            }
            opening = true;
            try {
                const computed = await computeContext(world, simulationData);
                if (!computed) {
                    return;
                }
                currentTarget = computed.target;
                currentIsEscort = computed.isEscort;
                // Re-add to move above later-added containers (spaceport).
                stage.addChild(dialog.container);
                dialog.container.position.set(
                    screenSize.x / 2, screenSize.y / 2);
                await dialog.show(computed.context);
            } finally {
                opening = false;
            }
        };

        world.resources.set(HailControlsSubscription,
            controls.subscribe(({ action, state }) => {
                if (action !== 'hail' || state !== 'start') {
                    return;
                }
                // A landed menu / other modal owns the keyboard: stand down.
                if (MenuControls.focused) {
                    return;
                }
                void openHail();
            }));
    },
    remove(world) {
        world.resources.get(HailControlsSubscription)?.unsubscribe();
        const stage = world.resources.get(Stage);
        const dialog = world.resources.get(HailDialogResource);
        if (stage && dialog) {
            stage.removeChild(dialog.container);
        }
        world.resources.delete(HailControlsSubscription);
        world.resources.delete(HailDialogResource);
    },
};
