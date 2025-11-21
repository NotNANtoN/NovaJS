import * as Comlink from "comlink";
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const nodeEndpoint = require("comlink/dist/esm/node-adapter.js");
import { NovaParse } from "novaparse";
import { parentPort } from "worker_threads";

let novaParse: NovaParse | undefined;
const api = {
    init(path: string) {
        this.novaParse = Comlink.proxy(new NovaParse(path, false));
    },
    novaParse,
}

export type NovaParseWorkerApi = typeof api;

if (!parentPort) {
    throw new Error('Missing parent port');
}

Comlink.expose(api, nodeEndpoint(parentPort));
