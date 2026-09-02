import "jasmine";
import {
    CLASSIC_MAC_FONT,
    CLASSIC_MAC_TITLE_FONT,
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
});
