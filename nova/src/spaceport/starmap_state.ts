export interface StarmapViewState {
    centeredOnce: boolean;
}

export function consumeInitialCenter(state: StarmapViewState): boolean {
    if (state.centeredOnce) {
        return false;
    }
    state.centeredOnce = true;
    return true;
}

export interface SystemMarkerStyle {
    current: boolean;
    ringColor?: number;
    ringWidth?: number;
}

export function systemMarkerStyle(
    systemId: string,
    currentSystemId: string,
): SystemMarkerStyle {
    return systemId === currentSystemId
        ? { current: true, ringColor: 0xffffff, ringWidth: 2 }
        : { current: false };
}
