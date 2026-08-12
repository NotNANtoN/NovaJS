import { Express, Request, Response } from "express";
import { VERSION_PATH } from "../common/version_handshake.js";

/**
 * Serves the server's build stamp at `/version` as plain text.
 *
 * This is the client's PREFLIGHT: the browser bundle fetches it on load
 * and force-reloads itself when the stamp does not match the one compiled
 * into it. It is deliberately NOT the enforcement point -- the websocket
 * admission check in `SocketChannelServer` is (a client that ignores this
 * route, or whose bundle predates it, is still refused a room). This route
 * exists to make the common case fast and legible, and to give ops a way
 * to ask a running server what it was built from.
 *
 * MUST be registered before `setupRoutes`, whose `use("/")` catch-all
 * serves index.html for anything unclaimed -- same ordering constraint the
 * title-music route documents in `server.ts`.
 *
 * `no-store`, not `no-cache`: the whole point of the response is to be
 * current, and a revalidated 304 from an intermediary that has the OLD
 * stamp would defeat the check it feeds.
 */
export function registerVersionRoute(app: Express, buildVersion: string) {
    app.get(VERSION_PATH, (_req: Request, res: Response) => {
        res.set('Cache-Control', 'no-store');
        res.type('text/plain').send(buildVersion);
    });
}
