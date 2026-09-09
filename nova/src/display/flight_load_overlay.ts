import { PANEL_STYLE } from '../client/start_menu_dialogs';

const OVERLAY_STYLE = `
    position: fixed; inset: 0; z-index: 1001; overflow: hidden;
    display: flex; align-items: center; justify-content: center;
    color: #f4f0e4; font-family: Charcoal, Geneva, Arial, sans-serif;
    background: #000;
`;

const STATUS_STYLE = `
    ${PANEL_STYLE}
    min-width: 320px; max-width: min(520px, 90vw); padding: 22px 28px 22px;
    text-align: center; letter-spacing: .14em;
    font-size: 18px; text-transform: uppercase;
`;

const WAIT_DOT_STYLE = `
    display: inline-block; width: 0.7em;
    animation: novaEnterWait 1s steps(1, end) infinite;
`;

const PROGRESS_CONTAINER_STYLE = `
    display: flex; flex-direction: column; width: 100%; margin-top: 18px;
`;

const PROGRESS_BAR_TRACK_STYLE = `
    box-sizing: border-box; width: 100%; height: 16px;
    background: #0b0707; border: 1px solid #77766f; border-radius: 2px;
    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.9), 0 1px 0 rgba(255, 255, 255, 0.15);
    overflow: hidden; position: relative;
`;

const PROGRESS_BAR_FILL_STYLE = `
    height: 100%; width: 0%;
    transition: width 0.1s ease-out;
    background: linear-gradient(to bottom, #8eeaff 0%, #00a8d6 50%, #004c73 100%);
    box-shadow: 0 0 10px rgba(0, 200, 255, 0.5);
`;

const PROGRESS_LABELS_STYLE = `
    display: flex; justify-content: space-between; align-items: center;
    margin-top: 7px; font-size: 12px; font-family: Geneva, Arial, sans-serif;
    color: #a49f96; letter-spacing: 0.05em; text-transform: none;
`;

let overlay: HTMLDivElement | undefined;
let statusNode: HTMLSpanElement | undefined;
let progressContainer: HTMLDivElement | undefined;
let progressBarInner: HTMLDivElement | undefined;
let detailNode: HTMLSpanElement | undefined;
let percentNode: HTMLSpanElement | undefined;

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

export function showEnteringOverlay(status = 'Entering system', percentage?: number, detail?: string): void {
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

        const headerRow = document.createElement('div');
        headerRow.style.cssText = 'display: flex; align-items: center; justify-content: center;';

        statusNode = document.createElement('span');
        const dot = document.createElement('span');
        dot.textContent = ' ▮';
        dot.setAttribute('style', WAIT_DOT_STYLE);
        headerRow.append(statusNode, dot);

        progressContainer = document.createElement('div');
        progressContainer.setAttribute('style', PROGRESS_CONTAINER_STYLE);

        const track = document.createElement('div');
        track.setAttribute('style', PROGRESS_BAR_TRACK_STYLE);

        progressBarInner = document.createElement('div');
        progressBarInner.dataset.novaProgressBar = 'fill';
        progressBarInner.setAttribute('style', PROGRESS_BAR_FILL_STYLE);
        track.append(progressBarInner);

        const labelsRow = document.createElement('div');
        labelsRow.setAttribute('style', PROGRESS_LABELS_STYLE);

        detailNode = document.createElement('span');
        detailNode.textContent = 'Initializing...';

        percentNode = document.createElement('span');
        percentNode.style.cssText = 'font-weight: bold; color: #f4f0e4; margin-left: 12px;';
        percentNode.textContent = '0%';

        labelsRow.append(detailNode, percentNode);
        progressContainer.append(track, labelsRow);

        panel.append(headerRow, progressContainer);
        overlay.append(panel);
        document.body.append(overlay);
    }
    if (statusNode) {
        statusNode.textContent = status;
    }
    if (percentage !== undefined) {
        setEnteringProgress(percentage, detail);
    }
}

export function setEnteringProgress(percentage: number, detail?: string): void {
    if (typeof document === 'undefined') {
        return;
    }
    if (!overlay) {
        showEnteringOverlay();
    }
    const clamped = Math.max(0, Math.min(100, Math.round(percentage)));
    if (progressContainer) {
        progressContainer.style.display = 'flex';
    }
    if (progressBarInner) {
        progressBarInner.style.width = `${clamped}%`;
    }
    if (percentNode) {
        percentNode.textContent = `${clamped}%`;
    }
    if (detailNode && detail !== undefined) {
        detailNode.textContent = detail;
    }
}

export async function showFlightLoadError(error: unknown): Promise<void> {
    if (typeof document === 'undefined') return;
    showEnteringOverlay(error instanceof Error ? error.message : 'Could not enter the system. Please retry.');
    if (progressContainer) {
        progressContainer.style.display = 'none';
    }
    const panel = statusNode?.parentElement?.parentElement ?? statusNode?.parentElement;
    if (!panel) return;
    panel.style.maxWidth = 'min(600px, 80vw)';
    panel.style.overflowWrap = 'anywhere';
    const button = document.createElement('button');
    button.textContent = 'Return to menu';
    button.style.cssText = 'display:block; margin:20px auto 0; padding:8px 16px; cursor:pointer';
    panel.append(button);
    await new Promise<void>(resolve => button.addEventListener('click', () => resolve(), { once: true }));
    hideEnteringOverlay();
}

export function hideEnteringOverlay(): void {
    if (typeof document === 'undefined') {
        overlay = undefined;
        statusNode = undefined;
        progressContainer = undefined;
        progressBarInner = undefined;
        detailNode = undefined;
        percentNode = undefined;
        return;
    }
    overlay?.remove();
    overlay = undefined;
    statusNode = undefined;
    progressContainer = undefined;
    progressBarInner = undefined;
    detailNode = undefined;
    percentNode = undefined;
}
