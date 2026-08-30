import { Entities, GetEntity, GetWorld, UUID } from 'nova_ecs/arg_types';
import { AsyncSystem } from 'nova_ecs/async_system';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { broadcastChat, Comms } from 'nova_ecs/plugins/multiplayer_plugin';
import { Plugin } from 'nova_ecs/plugin';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { World } from 'nova_ecs/world';
import { SingletonComponent } from 'nova_ecs/world';
import * as PIXI from 'pixi.js';
import { ControlsSubject, EcsControlEvent } from '../nova_plugin/controls_plugin';
import { ControlStateEvent } from '../nova_plugin/control_state_event';
import { PlayerShipSelector } from '../nova_plugin/player_ship_plugin';
import { PlayerStateComponent } from '../nova_plugin/player_state';
import { TargetComponent } from '../nova_plugin/target_component';
import { ScreenSize } from './screen_size_plugin';
import { Space } from './space_resource';
import { Stage } from './stage_resource';
import { attachGraphic, ManagedGraphic } from './managed_graphic';

export interface RadialOption {
    id: string;
    label: string;
    sublabel: string;
    icon: string;
    action: (world: World, playerEntity: any, playerUuid: string) => void;
}

const RADIAL_OPTIONS: RadialOption[] = [
    {
        id: 'hail',
        label: 'HAIL / CHAT',
        sublabel: 'Comms (Y)',
        icon: '📡',
        action: (world) => {
            world.emitNow(EcsControlEvent, new Map([['hail', true]]));
        },
    },
    {
        id: 'board',
        label: 'BOARD / CAPTURE',
        sublabel: 'Board (B)',
        icon: '⚓',
        action: (world) => {
            world.emitNow(ControlStateEvent, new Map([['board', 'start']]));
        },
    },
    {
        id: 'transfer',
        label: 'ENERGY TRANSFER',
        sublabel: 'Transfer (U)',
        icon: '⚡',
        action: (world) => {
            world.emitNow(ControlStateEvent, new Map([['transferEnergy', 'start']]));
        },
    },
    {
        id: 'sos',
        label: 'DISTRESS SOS',
        sublabel: 'Mayday (O)',
        icon: '🆘',
        action: (world, playerEntity) => {
            sendDistressBeacon(world, playerEntity);
        },
    },
    {
        id: 'coords',
        label: 'SHARE COORDS',
        sublabel: 'Broadcast Pos',
        icon: '📍',
        action: (world, playerEntity) => {
            shareLocation(world, playerEntity);
        },
    },
    {
        id: 'jettison',
        label: 'JETTISON CARGO',
        sublabel: 'Drop 1t (X)',
        icon: '📦',
        action: (world) => {
            world.emitNow(ControlStateEvent, new Map([['jettison', 'start']]));
        },
    },
    {
        id: 'map',
        label: 'GALAXY MAP',
        sublabel: 'Starmap (M)',
        icon: '🗺️',
        action: (world) => {
            world.emitNow(EcsControlEvent, new Map([['map', true]]));
        },
    },
    {
        id: 'directory',
        label: 'PILOT ROSTER',
        sublabel: 'Status (P)',
        icon: '👥',
        action: (world) => {
            world.emitNow(EcsControlEvent, new Map([['properties', true]]));
        },
    },
];

export function computeRadialSelection(
    dx: number,
    dy: number,
    numOptions: number,
    innerRadius = 45,
    outerRadius = 145,
): number {
    const dist = Math.hypot(dx, dy);
    if (dist < innerRadius || dist > outerRadius + 40) {
        return -1;
    }
    const arc = (Math.PI * 2) / numOptions;
    let angle = Math.atan2(dy, dx) + Math.PI / 2;
    if (angle < 0) angle += Math.PI * 2;
    return Math.floor(angle / arc) % numOptions;
}

export function cycleRadialIndex(
    currentIndex: number,
    delta: number,
    numOptions: number,
): number {
    if (currentIndex < 0) {
        return delta > 0 ? 0 : numOptions - 1;
    }
    return (currentIndex + delta + numOptions) % numOptions;
}

export function gamepadRadialSelection(
    axisX: number,
    axisY: number,
    numOptions: number,
    threshold = 0.4,
): number | undefined {
    const dist = Math.hypot(axisX, axisY);
    if (dist <= threshold) {
        return undefined;
    }
    const arc = (Math.PI * 2) / numOptions;
    let angle = Math.atan2(axisY, axisX) + Math.PI / 2;
    if (angle < 0) angle += Math.PI * 2;
    return Math.floor(angle / arc) % numOptions;
}

export function sendDistressBeacon(world: World, playerEntity?: any) {
    const mov = playerEntity?.components.get(MovementStateComponent);
    const state = playerEntity?.components.get(PlayerStateComponent);
    const name = state?.pilotName || 'Captain';
    const system = state?.currentSystem || 'nova:130';
    const x = Math.round(mov?.position.x ?? 0);
    const y = Math.round(mov?.position.y ?? 0);
    const text = `MAYDAY! Disabled at (${x}, ${y}) in ${system}! Requesting immediate assistance!`;

    broadcastChat(world, {
        to: 'all',
        fromName: name,
        text,
        kind: 'sos',
        system,
        coords: [x, y],
    });
}

export function shareLocation(world: World, playerEntity?: any) {
    const mov = playerEntity?.components.get(MovementStateComponent);
    const state = playerEntity?.components.get(PlayerStateComponent);
    const name = state?.pilotName || 'Captain';
    const system = state?.currentSystem || 'nova:130';
    const x = Math.round(mov?.position.x ?? 0);
    const y = Math.round(mov?.position.y ?? 0);
    const text = `Current position in ${system}: (${x}, ${y})`;

    broadcastChat(world, {
        to: 'all',
        fromName: name,
        text,
        kind: 'coords',
        system,
        coords: [x, y],
    });
}

export class RadialMenu {
    readonly container = new PIXI.Container();
    private readonly bg = new PIXI.Graphics();
    private readonly wheel = new PIXI.Graphics();
    private readonly centerCircle = new PIXI.Graphics();
    private readonly centerTitle = new PIXI.Text('', {
        fontFamily: 'Geneva, Arial, sans-serif',
        fontSize: 13,
        fontWeight: 'bold',
        fill: 0xffd588,
        align: 'center',
    });
    private readonly centerSub = new PIXI.Text('', {
        fontFamily: 'Geneva, Arial, sans-serif',
        fontSize: 10,
        fill: 0xbbbbbb,
        align: 'center',
    });
    private readonly optionLabels: PIXI.Text[] = [];

    private selectedIndex = -1;
    private mousePos = { x: 0, y: 0 };
    private center = { x: 400, y: 300 };

    readonly innerRadius = 45;
    readonly outerRadius = 145;

    constructor() {
        this.container.name = 'RadialMenuContainer';
        this.container.zIndex = 999;
        this.container.visible = false;

        this.container.addChild(this.bg);
        this.container.addChild(this.wheel);
        this.container.addChild(this.centerCircle);

        this.centerTitle.anchor.set(0.5, 0.7);
        this.centerSub.anchor.set(0.5, -0.4);
        this.container.addChild(this.centerTitle);
        this.container.addChild(this.centerSub);

        for (let i = 0; i < RADIAL_OPTIONS.length; i++) {
            const opt = RADIAL_OPTIONS[i];
            const text = new PIXI.Text(`[${i + 1}] ${opt.icon} ${opt.label.split(' ')[0]}`, {
                fontFamily: 'Geneva, Arial, sans-serif',
                fontSize: 11,
                fill: 0xffffff,
                align: 'center',
            });
            text.anchor.set(0.5, 0.5);
            this.container.addChild(text);
            this.optionLabels.push(text);
        }

        window.addEventListener('mousemove', (e) => {
            if (!this.container.visible) return;
            this.mousePos.x = e.clientX;
            this.mousePos.y = e.clientY;
            this.updateSelection();
        });

        window.addEventListener('mousedown', (e) => {
            if (!this.container.visible || e.button !== 0) return;
            this.executeCurrent();
        });

        window.addEventListener('keydown', (e) => {
            if (!this.container.visible) return;

            const num = parseInt(e.key, 10);
            if (!isNaN(num) && num >= 1 && num <= RADIAL_OPTIONS.length) {
                e.preventDefault();
                e.stopPropagation();
                this.executeIndex(num - 1);
                return;
            }

            if (e.code === 'ArrowDown' || e.code === 'ArrowRight' || e.code === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                this.cycleSelection(1);
                return;
            }

            if (e.code === 'ArrowUp' || e.code === 'ArrowLeft') {
                e.preventDefault();
                e.stopPropagation();
                this.cycleSelection(-1);
                return;
            }

            if (e.code === 'Enter' || e.code === 'Space') {
                e.preventDefault();
                e.stopPropagation();
                if (this.selectedIndex >= 0) {
                    this.executeCurrent();
                }
                return;
            }

            if (e.code === 'Escape' || e.code === 'KeyQ') {
                e.preventDefault();
                e.stopPropagation();
                this.hide();
                return;
            }
        });
    }

    selectIndex(index: number) {
        if (index < 0 || index >= RADIAL_OPTIONS.length) {
            this.selectedIndex = -1;
        } else {
            this.selectedIndex = index;
        }
        this.drawWheel();
    }

    cycleSelection(delta: number) {
        this.selectedIndex = cycleRadialIndex(this.selectedIndex, delta, RADIAL_OPTIONS.length);
        this.drawWheel();
    }

    executeIndex(index: number) {
        this.selectIndex(index);
        this.executeCurrent();
    }

    show(centerX: number, centerY: number) {
        this.center = { x: centerX, y: centerY };
        this.container.position.set(0, 0);
        this.container.visible = true;
        this.updateSelection();
    }

    hide() {
        this.container.visible = false;
        this.selectedIndex = -1;
    }

    private updateSelection() {
        const dx = this.mousePos.x - this.center.x;
        const dy = this.mousePos.y - this.center.y;
        this.selectedIndex = computeRadialSelection(
            dx,
            dy,
            RADIAL_OPTIONS.length,
            this.innerRadius,
            this.outerRadius,
        );
        this.drawWheel();
    }

    private drawWheel() {
        const numOptions = RADIAL_OPTIONS.length;
        const arc = (Math.PI * 2) / numOptions;

        this.bg.clear();
        this.bg.beginFill(0x000000, 0.4);
        this.bg.drawRect(0, 0, window.innerWidth, window.innerHeight);
        this.bg.endFill();

        this.wheel.clear();
        this.centerCircle.clear();

        // Draw sectors
        for (let i = 0; i < numOptions; i++) {
            const startAngle = i * arc - Math.PI / 2;
            const endAngle = (i + 1) * arc - Math.PI / 2;
            const isHovered = i === this.selectedIndex;

            this.wheel.beginFill(isHovered ? 0x6e201c : 0x181414, isHovered ? 0.95 : 0.85);
            this.wheel.lineStyle(isHovered ? 2 : 1, isHovered ? 0xffcc88 : 0x4d4943, 0.9);

            this.wheel.arc(this.center.x, this.center.y, this.outerRadius, startAngle, endAngle);
            this.wheel.arc(this.center.x, this.center.y, this.innerRadius, endAngle, startAngle, true);
            this.wheel.closePath();
            this.wheel.endFill();

            // Position label
            const midAngle = startAngle + arc / 2;
            const labelRadius = (this.innerRadius + this.outerRadius) / 2;
            const label = this.optionLabels[i];
            label.position.set(
                this.center.x + Math.cos(midAngle) * labelRadius,
                this.center.y + Math.sin(midAngle) * labelRadius,
            );
            label.style.fill = isHovered ? 0xffea00 : 0xe0d6c8;
            label.style.fontWeight = isHovered ? 'bold' : 'normal';
        }

        // Draw center
        this.centerCircle.beginFill(0x0e0c0c, 0.95);
        this.centerCircle.lineStyle(2, this.selectedIndex >= 0 ? 0xffbb55 : 0x666666, 1);
        this.centerCircle.drawCircle(this.center.x, this.center.y, this.innerRadius);
        this.centerCircle.endFill();

        this.centerTitle.position.set(this.center.x, this.center.y);
        this.centerSub.position.set(this.center.x, this.center.y);

        if (this.selectedIndex >= 0) {
            const opt = RADIAL_OPTIONS[this.selectedIndex];
            this.centerTitle.text = opt.label;
            this.centerSub.text = opt.sublabel;
        } else {
            this.centerTitle.text = 'ACTIONS';
            this.centerSub.text = 'Hover option';
        }
    }

    private executeCurrent() {
        if (this.selectedIndex >= 0 && this.onAction) {
            const opt = RADIAL_OPTIONS[this.selectedIndex];
            this.onAction(opt);
        }
        this.hide();
    }

    onAction?: (option: RadialOption) => void;
}

export const RadialMenuResource = new Resource<RadialMenu>('RadialMenuResource');

export const RadialMenuSystem = new System({
    name: 'RadialMenuSystem',
    events: [EcsControlEvent],
    args: [
        EcsControlEvent,
        RadialMenuResource,
        ScreenSize,
        GetEntity,
        UUID,
        GetWorld,
        SingletonComponent,
    ] as const,
    step(controlEvent, menu, screenSize, entity, uuid, world) {
        if (controlEvent.has('radialMenu')) {
            const isStart = controlEvent.get('radialMenu');
            if (isStart) {
                if (menu.container.visible) {
                    menu.hide();
                } else {
                    menu.show(screenSize.x / 2, screenSize.y / 2);
                    menu.onAction = (opt) => opt.action(world, entity, uuid);
                }
            }
        }
        if (controlEvent.has('sos') && controlEvent.get('sos')) {
            sendDistressBeacon(world, entity);
        }
    },
});

export const RadialGamepadSystem = new System({
    name: 'RadialGamepadSystem',
    args: [RadialMenuResource, SingletonComponent] as const,
    step(menu) {
        if (!menu.container.visible || typeof navigator === 'undefined' || !navigator.getGamepads) {
            return;
        }
        const gamepads = navigator.getGamepads();
        for (let g = 0; g < gamepads.length; g++) {
            const pad = gamepads[g];
            if (!pad) continue;
            // Left Stick direction
            const axisX = pad.axes[0] ?? 0;
            const axisY = pad.axes[1] ?? 0;
            const selection = gamepadRadialSelection(axisX, axisY, RADIAL_OPTIONS.length);
            if (selection !== undefined) {
                menu.selectIndex(selection);
            }
            // Button 0 (A / Cross) -> Execute
            if (pad.buttons[0]?.pressed) {
                menu.executeCurrent();
                break;
            }
            // Button 1 (B / Circle) -> Close
            if (pad.buttons[1]?.pressed || pad.buttons[8]?.pressed || pad.buttons[9]?.pressed) {
                menu.hide();
                break;
            }
        }
    },
});

export const RadialMenuPlugin: Plugin = {
    name: 'RadialMenuPlugin',
    build(world) {
        const stage = world.resources.get(Stage);
        if (!stage) {
            throw new Error('Expected Stage resource in world');
        }
        const menu = new RadialMenu();
        stage.addChild(menu.container);
        world.resources.set(RadialMenuResource, menu);
        world.addSystem(RadialMenuSystem);
        world.addSystem(RadialGamepadSystem);
    },
    remove(world) {
        world.removeSystem(RadialMenuSystem);
        world.removeSystem(RadialGamepadSystem);
        const menu = world.resources.get(RadialMenuResource);
        if (menu) {
            menu.container.destroy({ children: true });
        }
        world.resources.delete(RadialMenuResource);
    },
};
