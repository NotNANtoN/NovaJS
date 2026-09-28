import { PreloadData } from 'novadatainterface/GameDataInterface';
import { PLANET_BUSTER_OUTFIT_ID } from '../common/debug_content';
import { isStellarDestroyed } from '../nova_plugin/player_state';
import { SystemIdResource } from '../nova_plugin/system_id_resource';
import { DebugClient, DebugClientHost, entryKey } from './debug_client';
import {
    catalogFrom,
    CatalogEntry,
    DEBUG_TOKEN_STORAGE_KEY,
    filterCatalog,
    parseBitNumber,
    parseWholeNumber,
    readDebugToken,
} from './debug_menu_model';

export interface DebugMenuHost extends DebugClientHost {
    gameData: DebugClientHost['gameData'] & { preloadData?: Promise<PreloadData> };
    /** Width of the right-hand status bar column, 0 when not shown. */
    statusBarWidth(): number;
}

const LIST_LIMIT = 60;
const ROOT_ATTRIBUTE = 'data-nova-debug';

const STYLE = `
[${ROOT_ATTRIBUTE}] { font: 12px/1.35 Geneva, Verdana, sans-serif; color: #c8d0ff; }
[${ROOT_ATTRIBUTE}] button { font: inherit; color: #e8ecff; background: #1c2350; border: 1px solid #5a66b0;
  border-radius: 2px; padding: 2px 7px; cursor: pointer; }
[${ROOT_ATTRIBUTE}] button:hover { background: #2c3778; }
[${ROOT_ATTRIBUTE}] button:disabled { opacity: .5; cursor: default; }
[${ROOT_ATTRIBUTE}] input, [${ROOT_ATTRIBUTE}] select { font: inherit; color: #fff; background: #05071a;
  border: 1px solid #47508f; padding: 2px 4px; box-sizing: border-box; }
[${ROOT_ATTRIBUTE}] .nd-section { border-top: 1px solid #333c7a; padding: 8px 10px; }
[${ROOT_ATTRIBUTE}] .nd-section h3 { margin: 0 0 6px; font-size: 12px; color: #9fb0ff; text-transform: uppercase;
  letter-spacing: .08em; }
[${ROOT_ATTRIBUTE}] .nd-row { display: flex; gap: 4px; align-items: center; margin: 3px 0; flex-wrap: wrap; }
[${ROOT_ATTRIBUTE}] .nd-list { max-height: 170px; overflow-y: auto; border: 1px solid #262d63; margin-top: 4px; }
[${ROOT_ATTRIBUTE}] .nd-item { display: flex; justify-content: space-between; gap: 6px; padding: 2px 4px;
  align-items: center; }
[${ROOT_ATTRIBUTE}] .nd-item:nth-child(odd) { background: #0b0f2c; }
[${ROOT_ATTRIBUTE}] .nd-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[${ROOT_ATTRIBUTE}] .nd-dim { color: #7880b0; }
[${ROOT_ATTRIBUTE}] .nd-big { width: 100%; padding: 6px; background: #5a1010; border-color: #ff5050;
  font-weight: bold; color: #ffd0d0; }
[${ROOT_ATTRIBUTE}] .nd-big:hover { background: #7a1818; }
`;

type Child = Node | string | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K,
    props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
    ...children: Child[]): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    Object.assign(element, props);
    for (const child of children) {
        if (child === undefined || child === false) continue;
        element.append(child);
    }
    return element;
}

function isTextEntry(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    const tag = element?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
        || Boolean(element?.isContentEditable);
}

/**
 * The in-game debug menu: a DEBUG button at the bottom of the right sidebar
 * and a DOM panel over the right side of the screen.
 */
export class DebugMenu {
    private readonly button: HTMLButtonElement;
    private readonly panel: HTMLDivElement;
    private readonly body: HTMLDivElement;
    private readonly status: HTMLDivElement;
    private readonly message: HTMLDivElement;
    private readonly client: DebugClient;
    private readonly refreshers: Array<() => void> = [];
    private catalog?: Promise<{
        ships: CatalogEntry[]; outfits: CatalogEntry[]; missions: CatalogEntry[];
        systems: CatalogEntry[]; planets: Map<string, { name: string; strength?: number }>;
        governments: CatalogEntry[];
    }>;
    private timer?: ReturnType<typeof setInterval>;
    private disposed = false;

    constructor(private readonly host: DebugMenuHost, debugToken: string, playerToken: string) {
        this.client = new DebugClient(debugToken, playerToken, host);
        document.head.append(el('style', { textContent: STYLE }));

        this.button = el('button', { textContent: 'DEBUG', title: 'Open the debug menu' });
        this.button.setAttribute(ROOT_ATTRIBUTE, '');
        Object.assign(this.button.style, {
            position: 'fixed', right: '0', bottom: '0', zIndex: '9000', display: 'none',
            padding: '3px 0', letterSpacing: '.15em', fontWeight: 'bold',
            background: '#3a0c0c', borderColor: '#b03030', color: '#ffb0b0',
        });
        this.button.addEventListener('click', () => {
            this.button.blur();
            this.toggle();
        });

        this.status = el('div', { className: 'nd-dim' });
        this.message = el('div');
        Object.assign(this.message.style, { minHeight: '16px', color: '#ffe080', whiteSpace: 'pre-wrap' });
        const close = el('button', { textContent: '✕', title: 'Close' });
        close.addEventListener('click', () => this.hide());
        const header = el('div', {},
            el('div', { className: 'nd-row' },
                el('strong', { textContent: 'NovaJS debug' }),
                el('span', { className: 'nd-dim', textContent: 'server-gated · every action is logged' }),
                close),
            this.status, this.message);
        Object.assign(header.style, { padding: '8px 10px', position: 'sticky', top: '0',
            background: '#080b22', zIndex: '1' });
        (header.firstChild as HTMLElement).style.justifyContent = 'space-between';
        this.body = el('div');
        this.panel = el('div', {}, header, this.body);
        this.panel.setAttribute(ROOT_ATTRIBUTE, '');
        this.panel.setAttribute('role', 'dialog');
        this.panel.setAttribute('aria-label', 'Debug menu');
        Object.assign(this.panel.style, {
            position: 'fixed', top: '0', bottom: '0', right: '0', width: '380px', maxWidth: '100vw',
            overflowY: 'auto', background: 'rgba(6, 8, 26, 0.96)', borderLeft: '2px solid #3b4690',
            zIndex: '9001', display: 'none', boxShadow: '-4px 0 16px rgba(0,0,0,.6)',
        });
        // Typing in the panel must not fly the ship: KeyboardPlugin listens on
        // document, so stop text-entry keys at the panel.
        for (const type of ['keydown', 'keyup', 'keypress'] as const) {
            this.panel.addEventListener(type, event => {
                if (isTextEntry(event.target)) event.stopPropagation();
                if (type === 'keydown' && (event as KeyboardEvent).key === 'Escape') {
                    event.stopPropagation();
                    this.hide();
                }
            });
        }
        document.body.append(this.button, this.panel);
        window.addEventListener('resize', () => this.layout());
        this.timer = setInterval(() => this.tick(), 500);
    }

    get visible(): boolean {
        return this.panel.style.display !== 'none';
    }

    toggle(): void {
        if (this.visible) this.hide();
        else this.show();
    }

    show(): void {
        if (this.body.childElementCount === 0) this.build();
        this.panel.style.display = 'block';
        this.refresh();
    }

    hide(): void {
        this.panel.style.display = 'none';
        (document.activeElement as HTMLElement | null)?.blur?.();
    }

    dispose(): void {
        this.disposed = true;
        clearInterval(this.timer);
        this.button.remove();
        this.panel.remove();
    }

    private layout(): void {
        const width = Math.max(90, Math.round(this.host.statusBarWidth()));
        this.button.style.width = `${width}px`;
    }

    private tick(): void {
        const inFlight = this.host.player() !== undefined;
        this.button.style.display = inFlight || this.visible ? 'block' : 'none';
        this.layout();
        if (this.visible) this.renderStatus();
    }

    private renderStatus(): void {
        const state = this.client.snapshot();
        const player = this.host.player();
        if (!state || !player) {
            this.status.textContent = 'Not in flight — actions need a ship in space.';
            return;
        }
        const system = player.world.resources.get(SystemIdResource) ?? state.currentSystem;
        const systemName = this.host.gameData.data.System.getCached(system)?.name ?? system;
        const hull = this.host.gameData.data.Ship.getCached(state.shipId)?.name ?? state.shipId;
        this.status.textContent = `${hull} (${state.shipId}) · ${state.credits.toLocaleString()} cr · `
            + `fuel ${Math.round(state.fuel ?? 0)} · ${systemName} · day ${state.gameDate}`;
    }

    private refresh(): void {
        this.renderStatus();
        for (const refresh of this.refreshers) {
            try { refresh(); } catch (error) { console.warn('[DEBUG] refresh failed', error); }
        }
    }

    private say(text: string, isError = false): void {
        this.message.textContent = text;
        this.message.style.color = isError ? '#ff8080' : '#ffe080';
    }

    /** Wrap an action: report success/failure and refresh the panel. */
    private act(label: string, work: () => unknown | Promise<unknown>): () => void {
        return () => {
            this.say(`${label}…`);
            void Promise.resolve().then(work).then(result => {
                this.say(typeof result === 'string' ? result : `${label}: done`);
                setTimeout(() => this.refresh(), 150);
            }, error => {
                console.warn(`[DEBUG] ${label} failed`, error);
                this.say(`${label} failed: ${error instanceof Error ? error.message : error}`, true);
            });
        };
    }

    private loadCatalog() {
        this.catalog ??= (async () => {
            const preload = (await this.host.gameData.preloadData) ?? {};
            const planets = new Map(Object.entries(preload.Planet ?? {}).map(([id, planet]) =>
                [id, { name: planet?.name || id, strength: planet?.strength }] as const));
            return {
                ships: catalogFrom(preload.Ship as any, { hideZeroWeight: true }),
                outfits: catalogFrom(preload.Outfit as any, { hideZeroWeight: true }),
                missions: catalogFrom(preload.Mission as any),
                systems: catalogFrom(preload.System as any),
                planets,
                governments: catalogFrom(preload.Govt as any),
            };
        })();
        return this.catalog;
    }

    private section(title: string, ...children: Child[]): HTMLElement {
        return el('div', { className: 'nd-section' }, el('h3', { textContent: title }), ...children);
    }

    private makeButton(label: string, onClick: () => void, title?: string): HTMLButtonElement {
        const button = el('button', { textContent: label, ...(title ? { title } : {}) });
        button.addEventListener('click', () => {
            button.blur();
            onClick();
        });
        return button;
    }

    /** A search box over a catalog with per-row action buttons. */
    private searchList(placeholder: string,
        entries: () => Promise<CatalogEntry[]>,
        actions: (entry: CatalogEntry) => Child[],
        options: { hiddenToggle?: string } = {}): HTMLElement {
        const search = el('input', { type: 'search', placeholder });
        search.style.flex = '1';
        const list = el('div', { className: 'nd-list' });
        const showHidden = el('input', { type: 'checkbox' });
        const render = async () => {
            const all = await entries();
            if (this.disposed) return;
            const matches = filterCatalog(all, search.value, {
                includeHidden: showHidden.checked, limit: LIST_LIMIT });
            list.replaceChildren(...matches.map(entry => el('div', { className: 'nd-item' },
                el('span', { textContent: `${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`,
                    title: entry.id }),
                el('span', {}, el('span', { className: 'nd-dim', textContent: `${entry.id} ` }),
                    ...actions(entry)))));
            if (matches.length === 0) list.append(el('div', { className: 'nd-item nd-dim', textContent: 'No matches' }));
        };
        search.addEventListener('input', () => void render());
        showHidden.addEventListener('change', () => void render());
        this.refreshers.push(() => void render());
        return el('div', {},
            el('div', { className: 'nd-row' }, search,
                options.hiddenToggle ? el('label', { className: 'nd-dim' }, showHidden, ` ${options.hiddenToggle}`) : undefined),
            list);
    }

    private build(): void {
        const client = this.client;
        const catalog = () => this.loadCatalog();

        // a. Ship
        const ship = this.section('Ship',
            this.searchList('Search hulls (name or id)…', async () => (await catalog()).ships,
                entry => [this.makeButton('Switch', this.act(`Switch to ${entry.name}`, async () => {
                    const hull = await client.switchShip(entry.id);
                    return `Now flying ${hull.name}`;
                }))], { hiddenToggle: 'show NPC-only hulls' }));

        // b. Outfits
        const count = el('input', { type: 'number', value: '1', min: '1' });
        count.style.width = '60px';
        const amount = () => parseWholeNumber(count.value, 1, 100_000) ?? 1;
        const buster = el('button', { className: 'nd-big', textContent: 'GIVE PLANET BUSTER' });
        buster.addEventListener('click', () => {
            buster.blur();
            this.act('Planet Buster', async () => {
                const held = await client.givePlanetBuster();
                return held > 0
                    ? 'Planet Buster installed: select it as your secondary weapon (W) and fire at a destroyable stellar.'
                    : 'Planet Buster removed.';
            })();
        });
        const installed = el('div', { className: 'nd-dim' });
        this.refreshers.push(() => {
            const outfits = client.outfits();
            installed.textContent = `Installed: ${[...outfits].map(([id, { count }]) =>
                `${this.host.gameData.data.Outfit.getCached(id)?.name ?? id}×${count}`).join(', ') || 'nothing'}`;
            buster.textContent = outfits.has(PLANET_BUSTER_OUTFIT_ID)
                ? 'REMOVE PLANET BUSTER' : 'GIVE PLANET BUSTER';
        });
        const outfits = this.section('Outfits & weapons', buster,
            el('div', { className: 'nd-row' }, 'Count', count),
            this.searchList('Search outfits…', async () => (await catalog()).outfits,
                entry => [
                    this.makeButton('Give', this.act(`Give ${entry.name}`, () => client.adjustOutfit(entry.id, amount()))),
                    this.makeButton('Remove', this.act(`Remove ${entry.name}`, () => client.adjustOutfit(entry.id, -amount()))),
                ], { hiddenToggle: 'show hidden' }),
            installed);

        // c. Credits
        const credits = el('input', { type: 'text', value: '1000000', inputMode: 'numeric' });
        credits.style.width = '120px';
        const creditValue = () => {
            const value = parseWholeNumber(credits.value, -2_000_000_000, 2_000_000_000);
            if (value === undefined) throw new Error('Enter a whole number');
            return value;
        };
        const money = this.section('Credits', el('div', { className: 'nd-row' }, credits,
            this.makeButton('Set', this.act('Set credits', async () => `Credits: ${(await client.credits('set', Math.max(0, creditValue()))).toLocaleString()}`)),
            this.makeButton('Add', this.act('Add credits', async () => `Credits: ${(await client.credits('add', creditValue())).toLocaleString()}`))));

        // d. Missions & control bits
        const bitInput = el('input', { type: 'text', placeholder: 'bit #' });
        bitInput.style.width = '70px';
        const bitValue = () => {
            const bit = parseBitNumber(bitInput.value);
            if (bit === undefined) throw new Error('Bits are 0-9999');
            return bit;
        };
        const bitsSummary = el('div', { className: 'nd-dim' });
        this.refreshers.push(() => {
            const bits = client.snapshot()?.missionBits ?? [];
            const on = bits.flatMap((value, bit) => value ? [bit] : []);
            bitsSummary.textContent = `Set bits (${on.length}): ${on.slice(0, 120).join(' ')}${on.length > 120 ? ' …' : ''}`;
        });
        const ncb = el('input', { type: 'text', placeholder: 'NCB set expression, e.g. b100 b101 !b5 S250' });
        ncb.style.flex = '1';
        const activeList = el('div', { className: 'nd-list' });
        this.refreshers.push(() => {
            const active = client.snapshot()?.activeMissions ?? [];
            activeList.replaceChildren(...active.map(entry => {
                const key = entryKey(entry);
                const name = this.host.gameData.data.Mission?.getCached(entry.missionId)?.name ?? entry.missionId;
                return el('div', { className: 'nd-item' },
                    el('span', { textContent: `${name} [${entry.state}]`, title: entry.missionId }),
                    el('span', {},
                        this.makeButton('Complete', this.act(`Complete ${name}`, () => client.completeMission(key))),
                        this.makeButton('Abort', this.act(`Abort ${name}`, () => client.abortMission(key)))));
            }));
            if (active.length === 0) activeList.append(el('div', { className: 'nd-item nd-dim', textContent: 'No active missions' }));
        });
        const missions = this.section('Missions & control bits',
            el('div', { className: 'nd-row' }, bitInput,
                this.makeButton('Get', this.act('Get bit', () => `b${bitValue()} is ${client.getBit(bitValue()) ? 'SET' : 'clear'}`)),
                this.makeButton('Set', this.act('Set bit', () => { client.setBit(bitValue(), true); return `b${bitValue()} set`; })),
                this.makeButton('Clear', this.act('Clear bit', () => { client.setBit(bitValue(), false); return `b${bitValue()} cleared`; }))),
            bitsSummary,
            el('div', { className: 'nd-row' }, ncb,
                this.makeButton('Run', this.act('Run NCB', async () => {
                    if (!ncb.value.trim()) throw new Error('Enter an expression');
                    await client.runNcb(ncb.value);
                    return `Ran: ${ncb.value}`;
                }))),
            el('div', { className: 'nd-dim', textContent: 'Active missions' }), activeList,
            this.searchList('Search missions to force-accept…', async () => (await catalog()).missions,
                entry => [this.makeButton('Accept', this.act(`Accept ${entry.name}`, () => client.acceptMission(entry.id)))]));

        // e. World
        const days = el('input', { type: 'number', value: '1', min: '1' });
        days.style.width = '60px';
        const govt = el('select');
        const record = el('input', { type: 'text', value: '0' });
        record.style.width = '70px';
        void catalog().then(({ governments }) => !this.disposed && govt.replaceChildren(
            ...filterCatalog(governments, '').map(entry => el('option', { value: entry.id, textContent: `${entry.name} (${entry.id})` }))));
        govt.style.maxWidth = '170px';
        const world = this.section('World',
            el('div', { className: 'nd-row' },
                this.makeButton('Refuel', this.act('Refuel', () => client.refuel())),
                this.makeButton('Repair', this.act('Repair', () => client.repair()), 'Full shield and armor')),
            el('div', { className: 'nd-row' }, 'Advance', days, 'days',
                this.makeButton('Go', this.act('Advance date', () => {
                    const value = parseWholeNumber(days.value, 1, 3650);
                    if (value === undefined) throw new Error('1-3650 days');
                    return `Day ${client.advanceDays(value)} (crons/expiry/regeneration run next tick)`;
                }))),
            el('div', { className: 'nd-row' }, 'Legal record', govt, record,
                this.makeButton('Set', this.act('Set legal record', () => {
                    const value = parseWholeNumber(record.value, -1_000_000, 1_000_000);
                    if (value === undefined || !govt.value) throw new Error('Pick a government and a number');
                    client.setLegalRecord(govt.value, value);
                }))),
            this.searchList('Jump to system…', async () => (await catalog()).systems,
                entry => [this.makeButton('Jump', this.act(`Jump to ${entry.name}`, () => client.jumpTo(entry.id)))]));

        // f. Stellars in the current system
        const stellarList = el('div', { className: 'nd-list' });
        this.refreshers.push(() => void catalog().then(({ planets }) => {
            if (this.disposed) return;
            const player = this.host.player();
            const state = client.snapshot();
            const systemId = player?.world.resources.get(SystemIdResource) ?? state?.currentSystem;
            const system = systemId ? this.host.gameData.data.System.getCached(systemId) : undefined;
            stellarList.replaceChildren(...(system?.planets ?? []).map(id => {
                const planet = planets.get(id);
                const destroyed = state ? isStellarDestroyed(state, id) : false;
                const strength = planet?.strength ?? 0;
                return el('div', { className: 'nd-item' },
                    el('span', { textContent: `${planet?.name ?? id}${destroyed ? ' [DESTROYED]' : ''}`,
                        title: `${id} · Strength ${strength > 0 ? strength : 'invincible'}` }),
                    el('span', {},
                        this.makeButton('Destroy', this.act(`Destroy ${planet?.name ?? id}`, async () =>
                            (await client.setStellar(id, true)).message ?? 'Destroyed (for you)'))),
                        this.makeButton('Regenerate', this.act(`Regenerate ${planet?.name ?? id}`, async () =>
                            (await client.setStellar(id, false)).message ?? 'Regenerated')));
            }));
            if (!system) stellarList.append(el('div', { className: 'nd-item nd-dim', textContent: 'Not in a system' }));
        }));
        const stellars = this.section('Stellars (this system, for you only)', stellarList);

        const forget = this.makeButton('Forget debug token', () => {
            try { localStorage.removeItem(DEBUG_TOKEN_STORAGE_KEY); } catch { /* storage unavailable */ }
            this.say('Token forgotten; reload to hide the menu.');
        });
        this.body.append(ship, outfits, money, missions, world, stellars,
            el('div', { className: 'nd-section' }, forget));
    }
}

/**
 * Enables the debug menu when this browser holds a debug token the server
 * accepts. Removes the token from the address bar once stored.
 */
export async function installDebugMenu(host: DebugMenuHost, playerToken: string,
    fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<DebugMenu | undefined> {
    let storage: Storage | undefined;
    try { storage = localStorage; } catch { storage = undefined; }
    const token = readDebugToken(window.location.search, storage);
    try {
        const url = new URL(window.location.href);
        if (url.searchParams.has('debug')) {
            url.searchParams.delete('debug');
            window.history.replaceState(window.history.state, '', url.toString());
        }
    } catch { /* non-standard location */ }
    if (!token) return undefined;
    try {
        const response = await fetchImpl(`/debug/status?token=${encodeURIComponent(token)}`,
            { cache: 'no-store' });
        if (!response.ok) {
            if (response.status === 403) storage?.removeItem(DEBUG_TOKEN_STORAGE_KEY);
            console.warn(`[DEBUG] Debug menu unavailable (HTTP ${response.status})`);
            return undefined;
        }
    } catch (error) {
        console.warn('[DEBUG] Debug status check failed', error);
        return undefined;
    }
    console.info('[DEBUG] Debug menu enabled');
    return new DebugMenu(host, token, playerToken);
}
