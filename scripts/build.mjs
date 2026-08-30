import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { build } from "esbuild";
import { packedPngPlugin } from "./packed_png_plugin.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distPath = path.join(projectRoot, "dist");

await mkdir(distPath, { recursive: true });

let commitHash = "dev";
let commitMessage = "local development";
let commitDate = new Date().toISOString().slice(0, 10);

try {
    commitHash = execSync("git rev-parse --short HEAD", { cwd: projectRoot, encoding: "utf8" }).trim();
    commitMessage = execSync('git log -1 --format="%s"', { cwd: projectRoot, encoding: "utf8" }).trim();
    commitDate = execSync('git log -1 --format="%cd" --date=short', { cwd: projectRoot, encoding: "utf8" }).trim();
} catch {}


// Bun/npm may install a second copy of the @pixi/* packages nested inside
// node_modules/pixi.js/node_modules. Both copies then register handlers on
// the single shared @pixi/extensions registry, which throws "Extension type
// renderer already has a handler" at startup. Canonicalize every @pixi/*
// import to the top-level copy so exactly one instance is bundled.
const dedupePixiPlugin = {
    name: "dedupe-pixi",
    setup(buildContext) {
        buildContext.onResolve({ filter: /^@pixi\// }, args => {
            const [scope, name] = args.path.split("/");
            const rest = args.path.split("/").slice(2).join("/");
            // Prefer the version-consistent set pinned by pixi.js itself.
            const nested = path.join(
                projectRoot, "node_modules", "pixi.js", "node_modules", scope, name);
            const top = path.join(projectRoot, "node_modules", scope, name);
            const pkgRoot = existsSync(nested) ? nested : top;
            const pkg = JSON.parse(
                readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
            let subPath;
            if (rest) {
                subPath = rest;
            } else {
                const exp = pkg.exports?.["."];
                subPath = exp?.import?.default ?? exp?.import ?? pkg.module ?? pkg.main;
            }
            return { path: path.join(pkgRoot, subPath) };
        });
    },
};

const commonOptions = {
    absWorkingDir: projectRoot,
    bundle: true,
    define: {
        __BUILD_COMMIT__: JSON.stringify(commitHash),
        __BUILD_MESSAGE__: JSON.stringify(commitMessage),
        __BUILD_DATE__: JSON.stringify(commitDate),
    },
    logLevel: "info",
    plugins: [packedPngPlugin(projectRoot), dedupePixiPlugin],
    resolveExtensions: [".mjs", ".js", ".ts", ".tsx", ".jsx"],
    sourcemap: true,
    sourcesContent: true,
    target: "es2020",
    tsconfig: path.join(projectRoot, "tsconfig.json"),
};

await Promise.all([
    build({
        ...commonOptions,
        alias: {
            path: "path-browserify",
        },
        entryPoints: [path.join(projectRoot, "nova/src/browser.ts")],
        mainFields: ["browser", "module", "main"],
        minify: true,
        outfile: path.join(distPath, "browser_bundle.js"),
        platform: "browser",
    }),
    build({
        ...commonOptions,
        entryPoints: [path.join(projectRoot, "nova/src/server/parsing/nova_parse_worker.ts")],
        external: ["lamejs"],
        keepNames: true,
        outfile: path.join(distPath, "nova_parse_worker.js"),
        platform: "node",
    }),
    build({
        ...commonOptions,
        entryPoints: [path.join(projectRoot, "nova/server.ts")],
        external: ["sharp", "ws"],
        keepNames: true,
        outfile: path.join(distPath, "server.js"),
        platform: "node",
    }),
]);
