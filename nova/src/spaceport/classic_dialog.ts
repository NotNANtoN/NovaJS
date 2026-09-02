import * as PIXI from "pixi.js";
import { Observable } from "rxjs";
import { GameData } from "../client/gamedata/GameData";
import { ControlEvent } from "../nova_plugin/controls_plugin";
import { Button } from "./button";
import { Menu } from "./menu";

export const CLASSIC_MAC_FONT = {
    fontFamily: "Geneva, Monaco, Chicago, Arial, sans-serif",
    fontSize: 11,
    fill: 0xffffff,
    align: "left",
} as const;

export const CLASSIC_MAC_TITLE_FONT = {
    fontFamily: "Geneva, Chicago, Arial, sans-serif",
    fontSize: 13,
    fontWeight: "bold" as const,
    fill: 0xffd588,
    align: "center" as const,
};

export interface ClassicDialogPosition {
    x: number;
    y: number;
}

export type ClassicDialogTextSection<TData> = {
    type: "text";
    id?: string;
    position: ClassicDialogPosition;
    content: string | ((data: TData) => string);
    style?: Partial<PIXI.ITextStyle>;
    width?: number;
};

export type ClassicDialogColumnsSection<TData> = {
    type: "columns";
    id?: string;
    position: ClassicDialogPosition;
    colWidth?: number;
    items: Array<{
        label: string;
        value: string | ((data: TData) => string);
        color?: number;
    }>;
};

export type ClassicDialogCustomSection<TData> = {
    type: "custom";
    id?: string;
    render: (
        container: PIXI.Container,
        data: TData,
        gameData: GameData,
    ) => void | Promise<void>;
};

export type ClassicDialogSection<TData> =
    | ClassicDialogTextSection<TData>
    | ClassicDialogColumnsSection<TData>
    | ClassicDialogCustomSection<TData>;

export interface ClassicDialogButton<TData> {
    id: string;
    label: string;
    width?: number;
    position: ClassicDialogPosition;
    isDefault?: boolean;
    isCancel?: boolean;
    action?: (
        dialog: ClassicDialog<TData>,
        data: TData,
    ) => void | TData | Promise<void | TData>;
}

export interface ClassicDialogConfig<TData> {
    background?: string;
    title?: string | ((data: TData) => string);
    titlePosition?: ClassicDialogPosition;
    titleStyle?: Partial<PIXI.ITextStyle>;
    subtitle?: string | ((data: TData) => string);
    subtitlePosition?: ClassicDialogPosition;
    sections?: ClassicDialogSection<TData>[];
    buttons?: ClassicDialogButton<TData>[];
    onShow?: (
        dialog: ClassicDialog<TData>,
        data: TData,
    ) => void | Promise<void>;
    customControls?: Record<
        string,
        (dialog: ClassicDialog<TData>, data: TData) => void
    >;
}

export const DEFAULT_DIALOG_BACKGROUND = "nova:8517";

/**
 * Declarative Classic Mac OS Dialog for Escape Velocity Nova spaceport,
 * info sheets, prompts, notices, and interactions.
 */
export class ClassicDialog<TData> extends Menu<TData> {
    private readonly titleText = new PIXI.Text("", CLASSIC_MAC_TITLE_FONT);
    private readonly subtitleText = new PIXI.Text("", {
        ...CLASSIC_MAC_FONT,
        fontSize: 10,
        fill: 0xb0b0b0,
        align: "center",
    });
    private readonly sectionContainers = new Map<string, PIXI.Container>();
    private readonly sectionTexts = new Map<string, PIXI.Text>();
    private readonly buttonsMap = new Map<string, Button>();
    private customOutput?: TData;

    constructor(
        gameData: GameData,
        controlEvents: Observable<ControlEvent>,
        private readonly config: ClassicDialogConfig<TData>,
    ) {
        super(
            gameData,
            config.background || DEFAULT_DIALOG_BACKGROUND,
            controlEvents,
        );

        // Title setup
        const titlePos = config.titlePosition || { x: 0, y: -68 };
        this.titleText.anchor.set(0.5, 0);
        this.titleText.position.set(titlePos.x, titlePos.y);
        if (config.titleStyle) {
            Object.assign(this.titleText.style, config.titleStyle);
        }
        this.container.addChild(this.titleText);

        // Subtitle setup
        if (config.subtitle) {
            const subPos = config.subtitlePosition || { x: 0, y: titlePos.y + 18 };
            this.subtitleText.anchor.set(0.5, 0);
            this.subtitleText.position.set(subPos.x, subPos.y);
            this.container.addChild(this.subtitleText);
        }

        // Setup sections
        for (let i = 0; i < (config.sections || []).length; i++) {
            const sec = config.sections![i];
            const sectionId = sec.id || `section_${i}`;

            if (sec.type === "text") {
                const style: Partial<PIXI.ITextStyle> = {
                    ...CLASSIC_MAC_FONT,
                    ...(sec.width ? { wordWrap: true, wordWrapWidth: sec.width } : {}),
                    ...(sec.style || {}),
                };
                const textNode = new PIXI.Text("", style);
                textNode.position.set(sec.position.x, sec.position.y);
                this.container.addChild(textNode);
                this.sectionTexts.set(sectionId, textNode);
            } else if (sec.type === "columns") {
                const colContainer = new PIXI.Container();
                colContainer.position.set(sec.position.x, sec.position.y);
                this.container.addChild(colContainer);
                this.sectionContainers.set(sectionId, colContainer);
            } else if (sec.type === "custom") {
                const customContainer = new PIXI.Container();
                this.container.addChild(customContainer);
                this.sectionContainers.set(sectionId, customContainer);
            }
        }

        // Setup buttons
        const buttonInstances: Record<string, Button> = {};
        for (const btnConfig of config.buttons || []) {
            const btn = new Button(
                gameData,
                btnConfig.label,
                btnConfig.width || 60,
                btnConfig.position,
            );
            this.buttonsMap.set(btnConfig.id, btn);
            buttonInstances[btnConfig.id] = btn;

            btn.click.subscribe(async () => {
                if (btnConfig.action) {
                    const result = await btnConfig.action(this, this.input);
                    if (result !== undefined) {
                        this.customOutput = result;
                    }
                }
                this.closeWithResult();
            });
        }
        this.addButtons(buttonInstances);

        // Controls binding
        const controlsMap: Record<string, () => void> = {};

        const defaultBtn = (config.buttons || []).find((b) => b.isDefault);
        if (defaultBtn) {
            controlsMap.buy = async () => {
                if (defaultBtn.action) {
                    const res = await defaultBtn.action(this, this.input);
                    if (res !== undefined) this.customOutput = res;
                }
                this.closeWithResult();
            };
        }

        const cancelBtn = (config.buttons || []).find((b) => b.isCancel);
        if (cancelBtn) {
            controlsMap.depart = async () => {
                if (cancelBtn.action) {
                    const res = await cancelBtn.action(this, this.input);
                    if (res !== undefined) this.customOutput = res;
                }
                this.closeWithResult();
            };
        } else {
            controlsMap.depart = () => this.closeWithResult();
        }

        if (config.customControls) {
            for (const [key, handler] of Object.entries(config.customControls)) {
                controlsMap[key] = () => handler(this, this.input);
            }
        }

        this.controls.controls = controlsMap;
    }

    private closeWithResult() {
        if (this.customOutput !== undefined) {
            this.input = this.customOutput;
        }
        this.done();
    }

    override async show(input: TData): Promise<TData> {
        await this.buildPromise;
        this.setInput(input);
        this.customOutput = undefined;

        // Render title
        if (typeof this.config.title === "function") {
            this.titleText.text = this.config.title(input);
        } else if (this.config.title) {
            this.titleText.text = this.config.title;
        }

        // Render subtitle
        if (typeof this.config.subtitle === "function") {
            this.subtitleText.text = this.config.subtitle(input);
        } else if (this.config.subtitle) {
            this.subtitleText.text = this.config.subtitle;
        }

        // Render sections
        for (let i = 0; i < (this.config.sections || []).length; i++) {
            const sec = this.config.sections![i];
            const sectionId = sec.id || `section_${i}`;

            if (sec.type === "text") {
                const textNode = this.sectionTexts.get(sectionId);
                if (textNode) {
                    textNode.text =
                        typeof sec.content === "function"
                            ? sec.content(input)
                            : sec.content;
                }
            } else if (sec.type === "columns") {
                const container = this.sectionContainers.get(sectionId);
                if (container) {
                    container.removeChildren();
                    let currentY = 0;
                    for (const item of sec.items) {
                        const valStr =
                            typeof item.value === "function"
                                ? item.value(input)
                                : item.value;
                        const labelText = new PIXI.Text(item.label, {
                            ...CLASSIC_MAC_FONT,
                            fill: item.color ?? 0xcccccc,
                        });
                        labelText.position.set(0, currentY);

                        const valueText = new PIXI.Text(valStr, {
                            ...CLASSIC_MAC_FONT,
                            fill: 0xffffff,
                            fontWeight: "bold",
                        });
                        valueText.position.set(sec.colWidth || 120, currentY);

                        container.addChild(labelText, valueText);
                        currentY += 18;
                    }
                }
            } else if (sec.type === "custom") {
                const container = this.sectionContainers.get(sectionId);
                if (container) {
                    container.removeChildren();
                    await sec.render(container, input, this.gameData);
                }
            }
        }

        if (this.config.onShow) {
            await this.config.onShow(this, input);
        }

        return super.show(input);
    }
}

/**
 * Factory helper for creating declarative Classic Mac OS dialogs.
 */
export function createClassicDialog<TData = void>(
    gameData: GameData,
    controlEvents: Observable<ControlEvent>,
    config: ClassicDialogConfig<TData>,
): ClassicDialog<TData> {
    return new ClassicDialog(gameData, controlEvents, config);
}

/**
 * Convenience helper for simple informational notices.
 */
export function createNoticeDialog(
    gameData: GameData,
    controlEvents: Observable<ControlEvent>,
    options: {
        title: string;
        message: string;
        okText?: string;
        okPosition?: ClassicDialogPosition;
    },
) {
    return createClassicDialog<void>(gameData, controlEvents, {
        title: options.title,
        sections: [
            {
                type: "text",
                position: { x: -210, y: -42 },
                width: 420,
                content: options.message,
            },
        ],
        buttons: [
            {
                id: "ok",
                label: options.okText || "OK",
                width: 50,
                position: options.okPosition || { x: 130, y: 38 },
                isDefault: true,
                isCancel: true,
            },
        ],
    });
}
