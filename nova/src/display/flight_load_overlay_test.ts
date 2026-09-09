import 'jasmine';
import {
    hideEnteringOverlay,
    setEnteringProgress,
    showEnteringOverlay,
    showFlightLoadError,
} from './flight_load_overlay';

class FakeElement {
    tagName: string;
    style: any;
    dataset: Record<string, string> = {};
    children: FakeElement[] = [];
    parentElement: FakeElement | null = null;
    private rawText: string = '';
    listeners: Record<string, Function[]> = {};

    constructor(tag: string) {
        this.tagName = tag.toUpperCase();
        this.style = {
            _cssText: '',
            get cssText() { return this._cssText; },
            set cssText(val: string) { this._cssText = val; },
        };
    }

    get textContent(): string {
        const childText = this.children.map(c => c.textContent).join('');
        return this.rawText + childText;
    }

    set textContent(val: string) {
        this.rawText = val;
        this.children = [];
    }

    setAttribute(name: string, val: string) {
        if (name === 'style') {
            this.style.cssText = val;
        }
    }

    appendChild(child: FakeElement) {
        this.append(child);
        return child;
    }

    append(...items: (FakeElement | string)[]) {
        for (const item of items) {
            if (typeof item === 'string') {
                this.rawText += item;
            } else {
                item.parentElement = this;
                this.children.push(item);
            }
        }
    }

    remove() {
        if (this.parentElement) {
            this.parentElement.children = this.parentElement.children.filter(c => c !== this);
            this.parentElement = null;
        }
    }

    addEventListener(event: string, callback: Function) {
        this.listeners[event] = this.listeners[event] ?? [];
        this.listeners[event].push(callback);
    }

    click() {
        for (const cb of this.listeners['click'] ?? []) {
            cb();
        }
    }

    querySelector(selector: string): FakeElement | null {
        for (const child of this.children) {
            if (child.matches(selector)) return child;
            const nested = child.querySelector(selector);
            if (nested) return nested;
        }
        return null;
    }

    matches(selector: string): boolean {
        if (selector === 'button' && this.tagName === 'BUTTON') return true;
        if (selector === 'span' && this.tagName === 'SPAN') return true;
        if (selector.startsWith('[data-nova-overlay=')) {
            const val = selector.slice('[data-nova-overlay="'.length, -2);
            return this.dataset.novaOverlay === val;
        }
        if (selector === '[data-nova-progress-bar="fill"]') {
            return this.dataset.novaProgressBar === 'fill';
        }
        if (selector.includes('linear-gradient')) {
            return (this.style.cssText ?? '').includes('linear-gradient')
                || (this.style.background ?? '').includes('linear-gradient')
                || (this.style.width !== undefined);
        }
        return false;
    }
}

describe('flight load overlay', () => {
    let oldDoc: PropertyDescriptor | undefined;
    let fakeBody: FakeElement;

    beforeAll(() => {
        oldDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
        fakeBody = new FakeElement('body');
        const fakeDoc = {
            body: fakeBody,
            head: new FakeElement('head'),
            createElement: (tag: string) => new FakeElement(tag),
            getElementById: () => null,
            querySelector: (sel: string) => fakeBody.querySelector(sel),
        };
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: fakeDoc,
        });
    });

    afterAll(() => {
        if (oldDoc) Object.defineProperty(globalThis, 'document', oldDoc);
        else Reflect.deleteProperty(globalThis, 'document');
    });

    beforeEach(() => {
        hideEnteringOverlay();
    });

    afterEach(() => {
        hideEnteringOverlay();
    });

    it('creates an overlay with an EV Nova styled progress bar and status text', () => {
        showEnteringOverlay('Entering Sol', 25, 'Loading textures (10/40)');
        const overlay = (document as any).querySelector('[data-nova-overlay="entering"]') as FakeElement;
        expect(overlay).toBeTruthy();

        const status = overlay.querySelector('span') as FakeElement;
        expect(status.textContent).toContain('Entering Sol');

        const fill = overlay.querySelector('[data-nova-progress-bar="fill"]') as FakeElement;
        expect(fill).toBeTruthy();
        expect(fill.style.width).toBe('25%');

        expect(overlay.textContent).toContain('25%');
        expect(overlay.textContent).toContain('Loading textures (10/40)');
    });

    it('updates progress and clamps percentages to 0-100%', () => {
        showEnteringOverlay('Entering System');
        setEnteringProgress(150, 'Finished');
        const overlay = (document as any).querySelector('[data-nova-overlay="entering"]') as FakeElement;
        expect(overlay.textContent).toContain('100%');

        setEnteringProgress(-20, 'Rewind');
        expect(overlay.textContent).toContain('0%');

        setEnteringProgress(78, 'Almost ready');
        expect(overlay.textContent).toContain('78%');
        expect(overlay.textContent).toContain('Almost ready');
    });

    it('hides progress bar and shows error panel when flight load fails', async () => {
        showEnteringOverlay('Entering Sol', 50);
        const errorPromise = showFlightLoadError(new Error('Network timeout during asset download'));
        const overlay = (document as any).querySelector('[data-nova-overlay="entering"]') as FakeElement;
        expect(overlay.textContent).toContain('Network timeout during asset download');

        const button = overlay.querySelector('button') as FakeElement;
        expect(button).toBeTruthy();
        expect(button.textContent).toBe('Return to menu');

        button.click();
        await errorPromise;
        expect((document as any).querySelector('[data-nova-overlay="entering"]')).toBeNull();
    });

    it('completely removes overlay on hide', () => {
        showEnteringOverlay('Entering Sol', 80);
        expect((document as any).querySelector('[data-nova-overlay="entering"]')).toBeTruthy();
        hideEnteringOverlay();
        expect((document as any).querySelector('[data-nova-overlay="entering"]')).toBeNull();
    });
});
