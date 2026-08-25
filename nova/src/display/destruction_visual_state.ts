export function registerDestructionVisual(
    active: Map<string, number>,
    target: string,
): void {
    active.set(target, (active.get(target) ?? 0) + 1);
}

export function completeDestructionVisual(
    active: Map<string, number>,
    target: string,
): boolean {
    const remaining = (active.get(target) ?? 1) - 1;
    if (remaining > 0) {
        active.set(target, remaining);
        return false;
    }
    active.delete(target);
    return true;
}
