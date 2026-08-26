import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The default PICT and RLED placeholders are PNG files that Bazel used to
 * turn into modules. Both the bundler and the test runner need them, so the
 * plugin lives here rather than being duplicated in either.
 */
export function packedPngPlugin(projectRoot) {
    return {
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
                        contents: `export default new Uint8Array(${
                            JSON.stringify([...png])})`,
                        loader: "js",
                    };
                });
        },
    };
}
