import type {
    PlayerSnapshotSummary,
    PlayerState,
} from '../nova_plugin/player_state';
import {
    getMasterVolume,
    setMasterVolume,
} from '../display/music';

export const THEMED_BUTTON_STYLE = `
    box-sizing: border-box; min-height: 40px; padding: 7px 20px;
    border: 1px solid #85827b; border-radius: 2px;
    color: #fff8e8; cursor: pointer; font: 16px Charcoal, Geneva, Arial, sans-serif;
    letter-spacing: .08em; text-shadow: 1px 1px #140000;
    background:
      linear-gradient(to bottom, rgba(255, 255, 255, .16), transparent 32%),
      linear-gradient(to bottom, #8f2524 0%, #571010 46%, #240606 100%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, .4),
      inset 0 -2px 0 rgba(0, 0, 0, .75),
      0 2px 4px rgba(0, 0, 0, .65);
`;

export const PANEL_STYLE = `
    box-sizing: border-box; border: 2px solid #77766f;
    background:
      linear-gradient(rgba(110, 24, 20, .48), rgba(13, 8, 8, .96)),
      repeating-linear-gradient(0deg, rgba(255, 255, 255, .035) 0 1px,
        rgba(0, 0, 0, .04) 1px 3px),
      #211b1a;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, .35),
      inset 0 -2px 0 rgba(0, 0, 0, .8),
      0 4px 14px rgba(0, 0, 0, .8);
`;

const FIELD_STYLE = `
    box-sizing: border-box; border: 1px solid #716d64;
    background: linear-gradient(#090707, #1b0e0c);
    box-shadow: inset 0 2px 6px rgba(0, 0, 0, .78);
`;

const CONTROL_LABELS: Readonly<Record<string, string>> = {
    accelerate: 'Accelerate',
    reverse: 'Reverse',
    turnLeft: 'Turn left',
    turnRight: 'Turn right',
    firePrimary: 'Fire primary',
    fireSecondary: 'Fire secondary',
    nextTarget: 'Next target',
    nearestTarget: 'Nearest target',
    nextSecondary: 'Next secondary',
    afterburner: 'Afterburner',
    hail: 'Hail target',
    board: 'Board ship',
    map: 'Map',
    smallMap: 'Small map',
    hyperjump: 'Hyperspace',
    land: 'Land',
    depart: 'Depart',
    properties: 'Pilot status',
    missions: 'Mission status',
    fullscreen: 'Fullscreen',
    volumeUp: 'Volume up',
    volumeDown: 'Volume down',
};

const DEFAULT_CONTROL_CODES: Readonly<Record<string, unknown>> = {
    accelerate: 'ArrowUp',
    reverse: 'ArrowDown',
    turnLeft: 'ArrowLeft',
    turnRight: 'ArrowRight',
    firePrimary: 'Space',
    fireSecondary: ['ControlLeft', 'ShiftLeft'],
    nextTarget: 'Tab',
    nearestTarget: 'KeyR',
    nextSecondary: 'KeyW',
    afterburner: 'KeyZ',
    hail: 'KeyY',
    board: 'KeyB',
    map: 'KeyM',
    smallMap: 'KeyH',
    hyperjump: 'KeyJ',
    land: 'KeyL',
    depart: ['Escape', 'KeyD'],
    properties: 'KeyP',
    missions: 'KeyI',
    fullscreen: 'Enter',
    volumeUp: 'Equal',
    volumeDown: 'Minus',
};

export type CompatibilityProfileName = 'classic' | 'modern';

export interface PilotChoice {
    kind: 'current' | 'snapshot';
    id: string;
    pilotName: string;
    currentSystem: string;
    savedAt?: number;
    reason?: PlayerSnapshotSummary['reason'];
    state?: PlayerState;
}

export interface ControlReferenceEntry {
    action: string;
    binding: string;
}

export interface RetailDialogOptions {
    content: HTMLElement;
    compatibilityProfile: CompatibilityProfileName;
    controls?: unknown;
    resolveSystemName?: (systemId: string) => Promise<string | undefined>;
    restoreSnapshot?: (
        snapshotId: string,
    ) => Promise<{ playerState?: PlayerState } | undefined>;
    onBack: (actionLabel: string) => void;
    onPilotSelected: (state: PlayerState, savedAt?: number) => void;
}

function humanizeKey(code: string): string {
    const aliases: Readonly<Record<string, string>> = {
        ArrowUp: '↑',
        ArrowDown: '↓',
        ArrowLeft: '←',
        ArrowRight: '→',
        Space: 'Space',
        ControlLeft: 'Left Control',
        ControlRight: 'Right Control',
        ShiftLeft: 'Left Shift',
        ShiftRight: 'Right Shift',
        AltLeft: 'Left Option/Alt',
        AltRight: 'Right Option/Alt',
        Equal: '+',
        Minus: '−',
        Backquote: '`',
        Escape: 'Escape',
        Tab: 'Tab',
        Enter: 'Enter',
    };
    if (aliases[code]) {
        return aliases[code];
    }
    if (/^(Key|Digit)/.test(code)) {
        return code.replace(/^(Key|Digit)/, '');
    }
    return code.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function formatControlInput(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return humanizeKey(value);
    }
    if (Array.isArray(value)) {
        const bindings = value
            .map(formatControlInput)
            .filter((binding): binding is string => binding !== undefined);
        return bindings.length > 0 ? bindings.join(' / ') : undefined;
    }
    if (value && typeof value === 'object'
        && typeof (value as { key?: unknown }).key === 'string') {
        const key = humanizeKey((value as { key: string }).key);
        const modifiers = (value as { modifiers?: unknown }).modifiers;
        if (!Array.isArray(modifiers)) {
            return key;
        }
        const prefix = modifiers
            .filter((modifier): modifier is string => typeof modifier === 'string')
            .map(humanizeKey);
        return [...prefix, key].join('+');
    }
    return undefined;
}

export function controlReference(controls: unknown): ControlReferenceEntry[] {
    const configured = controls && typeof controls === 'object'
        && !Array.isArray(controls)
        ? controls as Record<string, unknown>
        : {};
    return Object.entries(CONTROL_LABELS).map(([key, action]) => ({
        action,
        binding: formatControlInput(
            configured[key] ?? DEFAULT_CONTROL_CODES[key],
        ) ?? 'Unbound',
    }));
}

export function buildPilotChoices(
    current: PlayerState | undefined,
    snapshots: readonly PlayerSnapshotSummary[],
    savedAt?: number,
): PilotChoice[] {
    const latestSnapshotTime = snapshots.reduce<number | undefined>(
        (latest, snapshot) => latest === undefined
            ? snapshot.createdAt : Math.max(latest, snapshot.createdAt),
        undefined,
    );
    const choices: PilotChoice[] = [];
    if (current) {
        choices.push({
            kind: 'current',
            id: 'current',
            pilotName: current.pilotName || 'Captain',
            currentSystem: current.currentSystem || 'nova:130',
            savedAt: savedAt ?? latestSnapshotTime,
            state: current,
        });
    }
    choices.push(...[...snapshots]
        .sort((left, right) => right.createdAt - left.createdAt)
        .map(snapshot => ({
            kind: 'snapshot' as const,
            id: snapshot.id,
            pilotName: snapshot.pilotName ?? current?.pilotName ?? 'Captain',
            currentSystem:
                snapshot.currentSystem ?? current?.currentSystem ?? 'nova:130',
            savedAt: snapshot.createdAt,
            reason: snapshot.reason,
        })));
    return choices;
}

export function canEnterShip(state: PlayerState | undefined): boolean {
    return state !== undefined;
}

export function makeThemedButton(text: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.style.cssText = THEMED_BUTTON_STYLE;
    const setHover = (hovered: boolean) => {
        button.style.background = hovered ? `
          linear-gradient(to bottom, rgba(255, 255, 255, .25), transparent 32%),
          linear-gradient(to bottom, #b43b31 0%, #761817 46%, #3c0a08 100%)
        ` : `
          linear-gradient(to bottom, rgba(255, 255, 255, .16), transparent 32%),
          linear-gradient(to bottom, #8f2524 0%, #571010 46%, #240606 100%)
        `;
        button.style.borderColor = hovered ? '#d5cbb3' : '#85827b';
    };
    button.addEventListener('mouseenter', () => setHover(true));
    button.addEventListener('mouseleave', () => setHover(false));
    button.addEventListener('focus', () => {
        button.style.outline = '1px solid #e4b18b';
        button.style.outlineOffset = '2px';
    });
    button.addEventListener('blur', () => {
        button.style.outline = '';
        button.style.outlineOffset = '';
    });
    return button;
}

export function containDialogFocus(
    dialog: HTMLElement,
    onEscape: () => void,
    primary?: HTMLElement,
): () => void {
    const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onEscape();
            return;
        }
        if (event.key === 'Enter' && primary
            && event.target instanceof HTMLElement
            && !event.target.closest('a, button, input, select, textarea')) {
            event.preventDefault();
            primary.click();
            return;
        }
        if (event.key !== 'Tab') {
            return;
        }
        const focusable = [...dialog.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), '
            + 'select:not([disabled]), textarea:not([disabled]), '
            + '[tabindex]:not([tabindex="-1"])',
        )].filter(element => element.offsetParent !== null);
        if (focusable.length === 0) {
            event.preventDefault();
            dialog.focus();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };
    dialog.addEventListener('keydown', onKeyDown);
    return () => dialog.removeEventListener('keydown', onKeyDown);
}

function makeHeading(text: string, subtitle?: string): HTMLElement[] {
    const heading = document.createElement('h2');
    heading.textContent = text;
    heading.style.cssText = `
      margin: 0 0 6px; color: #f0d4be; font-size: 22px;
      letter-spacing: .12em; text-shadow: 2px 2px #180000;
    `;
    if (!subtitle) {
        heading.style.marginBottom = '18px';
        return [heading];
    }
    const description = document.createElement('p');
    description.textContent = subtitle;
    description.style.cssText = `
      margin: 0 0 16px; color: #cfc8b9;
      font: 14px/1.45 Geneva, Arial, sans-serif;
    `;
    return [heading, description];
}

function makeActions(primary: HTMLButtonElement, back: HTMLButtonElement) {
    const actions = document.createElement('div');
    actions.style.cssText = `
      display: flex; flex: 0 0 auto; justify-content: center;
      gap: 14px; margin-top: 16px;
    `;
    primary.style.minWidth = '150px';
    back.style.minWidth = '150px';
    actions.append(primary, back);
    return actions;
}

function formatDate(timestamp: number | undefined): string {
    if (timestamp === undefined) {
        return 'Date unavailable';
    }
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime())
        ? 'Date unavailable'
        : date.toLocaleString([], {
            dateStyle: 'medium',
            timeStyle: 'short',
        });
}

export class RetailMenuDialogs {
    private cleanup: (() => void) | undefined;

    constructor(private readonly options: RetailDialogOptions) {}

    clear() {
        this.cleanup?.();
        this.cleanup = undefined;
    }

    showOpenPilot(
        current: PlayerState | undefined,
        snapshots: readonly PlayerSnapshotSummary[],
        savedAt?: number,
    ) {
        this.clear();
        this.options.content.replaceChildren();
        const choices = buildPilotChoices(current, snapshots, savedAt);
        const dialog = document.createElement('section');
        dialog.tabIndex = -1;
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'nova-open-pilot-heading');
        dialog.style.cssText = `
          position: absolute; left: 172px; top: 128px; width: 680px;
          height: 516px; padding: 20px 24px 22px; text-align: center;
          display: flex; flex-direction: column; ${PANEL_STYLE}
        `;
        const [heading, subtitle] = makeHeading(
            'OPEN PILOT',
            'Choose the current save or restore one of its retained snapshots.',
        );
        heading.id = 'nova-open-pilot-heading';
        const list = document.createElement('div');
        list.setAttribute('role', 'radiogroup');
        list.setAttribute('aria-label', 'Pilot saves');
        list.style.cssText = `
          ${FIELD_STYLE} flex: 1 1 auto; min-height: 0; padding: 8px;
          overflow-y: auto; text-align: left;
        `;
        const status = document.createElement('p');
        status.setAttribute('role', 'status');
        status.style.cssText = `
          min-height: 18px; margin: 10px 0 -5px; color: #edc777;
          font: 13px Geneva, Arial, sans-serif;
        `;
        let selected = choices[0];
        const rows: HTMLButtonElement[] = [];
        const updateSelection = (choice: PilotChoice) => {
            selected = choice;
            for (const [index, row] of rows.entries()) {
                const active = choices[index] === selected;
                row.setAttribute('aria-checked', String(active));
                row.style.borderColor = active ? '#c2825e' : '#4d4943';
                row.style.background = active
                    ? 'linear-gradient(90deg, #581a17, #2b1110)'
                    : 'linear-gradient(90deg, #181414, #0d0b0b)';
            }
        };
        for (const choice of choices) {
            const row = document.createElement('button');
            row.type = 'button';
            row.setAttribute('role', 'radio');
            row.style.cssText = `
              box-sizing: border-box; display: grid; width: 100%; margin: 0 0 7px;
              padding: 10px 12px; grid-template-columns: 1.2fr 1fr;
              gap: 5px 15px; border: 1px solid #4d4943; border-radius: 2px;
              color: #f3ead9; cursor: pointer; text-align: left;
              background: linear-gradient(90deg, #181414, #0d0b0b);
              font-family: Geneva, Arial, sans-serif;
            `;
            const name = document.createElement('strong');
            name.textContent = choice.pilotName;
            name.style.cssText =
                'color: #f4d4bd; font-size: 16px; letter-spacing: .04em;';
            const kind = document.createElement('span');
            kind.textContent = choice.kind === 'current'
                ? 'CURRENT PILOT'
                : `${choice.reason === 'manual' ? 'MANUAL' : 'LANDING'} SNAPSHOT`;
            kind.style.cssText =
                'color: #b9aa99; font-size: 11px; text-align: right;';
            const date = document.createElement('span');
            date.textContent = formatDate(choice.savedAt);
            date.style.cssText = 'font-size: 12px; color: #c9c1b4;';
            const location = document.createElement('span');
            location.textContent = choice.currentSystem;
            location.dataset.systemId = choice.currentSystem;
            location.style.cssText =
                'font-size: 12px; color: #d7b98d; text-align: right;';
            row.append(name, kind, date, location);
            row.addEventListener('click', () => updateSelection(choice));
            row.addEventListener('keydown', event => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    updateSelection(choice);
                    select.click();
                }
            });
            row.addEventListener('dblclick', () => {
                updateSelection(choice);
                select.click();
            });
            rows.push(row);
            list.appendChild(row);
            if (this.options.resolveSystemName) {
                void this.options.resolveSystemName(choice.currentSystem)
                    .then(systemName => {
                        if (systemName && location.isConnected) {
                            location.textContent = systemName;
                            location.title = choice.currentSystem;
                        }
                    });
            }
        }
        if (choices.length === 0) {
            const empty = document.createElement('p');
            empty.textContent =
                'No saved pilot was found. Return and choose New Pilot to begin.';
            empty.style.cssText = `
              margin: 112px 30px; color: #cfc7b8;
              font: 15px/1.5 Geneva, Arial, sans-serif; text-align: center;
            `;
            list.appendChild(empty);
        }
        const select = makeThemedButton('Select Pilot');
        select.disabled = choices.length === 0;
        if (select.disabled) {
            select.style.opacity = '.5';
            select.style.cursor = 'default';
        }
        const back = makeThemedButton('Back');
        const goBack = () => this.options.onBack('Open Pilot');
        select.addEventListener('click', async () => {
            if (!selected) {
                return;
            }
            select.disabled = true;
            if (selected.kind === 'current' && selected.state) {
                this.options.onPilotSelected(selected.state, selected.savedAt);
                return;
            }
            if (!this.options.restoreSnapshot) {
                status.textContent = 'Snapshot restore is not available.';
                select.disabled = false;
                return;
            }
            status.textContent = 'Restoring pilot snapshot…';
            try {
                const restored = await this.options.restoreSnapshot(selected.id);
                if (restored?.playerState) {
                    this.options.onPilotSelected(
                        restored.playerState,
                        selected.savedAt,
                    );
                    return;
                }
            } catch {
                // The status below is the user-facing recovery path.
            }
            status.textContent = 'Snapshot could not be restored.';
            select.disabled = false;
        });
        back.addEventListener('click', goBack);
        dialog.append(
            heading,
            subtitle!,
            list,
            status,
            makeActions(select, back),
        );
        this.options.content.appendChild(dialog);
        if (rows[0]) {
            updateSelection(choices[0]);
            rows[0].focus();
        } else {
            back.focus();
        }
        this.cleanup = containDialogFocus(dialog, goBack, select);
    }

    showPreferences() {
        this.clear();
        this.options.content.replaceChildren();
        const dialog = document.createElement('section');
        dialog.tabIndex = -1;
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'nova-prefs-heading');
        dialog.style.cssText = `
          position: absolute; left: 157px; top: 82px; width: 710px;
          height: 604px; padding: 19px 24px 21px; text-align: center;
          display: flex; flex-direction: column; ${PANEL_STYLE}
        `;
        const [heading] = makeHeading('SET PREFS');
        heading.id = 'nova-prefs-heading';
        const settings = document.createElement('div');
        settings.style.cssText = `
          display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
          margin-bottom: 12px; text-align: left;
        `;
        const volumeBox = document.createElement('section');
        volumeBox.style.cssText = `${FIELD_STYLE} padding: 12px 14px;`;
        const volumeLabel = document.createElement('label');
        volumeLabel.htmlFor = 'nova-master-volume';
        volumeLabel.textContent = 'MASTER VOLUME';
        volumeLabel.style.cssText = `
          display: flex; justify-content: space-between; color: #e7c2a5;
          font: 13px Charcoal, Geneva, Arial, sans-serif; letter-spacing: .08em;
        `;
        const volumeValue = document.createElement('span');
        const volume = document.createElement('input');
        volume.id = 'nova-master-volume';
        volume.type = 'range';
        volume.min = '0';
        volume.max = '100';
        volume.step = '1';
        volume.value = String(Math.round(getMasterVolume() * 100));
        volume.setAttribute('aria-valuetext', `${volume.value} percent`);
        volume.style.cssText = `
          width: 100%; height: 18px; margin: 12px 0 2px; cursor: pointer;
          accent-color: #9b3229; background: transparent;
        `;
        const updateVolume = () => {
            const percent = Number(volume.value);
            volumeValue.textContent = `${percent}%`;
            volume.setAttribute('aria-valuetext', `${percent} percent`);
            setMasterVolume(percent / 100);
        };
        volumeLabel.appendChild(volumeValue);
        volumeBox.append(volumeLabel, volume);
        updateVolume();
        volume.addEventListener('input', updateVolume);

        const displayBox = document.createElement('section');
        displayBox.style.cssText = `${FIELD_STYLE} padding: 12px 14px;`;
        const displayLabel = document.createElement('h3');
        displayLabel.textContent = 'DISPLAY';
        displayLabel.style.cssText = `
          margin: 0 0 8px; color: #e7c2a5;
          font: 13px Charcoal, Geneva, Arial, sans-serif; letter-spacing: .08em;
        `;
        const fullscreen = makeThemedButton('');
        fullscreen.style.cssText += `
          width: 100%; min-height: 34px; padding: 4px 10px; font-size: 13px;
        `;
        const fullscreenStatus = document.createElement('p');
        fullscreenStatus.setAttribute('role', 'status');
        fullscreenStatus.style.cssText = `
          min-height: 15px; margin: 6px 0 0; color: #bdb4a5;
          font: 11px Geneva, Arial, sans-serif; text-align: center;
        `;
        const updateFullscreenLabel = () => {
            fullscreen.textContent = document.fullscreenElement
                ? 'Exit Full Screen'
                : 'Enter Full Screen';
        };
        updateFullscreenLabel();
        fullscreen.addEventListener('click', async () => {
            fullscreen.disabled = true;
            fullscreenStatus.textContent = '';
            try {
                if (document.fullscreenElement) {
                    await document.exitFullscreen();
                } else {
                    await document.documentElement.requestFullscreen();
                }
            } catch {
                fullscreenStatus.textContent =
                    'Full screen was not allowed by this browser.';
            } finally {
                fullscreen.disabled = false;
                updateFullscreenLabel();
            }
        });
        document.addEventListener('fullscreenchange', updateFullscreenLabel);
        displayBox.append(displayLabel, fullscreen, fullscreenStatus);
        settings.append(volumeBox, displayBox);

        const compatibility = document.createElement('section');
        compatibility.style.cssText = `
          ${FIELD_STYLE} margin-bottom: 12px; padding: 10px 14px;
          text-align: left; color: #cfc8ba;
          font: 12px/1.45 Geneva, Arial, sans-serif;
        `;
        const profileName = this.options.compatibilityProfile === 'classic'
            ? 'CLASSIC' : 'MODERN';
        compatibility.innerHTML = `
          <strong style="color:#e7c2a5;letter-spacing:.08em">
            COMPATIBILITY PROFILE: ${profileName}
          </strong><br>
          This profile is selected by the server and applies to every pilot.
          It is shown here as read-only; a browser-only change would not alter
          simulation behavior.
        `;

        const controlsHeading = document.createElement('div');
        controlsHeading.style.cssText = `
          display: flex; justify-content: space-between; margin: 0 2px 7px;
          color: #e7c2a5; font: 13px Charcoal, Geneva, Arial, sans-serif;
          letter-spacing: .08em;
        `;
        controlsHeading.innerHTML =
            '<span>CONTROLS</span><span style="color:#a9a092">READ-ONLY</span>';
        const controlsList = document.createElement('div');
        controlsList.style.cssText = `
          ${FIELD_STYLE} flex: 1 1 auto; min-height: 0; padding: 7px 12px;
          overflow-y: auto; display: grid; grid-template-columns: 1fr 1fr;
          column-gap: 28px; text-align: left;
        `;
        for (const entry of controlReference(this.options.controls)) {
            const row = document.createElement('div');
            row.style.cssText = `
              display: flex; justify-content: space-between; gap: 10px;
              padding: 5px 0; border-bottom: 1px solid rgba(130, 120, 107, .2);
              color: #cfc8ba; font: 12px Geneva, Arial, sans-serif;
            `;
            const action = document.createElement('span');
            action.textContent = entry.action;
            const binding = document.createElement('kbd');
            binding.textContent = entry.binding;
            binding.style.cssText = `
              color: #efcfaa; font: 11px Geneva, Arial, sans-serif;
              white-space: nowrap;
            `;
            row.append(action, binding);
            controlsList.appendChild(row);
        }
        const back = makeThemedButton('Back');
        back.style.minWidth = '170px';
        const actions = document.createElement('div');
        actions.style.cssText = 'flex:0 0 auto;margin-top:14px;';
        actions.appendChild(back);
        const goBack = () => this.options.onBack('Set Prefs');
        back.addEventListener('click', goBack);
        dialog.append(
            heading,
            settings,
            compatibility,
            controlsHeading,
            controlsList,
            actions,
        );
        this.options.content.appendChild(dialog);
        volume.focus();
        const focusCleanup = containDialogFocus(dialog, goBack, back);
        this.cleanup = () => {
            focusCleanup();
            document.removeEventListener(
                'fullscreenchange',
                updateFullscreenLabel,
            );
        };
    }

    showAbout() {
        this.clear();
        this.options.content.replaceChildren();
        const dialog = document.createElement('section');
        dialog.tabIndex = -1;
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'nova-about-heading');
        dialog.style.cssText = `
          position: absolute; left: 207px; top: 118px; width: 610px;
          padding: 22px 28px 24px; text-align: center; ${PANEL_STYLE}
        `;
        const [heading, subtitle] = makeHeading(
            'ABOUT NOVA',
            'Credits and preservation context',
        );
        heading.id = 'nova-about-heading';
        const credits = document.createElement('div');
        credits.style.cssText = `
          ${FIELD_STYLE} padding: 17px 20px; color: #d3ccbf;
          font: 14px/1.55 Geneva, Arial, sans-serif; text-align: left;
        `;
        credits.innerHTML = `
          <h3 style="margin:0 0 5px;color:#efc9ac;font-size:15px;
              letter-spacing:.08em">ORIGINAL ESCAPE VELOCITY: NOVA</h3>
          <p style="margin:0 0 15px">
            Created by Matt Burch and ATMOS Software; published by Ambrosia
            Software. Original game names, artwork, writing, and other
            materials are credited to their respective creators and rights
            holders.
          </p>
          <h3 style="margin:0 0 5px;color:#efc9ac;font-size:15px;
              letter-spacing:.08em">NOVAJS</h3>
          <p style="margin:0 0 10px">
            An open-source browser reimplementation initiated by Matt
            Soulanille, maintained separately from the original commercial
            release for engineering and preservation purposes.
          </p>
          <p style="margin:0">
            <a href="https://github.com/mattsoulanille/NovaJS"
              target="_blank" rel="noopener noreferrer"
              style="color:#efb77f">Upstream NovaJS</a>
            <span aria-hidden="true" style="color:#766d62"> · </span>
            <a href="https://github.com/NotNANtoN/NovaJS"
              target="_blank" rel="noopener noreferrer"
              style="color:#efb77f">This fork</a>
          </p>
        `;
        const note = document.createElement('p');
        note.textContent =
            'This screen supplies attribution and historical context; it is not legal advice.';
        note.style.cssText = `
          margin: 13px 8px 0; color: #9f978a;
          font: 11px/1.4 Geneva, Arial, sans-serif;
        `;
        const back = makeThemedButton('Back');
        back.style.cssText += 'min-width:170px;margin-top:18px;';
        const goBack = () => this.options.onBack('About Nova');
        back.addEventListener('click', goBack);
        dialog.append(heading, subtitle!, credits, note, back);
        this.options.content.appendChild(dialog);
        back.focus();
        this.cleanup = containDialogFocus(dialog, goBack, back);
    }

    showQuit() {
        this.clear();
        this.options.content.replaceChildren();
        const dialog = document.createElement('section');
        dialog.tabIndex = -1;
        dialog.setAttribute('role', 'alertdialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'nova-quit-heading');
        dialog.setAttribute('aria-describedby', 'nova-quit-message');
        dialog.style.cssText = `
          position: absolute; left: 272px; top: 282px; width: 480px;
          padding: 22px 26px 24px; text-align: center; ${PANEL_STYLE}
        `;
        const [heading] = makeHeading('QUIT NOVA');
        heading.id = 'nova-quit-heading';
        const message = document.createElement('p');
        message.id = 'nova-quit-message';
        message.textContent =
            'Quit Nova and close this browser tab?';
        message.style.cssText = `
          min-height: 42px; margin: 0 10px 18px; color: #d7d0c3;
          font: 15px/1.5 Geneva, Arial, sans-serif;
        `;
        const quit = makeThemedButton('Quit Nova');
        const cancel = makeThemedButton('Cancel');
        const goBack = () => this.options.onBack('Quit Nova');
        cancel.addEventListener('click', goBack);
        quit.addEventListener('click', () => {
            quit.disabled = true;
            cancel.disabled = true;
            message.textContent = 'Closing Nova…';
            window.close();
            window.setTimeout(() => {
                if (!dialog.isConnected) {
                    return;
                }
                message.textContent = 'You can safely close this tab.';
                cancel.disabled = false;
                cancel.textContent = 'Back';
                cancel.focus();
            }, 180);
        });
        dialog.append(heading, message, makeActions(quit, cancel));
        this.options.content.appendChild(dialog);
        cancel.focus();
        this.cleanup = containDialogFocus(dialog, goBack, quit);
    }
}
