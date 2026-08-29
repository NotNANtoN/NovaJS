import { PANEL_STYLE } from '../client/start_menu_dialogs';

const OVERLAY_STYLE = `
    position: fixed; inset: 0; z-index: 1001; overflow: hidden;
    display: flex; align-items: center; justify-content: center;
    color: #f4f0e4; font-family: Charcoal, Geneva, Arial, sans-serif;
    background: #000;
`;

const STATUS_STYLE = `
    ${PANEL_STYLE}
    min-width: 280px; padding: 22px 28px 20px;
    text-align: center; letter-spacing: .14em;
    font-size: 18px; text-transform: uppercase;
`;

const WAIT_DOT_STYLE = `
    display: inline-block; width: 0.7em;
    animation: novaEnterWait 1s steps(1, end) infinite;
`;

let overlay: HTMLDivElement | undefined;
let statusNode: HTMLSpanElement | undefined;

function ensureKeyframes(): void {
    if (document.getElementById('nova-enter-wait-style')) {
        return;
    }
    const style = document.createElement('style');
    style.id = 'nova-enter-wait-style';
    style.textContent = `
        @keyframes novaEnterWait {
            0%, 49% { opacity: 1; }
            50%, 100% { opacity: 0; }
        }
    `;
    document.head.appendChild(style);
}

export function showEnteringOverlay(status = 'Entering system'): void {
    if (typeof document === 'undefined') {
        return;
    }
    ensureKeyframes();
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.dataset.novaOverlay = 'entering';
        overlay.setAttribute('style', OVERLAY_STYLE);
        const panel = document.createElement('div');
        panel.setAttribute('style', STATUS_STYLE);
        statusNode = document.createElement('span');
        const dot = document.createElement('span');
        dot.textContent = ' ▮';
        dot.setAttribute('style', WAIT_DOT_STYLE);
        panel.append(statusNode, dot);
        overlay.append(panel);
        document.body.append(overlay);
    }
    if (statusNode) {
        statusNode.textContent = status;
    }
}

export function hideEnteringOverlay(): void {
    if (typeof document === 'undefined') {
        overlay = undefined;
        statusNode = undefined;
        return;
    }
    overlay?.remove();
    overlay = undefined;
    statusNode = undefined;
}
