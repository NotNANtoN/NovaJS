import { Plugin } from 'nova_ecs/plugin';
import { Resource } from 'nova_ecs/resource';
import { System } from 'nova_ecs/system';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import {
    ChatMessageEntry,
    ChatMessageEvent,
    Comms,
} from 'nova_ecs/plugins/multiplayer_plugin';
import * as PIXI from 'pixi.js';
import { Stage } from './stage_resource';
import { ScreenSize } from './screen_size_plugin';

export const ChatHistoryResource =
    new Resource<Map<string, ChatMessageEntry[]>>('ChatHistoryResource');

interface ActiveHudMessage {
    entry: ChatMessageEntry;
    textSprite: PIXI.Text;
    receivedAt: number;
}

const ChatHudMessagesResource =
    new Resource<ActiveHudMessage[]>('ChatHudMessagesResource');

const CHAT_DISPLAY_DURATION_MS = 8_000;
const CHAT_FADE_DURATION_MS = 1_500;

const CHAT_FONT = {
    fontFamily: 'Geneva, Arial, sans-serif',
    fontSize: 12,
    fill: 0xffffff,
    stroke: 0x000000,
    strokeThickness: 3,
    lineJoin: 'round',
    wordWrap: true,
    wordWrapWidth: 380,
} as const;

export const ChatReceiveSystem = new System({
    name: 'ChatReceiveSystem',
    events: [ChatMessageEvent],
    args: [
        ChatMessageEvent,
        ChatHistoryResource,
        ChatHudMessagesResource,
        Stage,
        TimeResource,
    ] as const,
    step(entry, historyMap, hudMessages, stage, time) {
        // Record in history
        const key = entry.from;
        let history = historyMap.get(key);
        if (!history) {
            history = [];
            historyMap.set(key, history);
        }
        history.push(entry);

        // Add to HUD feed
        let container = stage.getChildByName('ChatHudContainer') as PIXI.Container | null;
        if (!container) {
            container = new PIXI.Container();
            container.name = 'ChatHudContainer';
            container.zIndex = 100;
            stage.addChild(container);
        }

        if (typeof document !== 'undefined') {
            const sender = entry.fromName?.trim() || 'Captain';
            const formatted = `[${sender}]: ${entry.text}`;
            const textSprite = new PIXI.Text(formatted, CHAT_FONT);
            container.addChild(textSprite);

            hudMessages.push({
                entry,
                textSprite,
                receivedAt: time.time,
            });
        }
    },
});

export const ChatHudUpdateSystem = new System({
    name: 'ChatHudUpdateSystem',
    args: [
        ChatHudMessagesResource,
        Stage,
        TimeResource,
        ScreenSize,
    ] as const,
    step(hudMessages, stage, time, screenSize) {
        const container = stage.getChildByName('ChatHudContainer') as PIXI.Container | null;
        if (!container) {
            return;
        }

        const now = time.time;
        // Remove expired messages
        for (let i = hudMessages.length - 1; i >= 0; i--) {
            const item = hudMessages[i];
            const age = now - item.receivedAt;
            if (age >= CHAT_DISPLAY_DURATION_MS) {
                container.removeChild(item.textSprite);
                item.textSprite.destroy();
                hudMessages.splice(i, 1);
            } else if (age >= CHAT_DISPLAY_DURATION_MS - CHAT_FADE_DURATION_MS) {
                const remaining = CHAT_DISPLAY_DURATION_MS - age;
                item.textSprite.alpha = Math.max(0, remaining / CHAT_FADE_DURATION_MS);
            } else {
                item.textSprite.alpha = 1;
            }
        }

        // Layout messages from bottom-left stacking upward
        const startX = 20;
        let currentY = screenSize.y - 35;
        for (let i = hudMessages.length - 1; i >= 0; i--) {
            const item = hudMessages[i];
            item.textSprite.position.set(startX, currentY - item.textSprite.height);
            currentY -= item.textSprite.height + 4;
        }
    },
});

export const ChatFeedPlugin: Plugin = {
    name: 'ChatFeedPlugin',
    build(world) {
        if (!world.resources.has(ChatHistoryResource)) {
            world.resources.set(ChatHistoryResource, new Map());
        }
        if (!world.resources.has(ChatHudMessagesResource)) {
            world.resources.set(ChatHudMessagesResource, []);
        }
        world.addSystem(ChatReceiveSystem);
        world.addSystem(ChatHudUpdateSystem);
    },
    remove(world) {
        world.removeSystem(ChatReceiveSystem);
        world.removeSystem(ChatHudUpdateSystem);
        const stage = world.resources.get(Stage);
        const container = stage?.getChildByName('ChatHudContainer');
        if (container) {
            container.destroy({ children: true });
        }
    },
};
