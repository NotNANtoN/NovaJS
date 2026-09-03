/**
 * Lightweight IndexedDB cache with ETag validation for fast client startup.
 * Automatically falls back to network if IndexedDB is disabled or in Node.js.
 */

const DB_NAME = 'NovaGameDataCache';
const DB_VERSION = 1;
const STORE_NAME = 'payloads';

interface CachedPayload<T> {
    url: string;
    etag: string;
    data: T;
    timestamp: number;
}

function openDB(): Promise<IDBDatabase | undefined> {
    if (typeof indexedDB === 'undefined') {
        return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
        try {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'url' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(undefined);
        } catch {
            resolve(undefined);
        }
    });
}

export async function getCachedPayload<T>(url: string): Promise<{ data: T; etag: string } | undefined> {
    const db = await openDB();
    if (!db) return undefined;

    return new Promise((resolve) => {
        try {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.get(url);
            request.onsuccess = () => {
                const record = request.result as CachedPayload<T> | undefined;
                if (record && record.data && record.etag) {
                    resolve({ data: record.data, etag: record.etag });
                } else {
                    resolve(undefined);
                }
            };
            request.onerror = () => resolve(undefined);
        } catch {
            resolve(undefined);
        }
    });
}

export async function setCachedPayload<T>(url: string, etag: string, data: T): Promise<void> {
    const db = await openDB();
    if (!db) return;

    return new Promise((resolve) => {
        try {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const payload: CachedPayload<T> = {
                url,
                etag,
                data,
                timestamp: Date.now(),
            };
            store.put(payload);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        } catch {
            resolve();
        }
    });
}
