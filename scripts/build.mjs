import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distPath = path.join(projectRoot, "dist");

await mkdir(distPath, { recursive: true });

const packedPngPlugin = {
    name: "pack-bazel-pngs",
    setup(buildContext) {
        buildContext.onResolve(
            { filter: /^novadatainterface\/default_(pict|rled)$/ },
            ({ path: modulePath }) => ({
                namespace: "packed-png",
                path: path.join(projectRoot, `${modulePath}.png`),
            }));
        buildContext.onLoad(
            { filter: /\.png$/, namespace: "packed-png" },
            async ({ path: pngPath }) => {
                const png = await readFile(pngPath);
                return {
                    contents: `export default new Uint8Array(${JSON.stringify([...png])})`,
                    loader: "js",
                };
            });
    },
};

const commonOptions = {
    absWorkingDir: projectRoot,
    bundle: true,
    logLevel: "info",
    plugins: [packedPngPlugin],
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
        external: ["ws"],
        keepNames: true,
        outfile: path.join(distPath, "server.js"),
        platform: "node",
    }),
]);
