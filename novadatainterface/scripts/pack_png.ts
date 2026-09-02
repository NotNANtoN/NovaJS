import * as fs from "fs";

function packPng(png: string, dest: string) {
    const buf = fs.readFileSync(png);
    const array = Uint8Array.from(buf);
    fs.writeFileSync(dest, `export default new Uint8Array(${JSON.stringify([...array])})`);
}

const [,, pngFile, destination] = process.argv;
if (!pngFile || !destination) {
    console.error("Usage: pack_png <png_file> <destination>");
    process.exit(1);
}
packPng(pngFile, destination);
