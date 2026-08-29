import { Entity } from 'nova_ecs/entity';
import { World } from 'nova_ecs/world';
import { Observable } from 'rxjs';
import * as PIXI from 'pixi.js';
import { GameData } from '../client/gamedata/GameData';
import { ControlEvent } from '../nova_plugin/controls_plugin';
import { PlayerStateComponent } from '../nova_plugin/player_state';
import {
    broadcastChat,
    ChatMessageEntry,
} from 'nova_ecs/plugins/multiplayer_plugin';
import { Button } from './button';
import { COMMS_LAYOUT } from './comms_panel_layout';
import { Menu } from './menu';
import { MenuControls } from './menu_controls';
import { ChatHistoryResource } from '../display/chat_feed_plugin';

const CHAT_LOG_FONT = {
    fontFamily: 'Geneva, Arial, sans-serif',
    fontSize: 11,
    fill: 0xe0e0e0,
    align: 'left',
    wordWrap: true,
    wordWrapWidth: 350,
} as const;

const INPUT_FONT = {
    fontFamily: 'Geneva, Arial, sans-serif',
    fontSize: 11,
    fill: 0xffffff,
    align: 'left',
} as const;

export interface PlayerChatTarget {
    peerUuid: string;
    pilotName: string;
    shipName: string;
}

export class PlayerChatDialog extends Menu<Entity> {
    private readonly headerText: PIXI.Text;
    private readonly logText: PIXI.Text;
    private readonly inputBox = new PIXI.Graphics();
    private readonly inputText: PIXI.Text;
    private target?: PlayerChatTarget;
    private world?: World;
    private currentDraft = '';
    private cursorVisible = true;
    private cursorTimer?: ReturnType<typeof setInterval>;
    private keyListener?: (e: KeyboardEvent) => void;

    constructor(
        gameData: GameData,
        controlEvents: Observable<ControlEvent>,
    ) {
        super(gameData, COMMS_LAYOUT.background, controlEvents);

        this.headerText = new PIXI.Text('', {
            fontFamily: 'Geneva, Arial, sans-serif',
            fontSize: 11,
            fill: 0xffff88,
            align: 'left',
        });
        this.headerText.position.set(-175, -92);
        this.container.addChild(this.headerText);

        this.logText = new PIXI.Text('', CHAT_LOG_FONT);
        this.logText.position.set(-175, -72);
        this.container.addChild(this.logText);

        this.inputBox.position.set(-175, 26);
        this.inputBox.beginFill(0x0a0a0a, 0.9);
        this.inputBox.lineStyle(1, 0x555555);
        this.inputBox.drawRoundedRect(0, 0, 270, 26, 3);
        this.inputBox.endFill();
        this.container.addChild(this.inputBox);

        this.inputText = new PIXI.Text('', INPUT_FONT);
        this.inputText.position.set(-168, 32);
        this.container.addChild(this.inputText);

        const sendButton = new Button(gameData, 'Send', 55, { x: 105, y: 26 });
        const closeButton = new Button(gameData, 'Close Channel', 85, { x: 75, y: 74 });
        this.addButtons({ send: sendButton, close: closeButton });

        sendButton.click.subscribe(() => this.sendMessage());
        closeButton.click.subscribe(() => this.done());

        this.controls = new MenuControls(controlEvents, {
            hail: () => this.done(),
            depart: () => this.done(),
        });
    }

    setTarget(target: PlayerChatTarget, world: World) {
        this.target = target;
        this.world = world;
        this.updateView();
    }

    override async show(input: Entity): Promise<Entity> {
        await this.buildPromise;
        this.setInput(input);
        this.currentDraft = '';
        this.cursorVisible = true;
        this.updateView();
        this.bindKeyboard();
        try {
            return await super.show(input);
        } finally {
            this.unbindKeyboard();
        }
    }

    private updateView() {
        if (!this.target) {
            return;
        }
        const name = this.target.pilotName;
        this.headerText.text = `Channel open to ${name} (${this.target.shipName})`;

        const historyMap = this.world?.resources.get(ChatHistoryResource);
        const history: ChatMessageEntry[] = historyMap?.get(this.target.peerUuid) ?? [];

        if (history.length === 0) {
            this.logText.text = 'No recent messages. Type below to transmit.';
        } else {
            const recent = history.slice(-5);
            this.logText.text = recent.map(m => `[${m.fromName}]: ${m.text}`).join('\n');
        }

        this.updateInputDisplay();
    }

    private updateInputDisplay() {
        const cursor = this.cursorVisible ? '▮' : ' ';
        this.inputText.text = this.currentDraft.length > 0
            ? `${this.currentDraft}${cursor}`
            : `Type message here… ${cursor}`;
        this.inputText.style.fill = this.currentDraft.length > 0 ? 0xffffff : 0x888888;
    }

    private sendMessage() {
        const text = this.currentDraft.trim();
        if (!text || !this.target || !this.world) {
            return;
        }

        const myState = this.input?.components.get(PlayerStateComponent);
        const myName = myState?.pilotName || 'Captain';

        broadcastChat(this.world, {
            to: this.target.peerUuid,
            fromName: myName,
            text,
        });

        // Add to local history map as well
        const historyMap = this.world.resources.get(ChatHistoryResource);
        if (historyMap) {
            let history = historyMap.get(this.target.peerUuid);
            if (!history) {
                history = [];
                historyMap.set(this.target.peerUuid, history);
            }
            history.push({
                id: String(Date.now()),
                from: 'me',
                fromName: myName,
                to: this.target.peerUuid,
                text,
                time: Date.now(),
            });
        }

        this.currentDraft = '';
        this.updateView();
    }

    private bindKeyboard() {
        this.unbindKeyboard();
        this.cursorTimer = setInterval(() => {
            this.cursorVisible = !this.cursorVisible;
            this.updateInputDisplay();
        }, 500);

        this.keyListener = (e: KeyboardEvent) => {
            if (!this.container.visible) {
                return;
            }
            if (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter') {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                this.sendMessage();
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                this.done();
                return;
            }
            if (e.key === 'Backspace') {
                e.preventDefault();
                e.stopPropagation();
                if (this.currentDraft.length > 0) {
                    this.currentDraft = this.currentDraft.slice(0, -1);
                    this.updateInputDisplay();
                }
                return;
            }
            if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                e.stopPropagation();
                if (this.currentDraft.length < 100) {
                    this.currentDraft += e.key;
                    this.updateInputDisplay();
                }
            }
        };
        window.addEventListener('keydown', this.keyListener, true);
    }

    private unbindKeyboard() {
        if (this.cursorTimer) {
            clearInterval(this.cursorTimer);
            this.cursorTimer = undefined;
        }
        if (this.keyListener) {
            window.removeEventListener('keydown', this.keyListener, true);
            this.keyListener = undefined;
        }
    }
}
