import 'jasmine';
import { Entity } from 'nova_ecs/entity';
import { TimeResource } from 'nova_ecs/plugins/time_plugin';
import { World } from 'nova_ecs/world';
import { Stage } from './stage_resource';
import { ScreenSize } from './screen_size_plugin';
import {
    ChatFeedPlugin,
    ChatHistoryResource,
} from './chat_feed_plugin';
import { ChatMessageEvent } from 'nova_ecs/plugins/multiplayer_plugin';
import * as PIXI from 'pixi.js';

describe('Chat feed plugin', () => {
    let world: World;
    let stage: PIXI.Container;

    beforeEach(async () => {
        world = new World('chat-feed-test');
        stage = new PIXI.Container();
        world.resources.set(Stage, stage);
        world.resources.set(ScreenSize, { x: 800, y: 600 });
        world.resources.set(TimeResource, {
            time: 1000,
            delta_ms: 1000 / 60,
            delta_s: 1 / 60,
            frame: 1,
        });
        await world.addPlugin(ChatFeedPlugin);
    });

    it('receives chat messages and records them in history', () => {
        world.emitNow(ChatMessageEvent, {
            id: '1',
            from: 'peer-1',
            fromName: 'Anton',
            to: 'all',
            text: 'Hello from Sol system!',
            time: 1000,
        });

        const history = world.resources.get(ChatHistoryResource);
        expect(history?.get('peer-1')?.length).toBe(1);
        expect(history?.get('peer-1')?.[0].text).toBe('Hello from Sol system!');
    });

    it('receives SOS beacons and navigation coordinate broadcasts', () => {
        world.emitNow(ChatMessageEvent, {
            id: '2',
            from: 'peer-2',
            fromName: 'Pilot',
            to: 'all',
            text: 'Disabled near Sol!',
            time: 1000,
            kind: 'sos',
            system: 'nova:130',
            coords: [100, 200],
        });

        world.emitNow(ChatMessageEvent, {
            id: '3',
            from: 'peer-3',
            fromName: 'Scout',
            to: 'all',
            text: 'Position in nova:130: (500, -300)',
            time: 1000,
            kind: 'coords',
            system: 'nova:130',
            coords: [500, -300],
        });

        const history = world.resources.get(ChatHistoryResource);
        expect(history?.get('peer-2')?.length).toBe(1);
        expect(history?.get('peer-2')?.[0].kind).toBe('sos');
        expect(history?.get('peer-3')?.length).toBe(1);
        expect(history?.get('peer-3')?.[0].kind).toBe('coords');
    });
});
