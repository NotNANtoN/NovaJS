import {
    createInitialPlayerState,
    PlayerData,
    PlayerState,
    PlayerSnapshotSummary,
} from '../nova_plugin/player_state';
import type { GameDataInterface } from 'novadatainterface/GameDataInterface';
import { dataPath } from '../common/GameDataPaths';
import {
    CompatibilityProfileName,
    PANEL_STYLE,
    RetailMenuDialogs,
    canEnterShip,
    containDialogFocus,
    makeThemedButton,
} from './start_menu_dialogs';

export interface StartMenuSelection {
    playerState: PlayerState;
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

const MENU_STYLE = `
    position: fixed; inset: 0; z-index: 1000; overflow: hidden;
    color: #f4f0e4; font-family: Charcoal, Geneva, Arial, sans-serif;
    background: #000;
`;

type RetailMenuAssets = {
    background: string;
    logo: string;
    buttons: Record<string, string>;
};

function assetUrl(type: 'PictImage' | 'SpriteSheetImage', id: string): string {
    return `${dataPath}/${type}/${encodeURIComponent(id)}.png`;
}

function preloadImage(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
            void image.decode().then(() => resolve()).catch(reject);
        };
        image.onerror = () =>
            reject(new Error(`Failed to load menu artwork: ${url}`));
        image.src = url;
    });
}

async function loadRetailMenuAssets(
    gameData: GameDataInterface | undefined,
): Promise<RetailMenuAssets | undefined> {
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
        // Check the actual served resources too. IDs can be present while a
        // parser has failed to produce a particular image.
        await Promise.all([
            gameData.data.PictImage.get('nova:8000'),
            gameData.data.PictImage.get('nova:8010'),
            ...buttonIds.map(id =>
                gameData.data.SpriteSheetImage.get(`nova:${id}`)),
        ]);
        const assets = {
            background: assetUrl('PictImage', 'nova:8000'),
            logo: assetUrl('PictImage', 'nova:8010'),
            buttons: Object.fromEntries(buttonIds.map(id => [
                id, assetUrl('SpriteSheetImage', `nova:${id}`),
            ])),
        };
        await Promise.all([
            preloadImage(assets.background),
            preloadImage(assets.logo),
            ...Object.values(assets.buttons).map(preloadImage),
        ]);
        return assets;
    } catch {
        // A server without the retail data should retain the usable DOM menu.
        return undefined;
    }
}

function makeRetailButton(
    text: string,
    spriteUrl: string,
    width: number,
    height: number,
    x: number,
    y: number,
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
    button.addEventListener('mouseenter', () => setFrame(1));
    button.addEventListener('mouseleave', () => setFrame(0));
    button.addEventListener('focus', () => {
        button.style.outline = '1px solid #e6c3a0';
        button.style.outlineOffset = '2px';
        setFrame(1);
    });
    button.addEventListener('blur', () => {
        button.style.outline = '';
        button.style.outlineOffset = '';
        setFrame(0);
    });
    button.addEventListener('mousedown', () => setFrame(1));
    button.addEventListener('mouseup', () => setFrame(1));
    return button;
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
    private logoTimer: number | undefined;
    private retailAssets: RetailMenuAssets | undefined;
    private dialogs: RetailMenuDialogs | undefined;
    private dialogCleanup: (() => void) | undefined;
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
        let savedAt = playerData?.savedAt;
        const snapshots = playerData?.snapshots ?? [];
        return new Promise(resolvePromise => {
            const resolve = (state: PlayerState, continued: boolean) => {
                this.dialogs?.clear();
                this.dialogCleanup?.();
                const activeElement = document.activeElement;
                if (activeElement instanceof HTMLElement) {
                    activeElement.blur();
                }
                if (this.logoTimer !== undefined) {
                    window.clearInterval(this.logoTimer);
                    this.logoTimer = undefined;
                }
                window.removeEventListener('resize', this.resizeScene);
                this.root.remove();
                resolvePromise({ playerState: state, continued });
            };
            void loadRetailMenuAssets(this.gameData).then(retailAssets => {
                this.retailAssets = retailAssets;
                let showMainMenu: (focusLabel?: string) => void;
                showMainMenu = (focusLabel?: string) => this.renderMainMenu(
                        current,
                        snapshots,
                        savedAt,
                        resolve,
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
                    onPilotSelected: (state, selectedAt) => {
                        current = state;
                        savedAt = selectedAt;
                        showMainMenu('Open Pilot');
                    },
                });
                this.renderMainMenu(
                    current,
                    snapshots,
                    savedAt,
                    resolve,
                    showMainMenu,
                );
            });
        });
    }

    private renderMainMenu(
        existing: PlayerState | undefined,
        snapshots: PlayerSnapshotSummary[],
        savedAt: number | undefined,
        resolve: (state: PlayerState, continued: boolean) => void,
        showMainMenu: (focusLabel?: string) => void,
        focusLabel?: string,
    ) {
        this.dialogs?.clear();
        this.dialogCleanup?.();
        this.dialogCleanup = undefined;
        if (this.logoTimer !== undefined) {
            window.clearInterval(this.logoTimer);
            this.logoTimer = undefined;
        }
        for (const artwork of this.scene.querySelectorAll(
            '[data-nova-menu-artwork]')) {
            artwork.remove();
        }
        this.content.replaceChildren();
        this.content.style.cssText = `
          position: absolute; inset: 0; text-align: center;
        `;
        if (this.retailAssets) {
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
            const advanceLogo = () => {
                logo.style.backgroundPosition =
                    `0 -${logoFrame * LOGO_FRAME_HEIGHT}px`;
                logoFrame = (logoFrame + 1) % 7;
            };
            advanceLogo();
            this.logoTimer = window.setInterval(advanceLogo, 500);
            this.scene.insertBefore(title, this.content);
            this.scene.insertBefore(logo, this.content);

            const buttonSpecs = [
                ['New Pilot', '8050', 120, 61, 349, 400],
                ['Open Pilot', '8051', 99, 60, 344, 464],
                ['Quit Nova', '8052', 100, 60, 345, 528],
                ['Enter Ship', '8053', 120, 60, 555, 401],
                ['Set Prefs', '8054', 99, 61, 581, 464],
                ['About Nova', '8055', 98, 60, 580, 528],
            ] as const;
            for (const [label, id, width, height, x, y] of buttonSpecs) {
                const button = makeRetailButton(
                    label, this.retailAssets.buttons[id],
                    width, height, x, y);
                button.dataset.menuAction = label;
                if (id === '8050') {
                    button.addEventListener('click', () =>
                        this.showNameEntry(
                            resolve,
                            () => showMainMenu('New Pilot'),
                        ));
                } else if (id === '8051') {
                    button.title = 'Choose a saved pilot or snapshot';
                    button.addEventListener('click', () => {
                        this.stopLogoAnimation(true);
                        this.dialogs?.showOpenPilot(
                            existing,
                            snapshots,
                            savedAt,
                        );
                    });
                } else if (id === '8052') {
                    button.addEventListener('click', () => {
                        this.stopLogoAnimation(true);
                        this.dialogs?.showQuit();
                    });
                } else if (id === '8053') {
                    button.disabled = !canEnterShip(existing);
                    button.title = existing
                        ? 'Enter the ship with the selected pilot'
                        : 'No saved pilot selected';
                    if (button.disabled) {
                        button.style.opacity = '.48';
                        button.style.filter = 'grayscale(.8)';
                        button.style.cursor = 'default';
                    }
                    button.addEventListener('click', () => {
                        if (existing) {
                            resolve(existing, true);
                        }
                    });
                } else if (id === '8054') {
                    button.addEventListener('click', () => {
                        this.stopLogoAnimation(true);
                        this.dialogs?.showPreferences();
                    });
                } else if (id === '8055') {
                    button.addEventListener('click', () => {
                        this.stopLogoAnimation(true);
                        this.dialogs?.showAbout();
                    });
                }
                this.content.appendChild(button);
            }
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
                if (label === 'Enter Ship') {
                    button.disabled = !canEnterShip(existing);
                }
                button.addEventListener('click', () => {
                    if (label === 'New Pilot') {
                        this.showNameEntry(
                            resolve,
                            () => showMainMenu('New Pilot'),
                        );
                    } else if (label === 'Enter Ship' && existing) {
                        resolve(existing, true);
                    } else if (label === 'Open Pilot') {
                        this.dialogs?.showOpenPilot(
                            existing,
                            snapshots,
                            savedAt,
                        );
                    } else if (label === 'Set Prefs') {
                        this.dialogs?.showPreferences();
                    } else if (label === 'Quit Nova') {
                        this.dialogs?.showQuit();
                    } else if (label === 'About Nova') {
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
        if (this.logoTimer !== undefined) {
            window.clearInterval(this.logoTimer);
            this.logoTimer = undefined;
        }
        if (removeArtwork) {
            for (const artwork of this.scene.querySelectorAll(
                '[data-nova-menu-artwork]')) {
                artwork.remove();
            }
        }
    }

    private showNameEntry(
        resolve: (state: PlayerState, continued: boolean) => void,
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
        input.value = 'Captain';
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
            state.pilotName = name || 'Captain';
            resolve(state, false);
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
