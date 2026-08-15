import { Entity } from 'nova_ecs/entity';
import { EcsEvent } from 'nova_ecs/events';
import { Plugin } from 'nova_ecs/plugin';
import { Resource } from 'nova_ecs/resource';
import { World } from 'nova_ecs/world';
import { Subscription } from 'rxjs';
import { SimulationGameDataInterface } from '../client/gamedata/simulation_game_data.js';
import { ControlsSubject } from '../nova_plugin/controls_plugin.js';
import { DisabledComponent } from '../nova_plugin/disabled_component.js';
import { escortParent } from '../nova_plugin/escort_command_plugin.js';
import { SourceComponent } from '../nova_plugin/fire_weapon_plugin.js';
import { DisplayAssetDataResource, SimulationGameDataResource } from '../nova_plugin/game_data_resource.js';
import { GovtComponent } from '../nova_plugin/govt_component.js';
import {
    bribeAmount,
    busyResponseText,
    BUSY_RESPONSE_FALLBACK,
    canRequestAssistance,
    greetingText,
    HAIL_RESPONSE_TABLE,
    hashString,
    hostileText,
    shipHailResponse,
    shipIsFighting,
    shipTakesBribes,
} from '../nova_plugin/hail.js';
import { DisplayAssetDataInterface } from '../client/gamedata/display_asset_data.js';
import { HailAction } from '../nova_plugin/hail_plugin.js';
import { SoundEvent } from '../nova_plugin/sound_plugin.js';
import { FuelComponent } from '../nova_plugin/health_plugin.js';
import { shipDisposition } from '../nova_plugin/iff_plugin.js';
import { NpcComponent } from '../nova_plugin/npc_ai_plugin.js';
import { ShootAllWeaponsComponent } from '../nova_plugin/npc_plugin.js';
import { PersComponent } from '../nova_plugin/pers_plugin.js';
import { PlanetDataComponent, PlanetTargetComponent } from '../nova_plugin/planet_plugin.js';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin.js';
import { CreditsComponent } from '../nova_plugin/player_state_plugin.js';
import { LegalRecordsComponent } from '../nova_plugin/reputation_plugin.js';
import { ShipDataComponent } from '../nova_plugin/ship_plugin.js';
import { TargetComponent } from '../nova_plugin/target_component.js';
import { MenuControls } from '../spaceport/menu_controls.js';
import { HailContext, HailDialog } from '../spaceport/hail_dialog.js';
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
 * The dialog itself never touches the sim, keeping every effect on the
 * input-record path that all peers replay identically.
 *
 * ESCORT COMM: the escort variant is a hired-escort MANAGEMENT dialog
 * (Upgrade / Sell / Release / Close Channel per hail/hail_escort.png), not a
 * fleet-command panel — commanding escorts is the keyboard escort-controls'
 * job. Upgrade / Sell / Release all depend on unmodeled state (shipyard
 * upgrade transfer, escort resale value, per-escort release — a future
 * per-escort-control feature) and render as greyed seams; only Close Channel
 * is live, so the escort dialog issues NO simulation effect today.
 */

const HailDialogResource = new Resource<HailDialog>('HailDialog');
const HailControlsSubscription =
    new Resource<Subscription>('HailControlsSubscription');

/** Fired when a hail dialog action needs a deterministic sim effect. */
export const HailRequestEvent =
    new EcsEvent<{ action: HailAction }>('HailRequestEvent');

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
 * Whether a hailed ship is busy fighting, read off the same synced components
 * the simulation's applyHail reads (hail_plugin.ts) and passed through the one
 * shared predicate, so the dialog's answer and the sim's refusal agree.
 */
export function targetIsFighting(target: Entity): boolean {
    return shipIsFighting({
        npcMode: target.components.get(NpcComponent)?.mode,
        npcTarget: target.components.get(TargetComponent)?.target,
        shootsAllWeapons: target.components.has(ShootAllWeaponsComponent),
    });
}

/**
 * What pressing "Request Assistance" gets: the ship's refusal line when it is
 * busy fighting, or undefined when the request should be dispatched to the
 * simulation.
 *
 * Evaluated at the moment of the press (not when the channel was opened) so a
 * ship that got into a fight while the dialog was up still answers honestly.
 * The simulation's applyHail re-checks the SAME predicate over the SAME synced
 * components and is the authority; this exists so the player SEES the refusal
 * instead of pressing a button that silently does nothing.
 */
export function assistRefusal(world: World, targetUuid: string | undefined,
    busyText: string): string | undefined {
    if (!targetUuid) {
        return undefined;
    }
    const target = world.entities.get(targetUuid);
    return target && targetIsFighting(target) ? busyText : undefined;
}

/**
 * The busy-refusal line for a hailed ship, resolved from STR# 3000 (the stock
 * comm-response table) ahead of time, because the assist button's handler is
 * synchronous. Seeded by the ship's uuid so the line is stable per encounter
 * and identical on every peer. Falls back to the pinned literal if the table
 * is unavailable, exactly as noShipsForHire does (spaceport/hire_escort.ts).
 */
async function resolveBusyText(
    displayAssets: DisplayAssetDataInterface | undefined,
    targetUuid: string): Promise<string> {
    if (!displayAssets) {
        return BUSY_RESPONSE_FALLBACK;
    }
    try {
        const table =
            await displayAssets.data.StringTable.get(HAIL_RESPONSE_TABLE);
        return busyResponseText(table.strings, hashString(targetUuid));
    } catch {
        return BUSY_RESPONSE_FALLBACK;
    }
}

/**
 * Computes the dialog context for the player's current target (ship or, if no
 * ship is targeted, the selected planet). Returns undefined when there is
 * nothing to hail. Async: loads govt / pers game data.
 *
 * `busyText` is the line the ship answers an assistance request with IF it
 * turns out to be busy when the player presses the button (the press itself
 * is what decides — see the plugin's requestAssistance callback).
 */
/**
 * The identity block for the ship comm's LOWER well (PICT 8511's second
 * black box), built the way the references fill it:
 *
 *   hail.png          "Class: Terrapin"
 *   hail_hostile.png  "Class: Fed Destroyer" / "(Federation)" /
 *                     "Status: Hostile"
 *
 * A përs is named instead of classed (the original titles a named captain by
 * name); the government line and the Status line only appear when there is
 * something to say. Pure, so the wording is pinned in specs.
 */
export function shipIdentityBlock({ persName, shipClass, govtName, hostile }: {
    persName?: string, shipClass?: string, govtName?: string, hostile: boolean,
}): string {
    const lines: string[] = [];
    if (persName) {
        lines.push(persName);
    } else {
        lines.push(`Class: ${shipClass || 'Unidentified ship'}`);
    }
    if (govtName) {
        lines.push(`(${govtName})`);
    }
    if (hostile) {
        lines.push('Status: Hostile');
    }
    return lines.join('\n');
}

export async function computeContext(world: World,
    gameData: SimulationGameDataInterface,
    displayAssets?: DisplayAssetDataInterface):
    Promise<{
        context: HailContext, target: string, isEscort: boolean,
        busyText: string,
    } | undefined> {
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
        // Behavioral hostility: a ship whose AI is attacking the player is
        // hostile regardless of politics — the same rule the target corners
        // use (iff_plugin's targetCornerStyle), including the legacy dev-enemy
        // ShootAllWeapons marker. Read from the same synced components the sim
        // reads so the dialog and applyHail agree on the outcome.
        const targetsPlayer = shipTarget.components
            .get(TargetComponent)?.target === player.uuid;
        const shipNpcMode = shipTarget.components.get(NpcComponent)?.mode;
        const attackingPlayer = targetsPlayer && (shipNpcMode === 'attack'
            || shipTarget.components.has(ShootAllWeaponsComponent));

        const shipData = shipTarget.components.get(ShipDataComponent);
        // pers.hailPict is ALREADY a global id (the parser emits e.g.
        // "nova:4001"), so it must NOT be re-prefixed. Fall back to the ship's
        // own pict when the pers has no custom portrait.
        const image = pers?.hailPict ?? shipData?.pict ?? null;
        const heading = shipIdentityBlock({
            persName: persComponent?.name,
            shipClass: shipData?.name,
            govtName: govt?.commName,
            hostile: disposition === 'hostile' || attackingPlayer,
        });

        // Is this the player's own direct escort? (one parent hop) Carrier-bay
        // fighters ALSO have a parent link pointed at the player, so they'd
        // match here too — but they are NOT
        // hired escorts and have no management dialog. The discriminator is
        // SourceComponent: bay fighters set it (bay_plugin), hired escorts
        // (spawnHiredEscorts) and captures (convertToEscort) do not.
        // This reads the DISPLAY world, so SourceComponent has to be
        // serializer-registered (fire_weapon_plugin's build) to be here at
        // all — the bridge mirrors nothing else. Unregistered, this test
        // was always false and every bay fighter came back "Hired Escort:".
        // escortParent, not a fourth private copy of the parent chain: the
        // playtest bug where a captured prize "says it is my escort" but
        // took no orders was exactly these predicates disagreeing, so the
        // hail dialog asks the same question the command system does.
        const isOwnFlock = escortParent(shipTarget) === player.uuid;
        const isBayFighter = shipTarget.components.has(SourceComponent);
        const isEscort = isOwnFlock && !isBayFighter;

        if (isOwnFlock && isBayFighter) {
            // A carrier-launched fighter from the player's own bay: label it as
            // such (not "Hired Escort:") and show no management buttons — a bay
            // fighter has no salary, upgrade price, or resale value to manage.
            const fighterName = shipData?.name || 'Fighter';
            const fighterClass = shipData?.subtitle?.trim();
            return {
                context: {
                    variant: 'escort', image,
                    // The whole identity block goes in the LOWER well, the way
                    // hail_escort.png stacks "Hired Escort: / Terrapin /
                    // Standard" there. The UPPER well is the reference's
                    // Upgrade Cost / daily Pay readout, which has no backing
                    // state here (documented content gap) — so it stays empty
                    // rather than borrowing the identity lines.
                    heading: fighterClass
                        ? `Fighter:\n ${fighterName}\n ${fighterClass}`
                        : `Fighter:\n ${fighterName}`,
                    body: '',
                },
                target: shipTargetUuid, isEscort: false,
                busyText: BUSY_RESPONSE_FALLBACK,
            };
        }

        if (isEscort) {
            // Hired-escort management box (hail/hail_escort.png). The LOWER
            // well holds the whole identity block — "Hired Escort:" over the
            // escort's ship name and class subtitle, indented exactly as the
            // reference indents them. The UPPER well is the reference's
            // Upgrade Cost / daily Pay readout; NovaJS models neither an
            // escort salary nor an upgrade price, so it stays EMPTY (a
            // documented content gap) and the buttons carry the seam story.
            const escortName = shipData?.name || 'Escort';
            const escortClass = shipData?.subtitle?.trim();
            return {
                context: {
                    variant: 'escort', image,
                    heading: escortClass
                        ? `Hired Escort:\n ${escortName}\n ${escortClass}`
                        : `Hired Escort:\n ${escortName}`,
                    body: '',
                    escort: true,
                },
                target: shipTargetUuid, isEscort: true,
                busyText: BUSY_RESPONSE_FALLBACK,
            };
        }

        const response = shipHailResponse(govt, disposition, aiType,
            attackingPlayer);
        if (response.kind === 'cantHail') {
            return {
                context: {
                    variant: 'ship', heading, image,
                    body: 'There is no response.',
                },
                target: shipTargetUuid, isEscort: false,
                busyText: BUSY_RESPONSE_FALLBACK,
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
                busyText: BUSY_RESPONSE_FALLBACK,
            };
        }
        // Ordinary greeting: a përs quote, else a real line from the govt's
        // greeting STR# picked deterministically by the target's uuid (stable
        // per encounter and across peers), else a synthetic fallback.
        const body = greetingText({
            persCommQuote: pers?.commQuote,
            govtGreetings: govt?.commGreetings,
            govtCommName: govt?.commName,
            talkative: response.talkative,
            seed: hashString(shipTargetUuid),
        }) || 'There is no response.';
        const assist = canRequestAssistance({
            disposition, playerNeedsHelp: playerNeedsHelp(player), govt,
            attackingPlayer,
        }) ? { free: !!govt?.flags2.roadsideAssistance } : undefined;
        // The OFFER is not withdrawn for a ship that happens to be fighting:
        // the player asks and is told "I'm busy", exactly as the original's
        // comm dialog answers with a line from the response table. Only the
        // line is resolved here (the press decides whether it is used), and
        // only when there is an offer to refuse.
        const busyText = assist
            ? await resolveBusyText(displayAssets, shipTargetUuid)
            : BUSY_RESPONSE_FALLBACK;
        return {
            context: {
                variant: 'ship', heading, image, body, assist,
            },
            target: shipTargetUuid, isEscort: false, busyText,
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
            busyText: BUSY_RESPONSE_FALLBACK,
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
        let currentBusyText = BUSY_RESPONSE_FALLBACK;
        const dialog = new HailDialog(displayAssets, controls, {
            requestAssistance: () => {
                if (!currentTarget) {
                    return undefined;
                }
                // BUSY SHIPS REFUSE, and nothing is dispatched for them —
                // the ship's combat behavior is left completely untouched.
                const refusal = assistRefusal(world, currentTarget,
                    currentBusyText);
                if (refusal !== undefined) {
                    return refusal;
                }
                world.emit(HailRequestEvent, {
                    action: {
                        kind: 'requestAssistance', target: currentTarget,
                    },
                });
                return undefined;
            },
            bribe: () => {
                if (currentTarget) {
                    world.emit(HailRequestEvent,
                        { action: { kind: 'bribe', target: currentTarget } });
                }
            },
            // Local client UI beep through the shared display audio path
            // (SoundEvent → SoundSystem); no simulation involvement.
            playSound: (id: string) => world.emit(SoundEvent, { id }),
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
                const computed = await computeContext(world, simulationData,
                    displayAssets);
                if (!computed) {
                    return;
                }
                currentTarget = computed.target;
                currentBusyText = computed.busyText;
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
