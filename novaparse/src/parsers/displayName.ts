export function displayName(rawName: string): string {
    const trimmedName = rawName.trim();
    const semicolon = trimmedName.indexOf(';');
    const parsedName = semicolon === -1
        ? trimmedName
        : trimmedName.slice(0, semicolon).trim();
    return parsedName || trimmedName;
}
