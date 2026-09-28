import 'jasmine';
import { MockGameData } from 'novadatainterface/MockGameData';
import { installDebugMenu } from './debug_menu';
import { DEBUG_TOKEN_STORAGE_KEY } from './debug_menu_model';

/** Just enough DOM for the debug menu (the project has no jsdom). */
class FakeElement {
    tagName: string;
    style: Record<string, string> = {};
    children: FakeElement[] = [];
    parentElement: FakeElement | null = null;
    attributes = new Map<string, string>();
    listeners: Record<string, Function[]> = {};
    textContent = '';
    value = '';
    checked = false;
    [key: string]: any;

    constructor(tag: string) { this.tagName = tag.toUpperCase(); }
    get childElementCount() { return this.children.length; }
    get firstChild() { return this.children[0] ?? null; }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    append(...items: (FakeElement | string)[]) {
        for (const item of items) {
            if (typeof item === 'string') { this.textContent += item; continue; }
            item.parentElement = this;
            this.children.push(item);
        }
    }
    replaceChildren(...items: FakeElement[]) { this.children = []; this.append(...items); }
    remove() {
        if (this.parentElement) {
            this.parentElement.children = this.parentElement.children.filter(c => c !== this);
        }
        this.parentElement = null;
    }
    addEventListener(type: string, callback: Function) {
        (this.listeners[type] ??= []).push(callback);
    }
    dispatch(type: string, event: Record<string, unknown> = {}) {
        let stopped = false;
        const full = { target: this, stopPropagation: () => { stopped = true; }, ...event };
        for (const callback of this.listeners[type] ?? []) callback(full);
        return stopped;
    }
    blur() { }
    all(): FakeElement[] { return [this, ...this.children.flatMap(child => child.all())]; }
    find(predicate: (el: FakeElement) => boolean) { return this.all().find(predicate); }
}

describe('debug menu DOM', () => {
    let saved: Record<string, PropertyDescriptor | undefined>;
    let body: FakeElement;
    let storage: Map<string, string>;
    let search: string;

    function define(name: string, value: unknown) {
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }

    beforeEach(() => {
        saved = Object.fromEntries(['document', 'window', 'localStorage']
            .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
        body = new FakeElement('body');
        storage = new Map();
        search = '?debug=secret-token';
        define('document', { body, head: new FakeElement('head'),
            createElement: (tag: string) => new FakeElement(tag), activeElement: null });
        define('localStorage', {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
        });
        define('window', {
            get location() { return { search, href: `http://localhost/${search}` }; },
            history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => {
                search = new URL(url).search;
            } },
            addEventListener: () => undefined,
        });
    });

    afterEach(() => {
        for (const [name, descriptor] of Object.entries(saved)) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    });

    const host = () => ({ gameData: new MockGameData(), player: () => undefined, statusBarWidth: () => 194 });

    it('stays hidden when the server refuses the token, and forgets it', async () => {
        const calls: string[] = [];
        const menu = await installDebugMenu(host(), 'pilot', (async (url: string) => {
            calls.push(url);
            return { ok: false, status: 403 };
        }) as any);
        expect(menu).toBeUndefined();
        expect(calls).toEqual(['/debug/status?token=secret-token']);
        expect(storage.has(DEBUG_TOKEN_STORAGE_KEY)).toBeFalse();
        expect(body.children.length).toBe(0);
        expect(search).toBe('');
    });

    it('stays hidden without a token and never calls the server', async () => {
        search = '';
        const menu = await installDebugMenu(host(), 'pilot', (async () => {
            throw new Error('unexpected fetch');
        }) as any);
        expect(menu).toBeUndefined();
    });

    it('adds a DEBUG button and a closable panel that keeps typing away from the game', async () => {
        const menu = await installDebugMenu(host(), 'pilot',
            (async () => ({ ok: true, status: 200 })) as any);
        expect(menu).toBeDefined();
        try {
            expect(storage.get(DEBUG_TOKEN_STORAGE_KEY)).toBe('secret-token');
            const button = body.find(el => el.tagName === 'BUTTON' && el.textContent === 'DEBUG')!;
            const panel = body.find(el => el.attributes.get('role') === 'dialog')!;
            expect(button).toBeDefined();
            expect(button.style.bottom).toBe('0');
            expect(panel.style.display).toBe('none');

            button.dispatch('click');
            expect(menu!.visible).toBeTrue();
            expect(panel.find(el => el.textContent === 'GIVE PLANET BUSTER')).toBeDefined();
            expect(panel.find(el => el.tagName === 'H3' && el.textContent === 'Stellars (this system, for you only)'))
                .toBeDefined();

            const input = panel.find(el => el.tagName === 'INPUT')!;
            const fromInput = { target: input, key: 'w', stopPropagation: jasmine.createSpy() };
            for (const listener of panel.listeners.keydown) listener(fromInput);
            expect(fromInput.stopPropagation).toHaveBeenCalled();
            const fromButton = { target: button, key: 'w', stopPropagation: jasmine.createSpy() };
            for (const listener of panel.listeners.keydown) listener(fromButton);
            expect(fromButton.stopPropagation).not.toHaveBeenCalled();

            for (const listener of panel.listeners.keydown) {
                listener({ target: input, key: 'Escape', stopPropagation: () => undefined });
            }
            expect(menu!.visible).toBeFalse();
        } finally {
            menu?.dispose();
        }
    });
});
