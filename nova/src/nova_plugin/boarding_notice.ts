import { Component } from 'nova_ecs/component';

/**
 * HUD feedback text. Local to the pilot's own client: it is
 * feedback, not game state, and never crosses the network.
 */
export const BoardingNoticeComponent =
    new Component<{ text: string }>('BoardingNoticeComponent');
