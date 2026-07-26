/**
 * The title screen's modal dialogs, rendered as HTML overlays.
 *
 * The original's New Pilot / Open Pilot / Preferences panels are native
 * OS dialogs; HTML overlays are both the faithful analogue and the
 * accessible, headlessly-driveable choice in a browser. Each dialog
 * resolves a Promise with the player's choice and cleans itself up.
 *
 * All of this is client-only UI: nothing here touches sim state.
 */

import {
    ControlsOverride, GameSettingsOverride, loadControlsOverride,
    loadGameSettings, PilotProfile, saveControlsOverride, saveGameSettings,
} from './client_prefs.js';
import { keyLabel } from './key_labels.js';

// ---------------------------------------------------------------------------
// Shared modal scaffolding.
// ---------------------------------------------------------------------------

interface Modal {
    backdrop: HTMLDivElement;
    panel: HTMLDivElement;
    close: () => void;
}

function makeModal(testid: string): Modal {
    const backdrop = document.createElement('div');
    backdrop.className = 'nova-title-modal-backdrop';
    backdrop.dataset.testid = `${testid}-backdrop`;
    Object.assign(backdrop.style, {
        position: 'fixed', inset: '0', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.35)', zIndex: '10000',
        fontFamily: '-apple-system, Geneva, "Helvetica Neue", sans-serif',
    } as Partial<CSSStyleDeclaration>);

    const panel = document.createElement('div');
    panel.className = 'nova-title-modal';
    panel.dataset.testid = testid;
    Object.assign(panel.style, {
        background: '#ececec', color: '#111', borderRadius: '8px',
        boxShadow: '0 12px 48px rgba(0,0,0,0.6)', padding: '18px 20px',
        minWidth: '360px', maxWidth: '640px', fontSize: '13px',
    } as Partial<CSSStyleDeclaration>);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);

    const close = () => {
        if (backdrop.parentNode) {
            backdrop.parentNode.removeChild(backdrop);
        }
    };
    return { backdrop, panel, close };
}

function button(label: string, testid: string, primary: boolean):
    HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.dataset.testid = testid;
    Object.assign(btn.style, {
        padding: '5px 16px', borderRadius: '6px', fontSize: '13px',
        cursor: 'pointer', marginLeft: '8px',
        border: primary ? 'none' : '1px solid #b0b0b0',
        background: primary ? '#2b6cff' : '#fbfbfb',
        color: primary ? '#fff' : '#111',
    } as Partial<CSSStyleDeclaration>);
    return btn;
}

function buttonRow(...buttons: HTMLButtonElement[]): HTMLDivElement {
    const row = document.createElement('div');
    Object.assign(row.style, {
        display: 'flex', justifyContent: 'flex-end', marginTop: '18px',
    } as Partial<CSSStyleDeclaration>);
    for (const b of buttons) {
        row.appendChild(b);
    }
    return row;
}

// ---------------------------------------------------------------------------
// About.
// ---------------------------------------------------------------------------

const ABOUT_TEXT = [
    'Escape Velocity: Nova',
    '(c) 1996-2008 Ambrosia Software, Inc.',
    '',
    'Engine Programming:',
    '  Matt Burch',
    '',
    'Concepts, Plot, Dialogue, Scenario implementation, Graphics,',
    'Sound production & supervision:',
    '  ATMOS Software Productions',
    '',
    'NovaJS — a browser remake built on the original game resources.',
];

/** The "About Nova" panel: the credits, with an Okay button. */
export function showAboutDialog(): Promise<void> {
    return new Promise((resolve) => {
        const modal = makeModal('about-dialog');
        const title = document.createElement('div');
        title.textContent = 'About Escape Velocity: Nova';
        Object.assign(title.style, {
            fontWeight: '600', fontSize: '15px', marginBottom: '12px',
        } as Partial<CSSStyleDeclaration>);
        modal.panel.appendChild(title);

        const body = document.createElement('div');
        Object.assign(body.style, {
            background: '#000', color: '#d8d8d8', padding: '14px 16px',
            borderRadius: '6px', fontFamily: 'Geneva, monospace',
            fontSize: '12px', whiteSpace: 'pre-wrap', lineHeight: '1.4',
            maxHeight: '320px', overflowY: 'auto',
        } as Partial<CSSStyleDeclaration>);
        body.textContent = ABOUT_TEXT.join('\n');
        modal.panel.appendChild(body);

        const okay = button('Okay', 'about-okay', true);
        modal.panel.appendChild(buttonRow(okay));

        const done = () => { cleanup(); resolve(); };
        const cleanup = () => {
            document.removeEventListener('keydown', onKey);
            modal.close();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === 'Escape') {
                e.preventDefault();
                done();
            }
        };
        okay.addEventListener('click', done);
        document.addEventListener('keydown', onKey);
        okay.focus();
    });
}

// ---------------------------------------------------------------------------
// New Pilot.
// ---------------------------------------------------------------------------

function field(labelText: string): { row: HTMLDivElement, label: HTMLDivElement } {
    const row = document.createElement('div');
    Object.assign(row.style, {
        display: 'flex', alignItems: 'center', margin: '8px 0',
    } as Partial<CSSStyleDeclaration>);
    const label = document.createElement('div');
    label.textContent = labelText;
    Object.assign(label.style, {
        width: '110px', textAlign: 'right', marginRight: '12px',
        color: '#333',
    } as Partial<CSSStyleDeclaration>);
    row.appendChild(label);
    return { row, label };
}

/** "Create a new pilot" — name, nickname, gender, strict play. Resolves
 * the entered profile, or null on Cancel. */
export function showNewPilotDialog(): Promise<PilotProfile | null> {
    return new Promise((resolve) => {
        const modal = makeModal('new-pilot-dialog');
        const title = document.createElement('div');
        title.textContent = 'Create a new pilot:';
        Object.assign(title.style, {
            fontWeight: '600', marginBottom: '12px',
        } as Partial<CSSStyleDeclaration>);
        modal.panel.appendChild(title);

        const nameField = field('Full Name:');
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = 'Shane Merrol';
        nameInput.dataset.testid = 'new-pilot-name';
        nameInput.style.flex = '1';
        nameField.row.appendChild(nameInput);
        modal.panel.appendChild(nameField.row);

        const nickField = field('Nickname:');
        const nickInput = document.createElement('input');
        nickInput.type = 'text';
        nickInput.value = 'Hawkeye';
        nickInput.dataset.testid = 'new-pilot-nickname';
        nickInput.style.flex = '1';
        nickField.row.appendChild(nickInput);
        modal.panel.appendChild(nickField.row);

        const genderField = field('Gender:');
        const genderSelect = document.createElement('select');
        genderSelect.dataset.testid = 'new-pilot-gender';
        for (const [value, label] of [['male', 'Male'], ['female', 'Female']]) {
            const opt = document.createElement('option');
            opt.value = value; opt.textContent = label;
            genderSelect.appendChild(opt);
        }
        genderField.row.appendChild(genderSelect);
        modal.panel.appendChild(genderField.row);

        const strictRow = document.createElement('div');
        Object.assign(strictRow.style, {
            display: 'flex', alignItems: 'flex-start', margin: '10px 0 0 122px',
        } as Partial<CSSStyleDeclaration>);
        const strict = document.createElement('input');
        strict.type = 'checkbox';
        strict.dataset.testid = 'new-pilot-strict';
        strict.id = 'nova-strict-play';
        const strictLabel = document.createElement('label');
        strictLabel.htmlFor = 'nova-strict-play';
        strictLabel.style.marginLeft = '6px';
        strictLabel.innerHTML = 'Strict Play<br>' +
            '<span style="font-size:11px;color:#666">If you check this box, ' +
            'when you\'re dead, you\'re dead. No reincarnation allowed.</span>';
        strictRow.appendChild(strict);
        strictRow.appendChild(strictLabel);
        modal.panel.appendChild(strictRow);

        const cancel = button('Cancel', 'new-pilot-cancel', false);
        const ok = button('OK', 'new-pilot-ok', true);
        modal.panel.appendChild(buttonRow(cancel, ok));

        const cleanup = () => {
            document.removeEventListener('keydown', onKey);
            modal.close();
        };
        const submit = () => {
            const name = nameInput.value.trim() || 'Unnamed Pilot';
            cleanup();
            resolve({
                name,
                nickname: nickInput.value.trim(),
                gender: genderSelect.value,
                strict: strict.checked,
            });
        };
        const abort = () => { cleanup(); resolve(null); };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            else if (e.key === 'Escape') { e.preventDefault(); abort(); }
        };
        ok.addEventListener('click', submit);
        cancel.addEventListener('click', abort);
        document.addEventListener('keydown', onKey);
        nameInput.focus();
        nameInput.select();
    });
}

// ---------------------------------------------------------------------------
// Open Pilot.
// ---------------------------------------------------------------------------

/** A selectable saved pilot for the Open Pilot dialog. */
export interface PilotEntry {
    /** Storage key / id to load. */
    id: string;
    /** Display name (pilot name, or a fallback). */
    name: string;
    /** Secondary line (ship / date), optional. */
    detail?: string;
}

/** "Open pilot" — lists saved pilots. Resolves the chosen entry id, or
 * null on Cancel. */
export function showOpenPilotDialog(entries: PilotEntry[]):
    Promise<string | null> {
    return new Promise((resolve) => {
        const modal = makeModal('open-pilot-dialog');
        const title = document.createElement('div');
        title.textContent = 'Open pilot:';
        Object.assign(title.style, {
            fontWeight: '600', marginBottom: '12px',
        } as Partial<CSSStyleDeclaration>);
        modal.panel.appendChild(title);

        const list = document.createElement('div');
        list.dataset.testid = 'open-pilot-list';
        Object.assign(list.style, {
            border: '1px solid #c4c4c4', borderRadius: '6px',
            background: '#fff', minHeight: '160px', maxHeight: '260px',
            overflowY: 'auto', padding: '4px',
        } as Partial<CSSStyleDeclaration>);
        modal.panel.appendChild(list);

        let selectedId: string | undefined;
        const rows = new Map<string, HTMLDivElement>();
        const open = button('Open', 'open-pilot-open', true);
        open.disabled = true;
        open.style.opacity = '0.5';

        const select = (id: string) => {
            selectedId = id;
            for (const [rid, row] of rows) {
                row.style.background = rid === id ? '#2b6cff' : 'transparent';
                row.style.color = rid === id ? '#fff' : '#111';
            }
            open.disabled = false;
            open.style.opacity = '1';
        };

        if (entries.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = '(no saved pilots)';
            Object.assign(empty.style, {
                color: '#888', padding: '12px', textAlign: 'center',
            } as Partial<CSSStyleDeclaration>);
            list.appendChild(empty);
        } else {
            for (const entry of entries) {
                const row = document.createElement('div');
                row.dataset.testid = `open-pilot-entry-${entry.id}`;
                Object.assign(row.style, {
                    padding: '6px 10px', borderRadius: '4px', cursor: 'pointer',
                } as Partial<CSSStyleDeclaration>);
                const name = document.createElement('div');
                name.textContent = entry.name;
                name.style.fontWeight = '600';
                row.appendChild(name);
                if (entry.detail) {
                    const detail = document.createElement('div');
                    detail.textContent = entry.detail;
                    detail.style.fontSize = '11px';
                    detail.style.opacity = '0.8';
                    row.appendChild(detail);
                }
                row.addEventListener('click', () => select(entry.id));
                row.addEventListener('dblclick', () => { select(entry.id); confirm(); });
                rows.set(entry.id, row);
                list.appendChild(row);
            }
        }

        const cancel = button('Cancel', 'open-pilot-cancel', false);
        modal.panel.appendChild(buttonRow(cancel, open));

        const cleanup = () => {
            document.removeEventListener('keydown', onKey);
            modal.close();
        };
        const confirm = () => {
            if (!selectedId) { return; }
            cleanup();
            resolve(selectedId);
        };
        const abort = () => { cleanup(); resolve(null); };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Enter') { e.preventDefault(); confirm(); }
            else if (e.key === 'Escape') { e.preventDefault(); abort(); }
        };
        open.addEventListener('click', confirm);
        cancel.addEventListener('click', abort);
        document.addEventListener('keydown', onKey);
        // Preselect the first entry for keyboard users.
        if (entries.length > 0) { select(entries[0].id); }
    });
}

// ---------------------------------------------------------------------------
// Preferences.
// ---------------------------------------------------------------------------

/** A game-settings checkbox: label, the override key, and whether it
 * applies to a browser build (disabled/greyed when not). */
interface SettingToggle {
    label: string;
    key?: keyof GameSettingsOverride;
    /** false => shown greyed out (no effect in a browser build). */
    applicable: boolean;
    /** Default checked state when unset. */
    defaultOn: boolean;
}

const GAME_SETTINGS: SettingToggle[][] = [
    // Left column.
    [
        { label: 'Ship Animations', key: 'shipAnimations', applicable: true, defaultOn: true },
        { label: 'Engine Glows', key: 'engineGlows', applicable: true, defaultOn: true },
        { label: 'Running Lights', key: 'runningLights', applicable: true, defaultOn: true },
        { label: 'Weapon Effects', key: 'weaponEffects', applicable: true, defaultOn: true },
        { label: 'Smoke Trails', key: 'smokeTrails', applicable: true, defaultOn: true },
        { label: 'Parallax Starfield', key: 'parallaxStarfield', applicable: true, defaultOn: true },
        { label: 'Check For Updates', applicable: false, defaultOn: false },
    ],
    // Right column.
    [
        { label: 'Intro Music', key: 'introMusic', applicable: true, defaultOn: true },
        { label: 'Run in a window', applicable: false, defaultOn: false },
        { label: 'QuickTime Movies', applicable: false, defaultOn: true },
        { label: 'Ambient Sounds', key: 'ambientSounds', applicable: true, defaultOn: true },
        { label: 'Hyperspace Effects', key: 'hyperspaceEffects', applicable: true, defaultOn: false },
    ],
];

/** A rebindable control: its display label and the controls.json action
 * it maps to (undefined => shown greyed; no browser equivalent). */
interface ControlRow {
    label: string;
    action?: string;
}

const CONTROL_TABS: { name: string, rows: ControlRow[] }[] = [
    {
        name: 'Navigation Controls', rows: [
            { label: 'Accelerate', action: 'accelerate' },
            { label: 'Reverse Course', action: 'reverse' },
            { label: 'Rotate Right', action: 'turnRight' },
            { label: 'Rotate Left', action: 'turnLeft' },
            { label: 'Afterburner', action: 'afterburner' },
            { label: 'Autopilot', action: 'pointTo' },
            { label: 'Hyperspace Mode', action: 'smallMap' },
            { label: 'Hyper Select', action: undefined },
            { label: 'Hyper Jump', action: 'hyperjump' },
            { label: 'Nav System Off', action: 'resetNav' },
            { label: 'Communicate', action: 'hail' },
            { label: 'Land/Dock', action: 'land' },
        ],
    },
    {
        name: 'Battle Controls', rows: [
            { label: 'Fire Primary', action: 'firePrimary' },
            { label: 'Fire Secondary', action: 'fireSecondary' },
            { label: 'Select Secondary', action: 'nextSecondary' },
            { label: 'Weapon Safety', action: undefined },
            { label: 'Target Select', action: 'nextTarget' },
            { label: 'Closest Target', action: 'nearestTarget' },
        ],
    },
    {
        name: 'Escort Controls', rows: [
            { label: 'Escort Menu', action: 'escorts' },
            { label: 'Attack Target', action: 'attack' },
            { label: 'Defend Me', action: 'defend' },
            { label: 'Hold Position', action: 'holdPosition' },
            { label: 'Recall', action: 'formation' },
        ],
    },
    {
        name: 'Misc Controls', rows: [
            { label: 'Pause', action: undefined },
            { label: 'Acknowledge', action: undefined },
            { label: 'Board', action: 'board' },
            { label: 'Jettison Cargo', action: undefined },
            { label: 'Eject', action: undefined },
            { label: 'Self-Destruct', action: 'selfDestruct' },
            { label: 'Engage Cloak', action: 'cloak' },
            { label: 'Galaxy Map', action: 'map' },
            { label: 'Player Info', action: 'properties' },
            { label: 'Mission Info', action: 'missions' },
            { label: 'Show Framerate', action: undefined },
        ],
    },
];

/** The primary bound event.code for an action, override taking priority
 * over the served controls.json base. */
function currentBinding(action: string, base: Record<string, unknown>,
    override: ControlsOverride): string {
    if (override[action]) {
        return override[action];
    }
    const raw = base[action];
    if (typeof raw === 'string') {
        return raw;
    }
    if (Array.isArray(raw) && typeof raw[0] === 'string') {
        return raw[0] as string;
    }
    if (raw && typeof raw === 'object' && typeof (raw as { key?: string }).key === 'string') {
        return (raw as { key: string }).key;
    }
    return '';
}

/**
 * The "Set Prefs" panel: Game Settings plus the four control-binding
 * tabs. On OK it persists the game-settings toggles and any changed
 * bindings to localStorage (see client_prefs); the game start layers
 * them over the served defaults. Resolves when the dialog closes.
 */
export function showPreferencesDialog(baseControls: Record<string, unknown>):
    Promise<void> {
    return new Promise((resolve) => {
        const modal = makeModal('preferences-dialog');
        modal.panel.style.minWidth = '560px';

        const title = document.createElement('div');
        title.textContent = 'Preferences';
        Object.assign(title.style, {
            fontWeight: '600', textAlign: 'center', marginBottom: '12px',
        } as Partial<CSSStyleDeclaration>);
        modal.panel.appendChild(title);

        // Working copies; committed only on OK.
        const settings: GameSettingsOverride = { ...loadGameSettings() };
        const controlsOverride: ControlsOverride = { ...loadControlsOverride() };

        const tabBar = document.createElement('div');
        Object.assign(tabBar.style, {
            display: 'flex', gap: '2px', marginBottom: '10px',
            borderBottom: '1px solid #c4c4c4',
        } as Partial<CSSStyleDeclaration>);
        modal.panel.appendChild(tabBar);

        const content = document.createElement('div');
        Object.assign(content.style, {
            minHeight: '210px',
        } as Partial<CSSStyleDeclaration>);
        modal.panel.appendChild(content);

        const tabNames = ['Game Settings', ...CONTROL_TABS.map(t => t.name)];
        const tabButtons: HTMLButtonElement[] = [];
        let activeCapture: (() => void) | undefined;

        const showTab = (index: number) => {
            activeCapture?.();
            activeCapture = undefined;
            tabButtons.forEach((b, i) => {
                b.style.background = i === index ? '#2b6cff' : '#e4e4e4';
                b.style.color = i === index ? '#fff' : '#111';
            });
            content.innerHTML = '';
            if (index === 0) {
                content.appendChild(buildGameSettings(settings));
            } else {
                content.appendChild(buildControlTab(
                    CONTROL_TABS[index - 1], baseControls, controlsOverride,
                    (release) => { activeCapture = release; }));
            }
        };

        tabNames.forEach((name, index) => {
            const tab = document.createElement('button');
            tab.textContent = name;
            tab.dataset.testid = `prefs-tab-${index}`;
            Object.assign(tab.style, {
                padding: '5px 10px', fontSize: '12px', cursor: 'pointer',
                border: 'none', borderRadius: '5px 5px 0 0',
                background: '#e4e4e4',
            } as Partial<CSSStyleDeclaration>);
            tab.addEventListener('click', () => showTab(index));
            tabBar.appendChild(tab);
            tabButtons.push(tab);
        });

        const cancel = button('Cancel', 'prefs-cancel', false);
        const ok = button('OK', 'prefs-ok', true);
        modal.panel.appendChild(buttonRow(cancel, ok));

        const cleanup = () => {
            activeCapture?.();
            document.removeEventListener('keydown', onKey);
            modal.close();
        };
        const commit = () => {
            saveGameSettings(settings);
            saveControlsOverride(controlsOverride);
            cleanup();
            resolve();
        };
        const abort = () => { cleanup(); resolve(); };
        const onKey = (e: KeyboardEvent) => {
            // While capturing a key, let the capture handler consume it.
            if (activeCapture) { return; }
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); abort(); }
        };
        ok.addEventListener('click', commit);
        cancel.addEventListener('click', abort);
        document.addEventListener('keydown', onKey);
        showTab(0);
    });
}

function buildGameSettings(settings: GameSettingsOverride): HTMLElement {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, {
        display: 'flex', gap: '32px', padding: '4px 8px',
    } as Partial<CSSStyleDeclaration>);
    for (const column of GAME_SETTINGS) {
        const col = document.createElement('div');
        for (const toggle of column) {
            const row = document.createElement('label');
            Object.assign(row.style, {
                display: 'flex', alignItems: 'center', margin: '6px 0',
                color: toggle.applicable ? '#111' : '#aaa',
                cursor: toggle.applicable ? 'pointer' : 'default',
            } as Partial<CSSStyleDeclaration>);
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.disabled = !toggle.applicable;
            if (toggle.key) {
                box.dataset.testid = `prefs-setting-${toggle.key}`;
                const current = settings[toggle.key];
                box.checked = typeof current === 'boolean'
                    ? current : toggle.defaultOn;
                box.addEventListener('change', () => {
                    (settings[toggle.key!] as boolean) = box.checked;
                });
            } else {
                box.checked = toggle.defaultOn;
            }
            box.style.marginRight = '8px';
            row.appendChild(box);
            row.appendChild(document.createTextNode(toggle.label));
            col.appendChild(row);
        }
        wrap.appendChild(col);
    }
    // Sound Volume selector.
    const volRow = document.createElement('div');
    Object.assign(volRow.style, {
        marginTop: '12px', paddingLeft: '8px',
    } as Partial<CSSStyleDeclaration>);
    volRow.appendChild(document.createTextNode('Sound Volume: '));
    const vol = document.createElement('select');
    vol.dataset.testid = 'prefs-sound-volume';
    for (const [value, label] of [['muted', 'Muted'], ['quiet', 'Quiet'],
    ['normal', 'Normal'], ['loud', 'Loud']]) {
        const opt = document.createElement('option');
        opt.value = value; opt.textContent = label;
        vol.appendChild(opt);
    }
    vol.value = settings.soundVolume ?? 'normal';
    vol.addEventListener('change', () => { settings.soundVolume = vol.value; });
    volRow.appendChild(vol);
    const outer = document.createElement('div');
    outer.appendChild(wrap);
    outer.appendChild(volRow);
    return outer;
}

function buildControlTab(tab: { name: string, rows: ControlRow[] },
    baseControls: Record<string, unknown>, override: ControlsOverride,
    setCapture: (release: () => void) => void): HTMLElement {
    const grid = document.createElement('div');
    Object.assign(grid.style, {
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 24px',
        padding: '4px 8px',
    } as Partial<CSSStyleDeclaration>);

    for (const row of tab.rows) {
        const line = document.createElement('div');
        Object.assign(line.style, {
            display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
            gap: '8px',
        } as Partial<CSSStyleDeclaration>);
        const label = document.createElement('div');
        label.textContent = `${row.label}:`;
        label.style.color = row.action ? '#111' : '#aaa';
        line.appendChild(label);

        const capture = document.createElement('button');
        capture.dataset.testid = `prefs-bind-${row.action ?? row.label}`;
        Object.assign(capture.style, {
            width: '92px', padding: '4px 0', borderRadius: '12px',
            border: '1px solid #c0c0c0', background: '#fff',
            fontSize: '12px', textAlign: 'center',
            cursor: row.action ? 'pointer' : 'default',
            color: row.action ? '#111' : '#bbb',
        } as Partial<CSSStyleDeclaration>);

        if (!row.action) {
            capture.textContent = '—';
            capture.disabled = true;
            line.appendChild(capture);
            grid.appendChild(line);
            continue;
        }
        const action = row.action;
        const render = () => {
            capture.textContent =
                keyLabel(currentBinding(action, baseControls, override)) || '·';
        };
        render();

        capture.addEventListener('click', () => {
            capture.textContent = 'press…';
            capture.style.background = '#fff6cc';
            const onCapture = (e: KeyboardEvent) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.key !== 'Escape') {
                    override[action] = e.code;
                }
                release();
            };
            const release = () => {
                document.removeEventListener('keydown', onCapture, true);
                capture.style.background = '#fff';
                render();
                setCapture(() => { /* already released */ });
            };
            document.addEventListener('keydown', onCapture, true);
            setCapture(release);
        });
        line.appendChild(capture);
        grid.appendChild(line);
    }
    return grid;
}
