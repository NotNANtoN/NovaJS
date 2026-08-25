/** Convert a legacy numeric resource identifier to its canonical namespace. */
export function resourceId(id: string | number): string {
    return typeof id === 'number' ? `nova:${id}` : id;
}

export function sameResourceId(
    a: string | undefined,
    b: string | undefined,
): boolean {
    if (!a || !b) {
        return false;
    }
    return a === b
        || a.replace(/^.*:/, '') === b.replace(/^.*:/, '');
}

export const novaResourceId = (id: number): string => resourceId(id);
