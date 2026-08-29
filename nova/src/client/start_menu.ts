import {
    createInitialPlayerState,
    PlayerData,
    PlayerQuarantine,
    PlayerState,
    PlayerSnapshotSummary,
} from '../nova_plugin/player_state';
import { EncodedEntity } from 'nova_ecs/plugins/serializer_plugin';
import type { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { artworkUrl } from './artwork_url';
import { showEnteringOverlay } from '../display/flight_load_overlay';
import {
    CompatibilityProfileName,
    PANEL_STYLE,
    RetailMenuDialogs,
    canEnterShip,
    containDialogFocus,
    makeThemedButton,
} from './start_menu_dialogs';
import {
    RETAIL_LOGO_FRAME_DURATION_MS,
    nextLogoFrameDeadline,
    nextLogoFrame,
} from './menu_logo_timing';
import {
    MenuRolloverEvent,
    MenuRolloverState,
    PilotStatBlock,
    PilotTargetPictureCache,
    RetailMenuAction,
    buildPilotStatBlock,
    menuRolloverFrame,
    nextMenuRolloverState,
    requestPilotTargetPicture,
} from './start_menu_model';

export interface StartMenuSelection {
    playerState: PlayerState;
    ship?: EncodedEntity;
    continued: boolean;
}

export type RestoreSnapshot = (
    snapshotId: string,
) => Promise<PlayerData | undefined>;

export interface StartMenuOptions {
    compatibilityProfile?: CompatibilityProfileName;
    controls?: unknown;
}

const DESIGN_WIDTH = 1024;
const DESIGN_HEIGHT = 768;
const LOGO_FRAME_HEIGHT = 209;
const ROLLOVER_WIDTH = 136;
const ROLLOVER_HEIGHT = 98;
const INITIAL_PLAYER_STATE = createInitialPlayerState();
export const PILOT_STATS_RED = '#98000e';
export const PILOT_TARGET_PICT_SLOT = {
    left: 458,
    top: 646,
    width: 112,
    height: 56,
} as const;

export function pilotDeathNotice(
    state: PlayerState | undefined,
): string | undefined {
    return state?.diedAt === undefined
        ? undefined
        : 'PILOT DECEASED — LOAD A SAVED PILOT OR CREATE A NEW PILOT';
}

export function pilotQuarantineNotice(
    quarantine: PlayerQuarantine | undefined,
): string | undefined {
    if (quarantine === 'record') {
        return 'THIS PILOT\'S SAVE COULD NOT BE READ — NOTHING WAS DELETED. '
            + 'OPEN A SAVED PILOT, AND PLEASE REPORT THIS.';
    }
    if (quarantine === 'file') {
        return 'PILOT DATA COULD NOT BE READ — NOTHING WAS DELETED, BUT '
            + 'NOTHING CAN BE SAVED. PLEASE REPORT THIS.';
    }
    return undefined;
}

export function isStartMenuActionDisabled(
    action: RetailMenuAction,
    state: PlayerState | undefined,
    quarantine: PlayerQuarantine | undefined,
): boolean {
    const blocked = quarantine === 'record' || quarantine === 'file';
    if (blocked && (action === 'New Pilot' || action === 'Enter Ship')) {
        return true;
    }
    return action === 'Enter Ship' && !canEnterShip(state);
}

const RETAIL_BUTTON_SPECS = [
    ['New Pilot', '8050', 120, 61, 349, 400],
    ['Open Pilot', '8051', 99, 60, 344, 464],
    ['Quit Nova', '8052', 100, 60, 345, 528],
    ['Enter Ship', '8053', 120, 60, 555, 401],
    ['Set Prefs', '8054', 99, 61, 581, 464],
    ['About Nova', '8055', 98, 60, 580, 528],
] as const;

function retailRolloverPosition(): { left: number; top: number } {
    const left = Math.min(...RETAIL_BUTTON_SPECS.map(spec => spec[4]));
    const right = Math.max(
        ...RETAIL_BUTTON_SPECS.map(spec => spec[4] + spec[2]),
    );
    const top = Math.min(...RETAIL_BUTTON_SPECS.map(spec => spec[5]));
    const bottom = Math.max(
        ...RETAIL_BUTTON_SPECS.map(spec => spec[5] + spec[3]),
    );
    return {
        left: Math.round((left + right - ROLLOVER_WIDTH) / 2),
        top: Math.round((top + bottom - ROLLOVER_HEIGHT) / 2),
    };
}

const MENU_STYLE = `
    position: fixed; inset: 0; z-index: 1000; overflow: hidden;
    color: #f4f0e4; font-family: Charcoal, Geneva, Arial, sans-serif;
    background: #000;
`;

type RetailMenuAssets = {
    background: string;
    logo: string;
    logoFrameCount: number;
    buttons: Record<string, string>;
    rollover?: string;
};

type RetailMenuLoad = {
    assets: RetailMenuAssets;
    rollover: Promise<string | undefined>;
};

export type RetailMenuAssetStatus = 'loading' | 'ready' | 'unavailable';

export function menuPresentationForRetailAssets(
    status: RetailMenuAssetStatus,
): 'fallback' | 'retail' {
    return status === 'ready' ? 'retail' : 'fallback';
}

function preloadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
            void image.decode().then(() => resolve(image)).catch(reject);
        };
        image.onerror = () =>
            reject(new Error(`Failed to load menu artwork: ${url}`));
        image.src = url;
    });
}

async function loadRetailMenuAssets(
    gameData: GameDataInterface | undefined,
): Promise<RetailMenuLoad | undefined> {
    if (!gameData) {
        return undefined;
    }

    try {
        const ids = await gameData.ids;
        const has = (type: 'PictImage' | 'SpriteSheetImage', id: string) =>
            (ids as unknown as Record<string, string[]>)[type]?.includes(id)
            ?? false;
        const buttonIds = ['8050', '8051', '8052', '8053', '8054', '8055'];
        if (!has('PictImage', 'nova:8000')
            || !has('PictImage', 'nova:8010')
            || buttonIds.some(id => !has('SpriteSheetImage', `nova:${id}`))) {
            return undefined;
        }
        const assets = {
            background: artworkUrl('PictImage', 'nova:8000'),
            logo: artworkUrl('PictImage', 'nova:8010'),
            logoFrameCount: 1,
            buttons: Object.fromEntries(buttonIds.map(id => [
                id, artworkUrl('SpriteSheetImage', `nova:${id}`),
            ])),
            rollover: undefined as string | undefined,
        };
        const rollover = has('SpriteSheetImage', 'nova:8020')
            ? artworkUrl('SpriteSheetImage', 'nova:8020')
            : undefined;
        const [, logoImage] = await Promise.all([
            preloadImage(assets.background),
            preloadImage(assets.logo),
            ...Object.values(assets.buttons).map(preloadImage),
        ]);
        assets.logoFrameCount = Math.max(
            1,
            Math.floor(logoImage.naturalHeight / LOGO_FRAME_HEIGHT),
        );
        const rolloverLoad = rollover
            ? preloadImage(rollover)
                .then(() => rollover)
                .catch(() => undefined)
            : Promise.resolve(undefined);
        return { assets, rollover: rolloverLoad };
    } catch {
        // A server without the retail data should retain the usable DOM menu.
        return undefined;
    }
}

function makeRetailButton(
    text: RetailMenuAction,
    spriteUrl: string,
    width: number,
    height: number,
    x: number,
    y: number,
    onRollover?: (event: MenuRolloverEvent) => void,
): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.setAttribute('aria-label', text);
    button.title = text;
    button.style.cssText = `
      position: absolute; left: ${x}px; top: ${y}px;
      width: ${width}px; height: ${height}px; padding: 0;
      overflow: hidden; border: 0; border-radius: 0; cursor: pointer;
      color: transparent; font-size: 0; text-indent: -10000px;
      background: transparent url("${spriteUrl}") 0 0 /
        ${width * 2}px auto no-repeat;
    `;
    const setFrame = (frame: number) => {
        if (!button.disabled) {
            button.style.backgroundPosition = `${-width * frame}px 0`;
        }
    };
    button.addEventListener('mouseenter', () => {
        setFrame(1);
        onRollover?.({ type: 'pointer-enter', action: text });
    });
    button.addEventListener('mouseleave', () => {
        setFrame(0);
        onRollover?.({ type: 'pointer-leave', action: text });
    });
    button.addEventListener('focus', () => {
        button.style.outline = '1px solid #e6c3a0';
        button.style.outlineOffset = '2px';
        setFrame(1);
        onRollover?.({ type: 'focus', action: text });
    });
    button.addEventListener('blur', () => {
        button.style.outline = '';
        button.style.outlineOffset = '';
        setFrame(0);
        onRollover?.({ type: 'blur', action: text });
    });
    button.addEventListener('mousedown', () => setFrame(1));
    button.addEventListener('mouseup', () => setFrame(1));
    return button;
}

export function makePilotStatBlockElement(
    stats: PilotStatBlock | undefined,
    deathNotice?: string,
): HTMLElement | undefined {
    if (!stats) {
        return undefined;
    }
    const section = document.createElement('section');
    section.dataset.pilotStats = '';
    section.setAttribute('aria-label', 'Pilot statistics');
    section.style.cssText = `
      position: absolute; left: 336px; top: 608px; width: 392px;
      display: grid; grid-template-columns: 145px 105px;
      justify-content: space-between; color: ${PILOT_STATS_RED};
      text-align: left; font: 10px/12px Geneva, Arial, sans-serif;
      text-shadow: 0 0 1px #280000;
    `;
    const makeColumn = (fields: readonly {
        label: string;
        value: string;
    }[]) => {
        const list = document.createElement('dl');
        list.style.cssText = 'margin: 0; padding: 0;';
        for (const field of fields) {
            const row = document.createElement('div');
            row.style.cssText = 'margin: 0 0 7px;';
            const label = document.createElement('dt');
            label.textContent = field.label;
            label.style.cssText = 'margin: 0; font-weight: 400;';
            const value = document.createElement('dd');
            value.textContent = field.value;
            value.style.cssText = 'margin: 0; font-weight: 400;';
            row.append(label, value);
            list.appendChild(row);
        }
        return list;
    };
    section.append(makeColumn(stats.left), makeColumn(stats.right));
    if (deathNotice) {
        const notice = document.createElement('p');
        notice.dataset.pilotDeath = '';
        notice.textContent = deathNotice;
        notice.style.cssText = `
          grid-column: 1 / -1; margin: 1px 0 0; color: ${PILOT_STATS_RED};
          font: 10px/12px Geneva, Arial, sans-serif;
        `;
        section.appendChild(notice);
    }
    return section;
}

/**
 * The menu remains DOM-based for keyboard and accessibility support. The
 * retail title screen is a 1024x768 composition: PICT 8000 is the background,
 * PICT 8010 is a seven-frame opaque logo animation, and the six button
 * sprites are placed using the cölr resource's original coordinates.
 */
export class StartMenu {
    private readonly root = document.createElement('div');
    private readonly scene = document.createElement('div');
    private readonly content = document.createElement('div');
    private logoAnimationFrame: number | undefined;
    private retailAssets: RetailMenuAssets | undefined;
    private retailAssetStatus: RetailMenuAssetStatus = 'loading';
    private dialogs: RetailMenuDialogs | undefined;
    private dialogCleanup: (() => void) | undefined;
    private menuRenderVersion = 0;
    private readonly targetPictImages =
        new PilotTargetPictureCache<HTMLImageElement>();
    private readonly resizeScene = () => {
        const scale = Math.min(
            window.innerWidth / DESIGN_WIDTH,
            window.innerHeight / DESIGN_HEIGHT,
        );
        this.scene.style.transform =
            `translate(-50%, -50%) scale(${scale})`;
    };

    constructor(
        private readonly gameData?: GameDataInterface,
        private readonly options: StartMenuOptions = {},
    ) {
        this.root.setAttribute('aria-label', 'Nova main menu');
        this.root.style.cssText = MENU_STYLE;
        this.scene.style.cssText = `
          position: absolute; left: 50%; top: 50%;
          width: ${DESIGN_WIDTH}px; height: ${DESIGN_HEIGHT}px;
          transform-origin: center center;
          background: #000 center / 100% 100% no-repeat;
        `;
        this.content.style.cssText = `
          position: absolute; inset: 0; text-align: center;
        `;
        this.scene.appendChild(this.content);
        this.root.appendChild(this.scene);
        document.body.appendChild(this.root);
        window.addEventListener('resize', this.resizeScene);
        this.resizeScene();
    }

    async show(
        playerData: PlayerData | undefined,
        restoreSnapshot?: RestoreSnapshot,
    ): Promise<StartMenuSelection> {
        let current = playerData?.playerState;
        let currentShip = playerData?.ship;
        const quarantine = playerData?.quarantine;
        let savedAt = playerData?.savedAt;
        let currentIsNew = false;
        const snapshots = playerData?.snapshots ?? [];
        return new Promise(resolvePromise => {
            let resolved = false;
            const resolve = (
                state: PlayerState,
                continued: boolean,
                ship?: EncodedEntity,
            ) => {
                if (resolved) {
                    return;
                }
                resolved = true;
                this.dialogs?.clear();
                this.dialogCleanup?.();
                const activeElement = document.activeElement;
                if (activeElement instanceof HTMLElement) {
                    activeElement.blur();
                }
                this.stopLogoAnimation();
                window.removeEventListener('resize', this.resizeScene);
                showEnteringOverlay();
                this.root.remove();
                resolvePromise({ playerState: state, ship, continued });
            };
            let showMainMenu: (focusLabel?: string) => void;
            const onNewPilotCreated = (state: PlayerState) => {
                current = state;
                currentShip = undefined;
                savedAt = undefined;
                currentIsNew = true;
                showMainMenu('New Pilot');
            };
            showMainMenu = (focusLabel?: string) => this.renderMainMenu(
                    current,
                    currentShip,
                    quarantine,
                    snapshots,
                    savedAt,
                    resolve,
                    !currentIsNew,
                    onNewPilotCreated,
                    showMainMenu,
                    focusLabel,
                );
            this.dialogs = new RetailMenuDialogs({
                content: this.content,
                compatibilityProfile:
                    this.options.compatibilityProfile ?? 'modern',
                controls: this.options.controls,
                restoreSnapshot,
                resolveSystemName: async systemId => {
                    try {
                        return (await this.gameData?.data.System.get(systemId))
                            ?.name;
                    } catch {
                        return undefined;
                    }
                },
                onBack: showMainMenu,
                onPilotSelected: (state, selectedAt, ship) => {
                    current = state;
                    currentShip = ship;
                    savedAt = selectedAt;
                    currentIsNew = false;
                    showMainMenu('Open Pilot');
                },
            });
            const upgradeVisibleMenu = () => {
                if (!this.root.isConnected
                    || !this.content.querySelector('[data-menu-action]')) {
                    return;
                }
                const activeElement = document.activeElement;
                const focusLabel = activeElement instanceof HTMLElement
                    && this.content.contains(activeElement)
                    ? activeElement.dataset.menuAction
                    : undefined;
                showMainMenu(focusLabel);
            };
            showMainMenu();
            void loadRetailMenuAssets(this.gameData).then(retailLoad => {
                if (!retailLoad) {
                    this.retailAssetStatus = 'unavailable';
                    return;
                }
                this.retailAssets = retailLoad.assets;
                this.retailAssetStatus = 'ready';
                upgradeVisibleMenu();
                void retailLoad.rollover.then(rollover => {
                    if (!rollover
                        || this.retailAssets !== retailLoad.assets) {
                        return;
                    }
                    retailLoad.assets.rollover = rollover;
                    upgradeVisibleMenu();
                });
            });
        });
    }

    private renderMainMenu(
        existing: PlayerState | undefined,
        existingShip: EncodedEntity | undefined,
        quarantine: PlayerQuarantine | undefined,
        snapshots: PlayerSnapshotSummary[],
        savedAt: number | undefined,
        resolve: (
            state: PlayerState,
            continued: boolean,
            ship?: EncodedEntity,
        ) => void,
        continued: boolean,
        onNewPilotCreated: (state: PlayerState) => void,
        showMainMenu: (focusLabel?: string) => void,
        focusLabel?: string,
    ) {
        const renderVersion = ++this.menuRenderVersion;
        this.dialogs?.clear();
        this.dialogCleanup?.();
        this.dialogCleanup = undefined;
        this.stopLogoAnimation();
        for (const artwork of this.scene.querySelectorAll(
            '[data-nova-menu-artwork]')) {
            artwork.remove();
        }
        this.content.replaceChildren();
        this.content.style.cssText = `
          position: absolute; inset: 0; text-align: center;
        `;
        const quarantineNotice = pilotQuarantineNotice(quarantine);
        if (menuPresentationForRetailAssets(this.retailAssetStatus) === 'retail'
            && this.retailAssets) {
            this.scene.style.backgroundImage =
                `url("${this.retailAssets.background}")`;
            const title = document.createElement('h1');
            title.dataset.novaMenuArtwork = '';
            title.textContent = 'Escape Velocity Nova';
            title.style.cssText = `
              position: absolute; width: 1px; height: 1px; padding: 0;
              margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0);
              white-space: nowrap; border: 0;
            `;
            const logo = document.createElement('div');
            logo.dataset.novaMenuArtwork = '';
            logo.dataset.novaLogo = '';
            logo.setAttribute('role', 'img');
            logo.setAttribute('aria-label', 'Escape Velocity Nova');
            logo.style.cssText = `
              position: absolute; left: 191px; top: 162px;
              width: 654px; height: ${LOGO_FRAME_HEIGHT}px;
              background: transparent url("${this.retailAssets.logo}") 0 0 /
                654px auto no-repeat;
            `;
            // PICT 8010 contains the background pixels around the logo. It is
            // opaque by design, so it must be drawn at cölr LogoX/LogoY
            // (191,162) rather than treated as a centered transparent image.
            let logoFrame = 0;
            let nextFrameAt: number | undefined;
            const displayLogoFrame = (frame: number, now: number) => {
                logo.style.backgroundPosition =
                    `0 -${frame * LOGO_FRAME_HEIGHT}px`;
                logo.dataset.logoFrame = String(frame);
                logo.dataset.logoTimestamp = String(now);
            };
            const advanceLogo = (now: number) => {
                nextFrameAt ??= now + RETAIL_LOGO_FRAME_DURATION_MS;
                if (now >= nextFrameAt) {
                    logoFrame = nextLogoFrame(
                        logoFrame,
                        Math.random(),
                        this.retailAssets?.logoFrameCount,
                    );
                    displayLogoFrame(logoFrame, now);
                    nextFrameAt = nextLogoFrameDeadline(
                        now,
                        nextFrameAt,
                        RETAIL_LOGO_FRAME_DURATION_MS,
                    );
                }
                this.logoAnimationFrame =
                    window.requestAnimationFrame(advanceLogo);
            };
            displayLogoFrame(logoFrame, performance.now());
            this.logoAnimationFrame = window.requestAnimationFrame(advanceLogo);
            this.scene.insertBefore(title, this.content);
            this.scene.insertBefore(logo, this.content);

            let rolloverState: MenuRolloverState = {};
            let rollover: HTMLDivElement | undefined;
            const displayRolloverFrame = () => {
                if (!rollover) {
                    return;
                }
                const frame = menuRolloverFrame(rolloverState);
                rollover.style.backgroundPosition =
                    `${-ROLLOVER_WIDTH * frame}px 0`;
                rollover.dataset.rolloverFrame = String(frame);
            };
            const updateRollover = (event: MenuRolloverEvent) => {
                rolloverState = nextMenuRolloverState(rolloverState, event);
                if (event.type === 'pointer-leave' || event.type === 'blur') {
                    // Browser transitions dispatch leave/blur before the next
                    // enter/focus. Rendering after that event pair prevents a
                    // one-frame flash of the idle art between buttons.
                    queueMicrotask(displayRolloverFrame);
                } else {
                    displayRolloverFrame();
                }
            };
            if (this.retailAssets.rollover) {
                const position = retailRolloverPosition();
                rollover = document.createElement('div');
                rollover.dataset.menuRollover = '';
                rollover.setAttribute('aria-hidden', 'true');
                rollover.style.cssText = `
                  position: absolute; left: ${position.left}px;
                  top: ${position.top}px; width: ${ROLLOVER_WIDTH}px;
                  height: ${ROLLOVER_HEIGHT}px; pointer-events: none;
                  background: transparent
                    url("${this.retailAssets.rollover}") 0 0 /
                    ${ROLLOVER_WIDTH * 7}px auto no-repeat;
                `;
                displayRolloverFrame();
                this.content.appendChild(rollover);
            }
            for (const [
                label, id, width, height, x, y,
            ] of RETAIL_BUTTON_SPECS) {
                const button = makeRetailButton(
                    label, this.retailAssets.buttons[id],
                    width, height, x, y,
                    rollover ? updateRollover : undefined);
                button.dataset.menuAction = label;
                button.disabled = isStartMenuActionDisabled(
                    label, existing, quarantine);
                if (id === '8050') {
                    if (button.disabled && quarantineNotice) {
                        button.title = quarantineNotice;
                    }
                    button.addEventListener('click', () => {
                        if (button.disabled) {
                            return;
                        }
                        this.menuRenderVersion++;
                        this.showNameEntry(
                            onNewPilotCreated,
                            () => showMainMenu('New Pilot'),
                        );
                    });
                } else if (id === '8051') {
                    button.title = 'Choose a saved pilot or snapshot';
                    button.addEventListener('click', () => {
                        this.menuRenderVersion++;
                        this.stopLogoAnimation(true);
                        this.dialogs?.showOpenPilot(
                            existing,
                            existingShip,
                            snapshots,
                            savedAt,
                        );
                    });
                } else if (id === '8052') {
                    button.addEventListener('click', () => {
                        this.menuRenderVersion++;
                        this.stopLogoAnimation(true);
                        this.dialogs?.showQuit();
                    });
                } else if (id === '8053') {
                    button.title = quarantineNotice
                        ?? pilotDeathNotice(existing)
                        ?? (existing
                            ? 'Enter the ship with the selected pilot'
                            : 'No saved pilot selected');
                    button.addEventListener('click', () => {
                        if (!button.disabled && canEnterShip(existing)) {
                            resolve(existing, continued, existingShip);
                        }
                    });
                } else if (id === '8054') {
                    button.addEventListener('click', () => {
                        this.menuRenderVersion++;
                        this.stopLogoAnimation(true);
                        this.dialogs?.showPreferences();
                    });
                } else if (id === '8055') {
                    button.addEventListener('click', () => {
                        this.menuRenderVersion++;
                        this.stopLogoAnimation(true);
                        this.dialogs?.showAbout();
                    });
                }
                if (button.disabled) {
                    button.style.opacity = '.48';
                    button.style.filter = 'grayscale(.8)';
                    button.style.cursor = 'default';
                }
                this.content.appendChild(button);
            }
            if (quarantineNotice) {
                const notice = document.createElement('p');
                notice.dataset.pilotQuarantine = '';
                notice.textContent = quarantineNotice;
                notice.style.cssText = `
                  position: absolute; left: 300px; top: 604px; width: 424px;
                  margin: 0; color: ${PILOT_STATS_RED};
                  font: 11px/14px Geneva, Arial, sans-serif;
                `;
                this.content.appendChild(notice);
            }
            void buildPilotStatBlock(existing, this.gameData)
                .then(stats => {
                    if (renderVersion !== this.menuRenderVersion
                        || !this.root.isConnected
                        || !this.content.querySelector('[data-menu-action]')) {
                        return;
                    }
                    if (!stats) {
                        return;
                    }
                    const statBlock = makePilotStatBlockElement(
                        stats,
                        pilotDeathNotice(existing),
                    );
                    if (statBlock) {
                        this.content.appendChild(statBlock);
                        void this.targetPictureFor(stats).then(image => {
                            if (!image
                                || renderVersion !== this.menuRenderVersion
                                || !this.root.isConnected
                                || !this.content.querySelector(
                                    '[data-menu-action]')) {
                                return;
                            }
                            this.content.appendChild(image);
                        });
                    }
                })
                .catch(() => {
                    // A malformed old save should not make the menu unusable.
                });
        } else {
            this.scene.style.backgroundImage = '';
            this.content.style.cssText = `
              position: absolute; inset: 0; display: flex;
              align-items: center; justify-content: center; text-align: center;
            `;
            const fallback = document.createElement('section');
            fallback.style.cssText =
                `${PANEL_STYLE} width: 420px; padding: 28px;`;
            const title = document.createElement('h1');
            title.textContent = 'Escape Velocity Nova';
            title.style.cssText = 'margin: 0 0 26px; letter-spacing: .08em;';
            fallback.appendChild(title);
            const deathNotice = pilotDeathNotice(existing);
            const noticeText = quarantineNotice ?? deathNotice;
            if (noticeText) {
                const notice = document.createElement('p');
                if (quarantineNotice) {
                    notice.dataset.pilotQuarantine = '';
                } else {
                    notice.dataset.pilotDeath = '';
                }
                notice.textContent = noticeText;
                notice.style.cssText = `
                  margin: -12px 0 20px; color: ${PILOT_STATS_RED};
                  font: 12px/15px Geneva, Arial, sans-serif;
                `;
                fallback.appendChild(notice);
            }
            const actions = document.createElement('div');
            actions.style.cssText = `
              display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
            `;
            const labels = [
                'New Pilot',
                'Enter Ship',
                'Open Pilot',
                'Set Prefs',
                'Quit Nova',
                'About Nova',
            ] as const;
            for (const label of labels) {
                const button = makeThemedButton(label);
                button.dataset.menuAction = label;
                button.disabled = isStartMenuActionDisabled(
                    label, existing, quarantine);
                if (button.disabled) {
                    button.title = quarantineNotice
                        ?? pilotDeathNotice(existing)
                        ?? 'No saved pilot selected';
                }
                button.addEventListener('click', () => {
                    if (label === 'New Pilot' && !button.disabled) {
                        this.menuRenderVersion++;
                        this.showNameEntry(
                            onNewPilotCreated,
                            () => showMainMenu('New Pilot'),
                        );
                    } else if (label === 'Enter Ship'
                        && !button.disabled
                        && canEnterShip(existing)) {
                        resolve(existing, continued, existingShip);
                    } else if (label === 'Open Pilot') {
                        this.menuRenderVersion++;
                        this.dialogs?.showOpenPilot(
                            existing,
                            existingShip,
                            snapshots,
                            savedAt,
                        );
                    } else if (label === 'Set Prefs') {
                        this.menuRenderVersion++;
                        this.dialogs?.showPreferences();
                    } else if (label === 'Quit Nova') {
                        this.menuRenderVersion++;
                        this.dialogs?.showQuit();
                    } else if (label === 'About Nova') {
                        this.menuRenderVersion++;
                        this.dialogs?.showAbout();
                    }
                });
                actions.appendChild(button);
            }
            fallback.appendChild(actions);
            this.content.appendChild(fallback);
        }
        if (focusLabel) {
            window.requestAnimationFrame(() => {
                const button = this.content.querySelector<HTMLButtonElement>(
                    `[data-menu-action="${focusLabel}"]`,
                );
                button?.focus();
            });
        }
    }

    private stopLogoAnimation(removeArtwork = false) {
        if (this.logoAnimationFrame !== undefined) {
            window.cancelAnimationFrame(this.logoAnimationFrame);
            this.logoAnimationFrame = undefined;
        }
        if (removeArtwork) {
            for (const artwork of this.scene.querySelectorAll(
                '[data-nova-menu-artwork]')) {
                artwork.remove();
            }
        }
    }

    private targetPictureFor(
        stats: PilotStatBlock,
    ): Promise<HTMLImageElement | undefined> {
        return this.targetPictImages.get(stats, current =>
            requestPilotTargetPicture(current, this.gameData)
                .then(async targetPict => {
                    if (!targetPict) {
                        return undefined;
                    }
                    const image = await preloadImage(
                        artworkUrl('PictImage', targetPict),
                    );
                    image.dataset.pilotTargetPict = targetPict;
                    image.alt = `${
                        current.left.find(
                            field => field.label === 'Ship Class',
                        )?.value ?? 'Pilot ship'
                    } targeting silhouette`;
                    image.style.cssText = `
                      position: absolute;
                      left: ${PILOT_TARGET_PICT_SLOT.left
                        + PILOT_TARGET_PICT_SLOT.width / 2}px;
                      top: ${PILOT_TARGET_PICT_SLOT.top
                        + PILOT_TARGET_PICT_SLOT.height / 2}px;
                      width: auto; height: auto;
                      max-width: ${PILOT_TARGET_PICT_SLOT.width}px;
                      max-height: ${PILOT_TARGET_PICT_SLOT.height}px;
                      transform: translate(-50%, -50%);
                      object-fit: contain; pointer-events: none;
                    `;
                    return image;
                })
                .catch(() => undefined),
        );
    }

    private showNameEntry(
        onCreated: (state: PlayerState) => void,
        showMainMenu: () => void,
    ) {
        this.dialogs?.clear();
        this.dialogCleanup?.();
        this.dialogCleanup = undefined;
        this.stopLogoAnimation();
        this.content.replaceChildren();
        const dialog = document.createElement('section');
        dialog.tabIndex = -1;
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-label', 'Create new pilot');
        dialog.style.cssText = `
          position: absolute; left: 272px; top: 334px; width: 480px;
          padding: 19px 25px 22px; text-align: center; ${PANEL_STYLE}
        `;
        const heading = document.createElement('h2');
        heading.textContent = 'NEW PILOT';
        heading.style.cssText = `
          margin: 0 0 5px; color: #f0d4be; font-size: 22px;
          letter-spacing: .12em; text-shadow: 2px 2px #180000;
        `;
        const subtitle = document.createElement('p');
        subtitle.textContent = 'Enter your name, Captain';
        subtitle.style.cssText = `
          margin: 0 0 15px; color: #d7d1c1;
          font: 14px Geneva, Arial, sans-serif;
        `;
        const input = document.createElement('input');
        input.type = 'text';
        input.maxLength = 32;
        input.autocomplete = 'off';
        input.placeholder = 'Pilot name';
        input.value = INITIAL_PLAYER_STATE.pilotName;
        input.style.cssText = `
          box-sizing: border-box; width: 100%; height: 43px; margin: 0 0 17px;
          padding: 7px 12px; color: #fff8e8; caret-color: #f0c2a2;
          background: linear-gradient(#080606, #1c0c0b);
          border: 1px solid #a29b8d; border-radius: 2px;
          outline: 0; font: 18px Geneva, Arial, sans-serif;
          box-shadow: inset 0 2px 7px #000, 0 1px 0 rgba(255, 255, 255, .25);
        `;
        input.addEventListener('focus', () => {
            input.style.borderColor = '#dd8a66';
            input.style.boxShadow =
                'inset 0 2px 7px #000, 0 0 0 2px rgba(148, 44, 30, .55)';
        });
        input.addEventListener('blur', () => {
            input.style.borderColor = '#a29b8d';
            input.style.boxShadow =
                'inset 0 2px 7px #000, 0 1px 0 rgba(255, 255, 255, .25)';
        });
        const launch = makeThemedButton('Launch');
        const cancel = makeThemedButton('Back');
        const actions = document.createElement('div');
        actions.style.cssText = `
          display: flex; justify-content: center; gap: 14px;
        `;
        launch.style.minWidth = '150px';
        cancel.style.minWidth = '150px';
        actions.append(launch, cancel);
        dialog.append(heading, subtitle, input, actions);
        this.content.appendChild(dialog);
        input.focus();
        const submit = () => {
            const state = createInitialPlayerState();
            const name = input.value.trim();
            state.pilotName = name || INITIAL_PLAYER_STATE.pilotName;
            onCreated(state);
        };
        const goBack = () => {
            input.blur();
            showMainMenu();
        };
        launch.addEventListener('click', submit);
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                submit();
            }
        });
        cancel.addEventListener('click', goBack);
        this.dialogCleanup = containDialogFocus(dialog, goBack, launch);
    }
}

export class EscapeMenu {
    readonly root = document.createElement('div');
    private readonly card = document.createElement('div');
    private shown = false;

    constructor(
        private readonly onResume: () => void,
        private readonly onMainMenu: () => void | Promise<void>,
    ) {
        this.root.style.cssText = `
          ${MENU_STYLE} display: none; align-items: center;
          justify-content: center; background: rgba(0, 0, 0, .78);
        `;
        this.card.style.cssText = `
          ${PANEL_STYLE} width: 390px; padding: 26px 34px;
          text-align: center;
        `;
        const heading = document.createElement('h2');
        heading.textContent = 'Paused';
        heading.style.cssText = `
          margin: 0 0 22px; color: #efd5c1; letter-spacing: .12em;
        `;
        const resume = makeThemedButton('Resume');
        const mainMenu = makeThemedButton('Return to Main Menu');
        resume.style.width = '100%';
        mainMenu.style.width = '100%';
        this.card.append(heading, resume, mainMenu);
        this.root.appendChild(this.card);
        document.body.appendChild(this.root);
        resume.addEventListener('click', () => {
            this.hide();
            this.onResume();
        });
        mainMenu.addEventListener('click', () => {
            mainMenu.disabled = true;
            void Promise.resolve(this.onMainMenu()).finally(() => {
                mainMenu.disabled = false;
            });
        });
    }

    get visible() {
        return this.shown;
    }

    show() {
        this.shown = true;
        this.root.style.display = 'flex';
    }

    hide() {
        this.shown = false;
        this.root.style.display = 'none';
    }
}
