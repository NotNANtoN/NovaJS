import "jasmine";
import * as PIXI from "pixi.js";
import { EMPTY } from "rxjs";
import { MockGameData } from "novadatainterface/MockGameData";
import {
    CLASSIC_MAC_FONT,
    CLASSIC_MAC_TITLE_FONT,
    ClassicDialog,
    ClassicDialogConfig,
    DEFAULT_DIALOG_BACKGROUND,
} from "./classic_dialog";

describe("ClassicDialog configuration and layout specs", () => {
    it("exports authentic Classic Mac OS font defaults", () => {
        expect(CLASSIC_MAC_FONT.fontFamily).toContain("Geneva");
        expect(CLASSIC_MAC_FONT.fontSize).toBe(11);
        expect(CLASSIC_MAC_FONT.fill).toBe(0xffffff);

        expect(CLASSIC_MAC_TITLE_FONT.fontFamily).toContain("Geneva");
        expect(CLASSIC_MAC_TITLE_FONT.fontWeight).toBe("bold");
        expect(CLASSIC_MAC_TITLE_FONT.fill).toBe(0xffd588);
    });

    it("defines default dialog background resource", () => {
        expect(DEFAULT_DIALOG_BACKGROUND).toBe("nova:8517");
    });

    it("supports declarative text and columns configuration", () => {
        interface SamplePilot {
            name: string;
            credits: number;
            rating: string;
        }

        const config: ClassicDialogConfig<SamplePilot> = {
            title: (p) => `Status: ${p.name}`,
            subtitle: "Terran Trade Authority",
            sections: [
                {
                    type: "text",
                    id: "bio",
                    position: { x: -200, y: -40 },
                    width: 400,
                    content: "Licensed pilot in good standing.",
                },
                {
                    type: "columns",
                    id: "specs",
                    position: { x: -200, y: 10 },
                    colWidth: 150,
                    items: [
                        { label: "Cash on Hand", value: (p) => `${p.credits} cr` },
                        { label: "Combat Rating", value: (p) => p.rating },
                    ],
                },
            ],
            buttons: [
                {
                    id: "confirm",
                    label: "Acknowledge",
                    position: { x: 80, y: 50 },
                    isDefault: true,
                    action: () => undefined,
                },
                {
                    id: "cancel",
                    label: "Dismiss",
                    position: { x: 150, y: 50 },
                    isCancel: true,
                    action: () => undefined,
                },
            ],
        };

        expect(typeof config.title).toBe("function");
        expect((config.title as Function)({ name: "Vance", credits: 1000, rating: "Deadly" }))
            .toBe("Status: Vance");
        expect(config.sections?.length).toBe(2);
        expect(config.buttons?.length).toBe(2);
        expect(config.buttons?.[0].isDefault).toBeTrue();
        expect(config.buttons?.[1].isCancel).toBeTrue();
    });

    it("dismisses with Enter or Space keyboard events on default button", async () => {
        const originalWindow = (globalThis as any).window;
        const listeners: Record<string, ((e: any) => void)[]> = {};
        (globalThis as any).window = {
            addEventListener: (type: string, fn: (e: any) => void) => {
                (listeners[type] = listeners[type] || []).push(fn);
            },
            removeEventListener: (type: string, fn: (e: any) => void) => {
                listeners[type] = (listeners[type] || []).filter(l => l !== fn);
            },
            dispatchEvent: (e: any) => {
                listeners[e.type]?.forEach(fn => fn(e));
            },
        };

        try {
            const gameData = new MockGameData() as any;
            gameData.spriteFromPict = () => new PIXI.Sprite(PIXI.Texture.EMPTY);
            gameData.spriteFromPictAsync = async () => new PIXI.Sprite(PIXI.Texture.EMPTY);
            gameData.textureFromPict = () => PIXI.Texture.EMPTY;
            gameData.textureFromPictAsync = async () => PIXI.Texture.EMPTY;
            let acknowledged = false;
            const dialog = new ClassicDialog(gameData, EMPTY, {
                title: "Test Dialog",
                buttons: [
                    {
                        id: "ok",
                        label: "OK",
                        width: 50,
                        position: { x: 0, y: 0 },
                        isDefault: true,
                        action: () => {
                            acknowledged = true;
                        },
                    },
                ],
            });

            const showPromise = dialog.show(undefined);
            await new Promise(r => setTimeout(r, 0));
            expect(dialog.container.visible).toBeTrue();

            // Simulate Enter keydown
            (globalThis as any).window.dispatchEvent({ type: "keydown", key: "Enter", preventDefault() {}, stopPropagation() {} });
            await showPromise;

            expect(acknowledged).toBeTrue();
            expect(dialog.container.visible).toBeFalse();
        } finally {
            (globalThis as any).window = originalWindow;
        }
    });

    it("dismisses with Escape keyboard event on cancel button", async () => {
        const originalWindow = (globalThis as any).window;
        const listeners: Record<string, ((e: any) => void)[]> = {};
        (globalThis as any).window = {
            addEventListener: (type: string, fn: (e: any) => void) => {
                (listeners[type] = listeners[type] || []).push(fn);
            },
            removeEventListener: (type: string, fn: (e: any) => void) => {
                listeners[type] = (listeners[type] || []).filter(l => l !== fn);
            },
            dispatchEvent: (e: any) => {
                listeners[e.type]?.forEach(fn => fn(e));
            },
        };

        try {
            const gameData = new MockGameData() as any;
            gameData.spriteFromPict = () => new PIXI.Sprite(PIXI.Texture.EMPTY);
            gameData.spriteFromPictAsync = async () => new PIXI.Sprite(PIXI.Texture.EMPTY);
            gameData.textureFromPict = () => PIXI.Texture.EMPTY;
            gameData.textureFromPictAsync = async () => PIXI.Texture.EMPTY;
            let cancelled = false;
            const dialog = new ClassicDialog(gameData, EMPTY, {
                title: "Prompt",
                buttons: [
                    {
                        id: "close",
                        label: "Cancel",
                        width: 50,
                        position: { x: 0, y: 0 },
                        isCancel: true,
                        action: () => {
                            cancelled = true;
                        },
                    },
                ],
            });

            const showPromise = dialog.show(undefined);
            await new Promise(r => setTimeout(r, 0));
            expect(dialog.container.visible).toBeTrue();

            // Simulate Escape keydown
            (globalThis as any).window.dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {}, stopPropagation() {} });
            await showPromise;

            expect(cancelled).toBeTrue();
            expect(dialog.container.visible).toBeFalse();
        } finally {
            (globalThis as any).window = originalWindow;
        }
    });
});
