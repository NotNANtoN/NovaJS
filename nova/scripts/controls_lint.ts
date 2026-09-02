import { isLeft } from 'nova_ecs/either';
import * as fs from "fs";
import { Controls, SavedControls } from "../src/nova_plugin/controls";

const targetFile = process.argv[2];
if (!targetFile) {
    console.error("Usage: controls_lint <file>");
    process.exit(1);
}

const file = fs.readFileSync(targetFile, "utf8");
const json = JSON.parse(file) as unknown;
const maybeSavedControls = SavedControls.decode(json);
if (isLeft(maybeSavedControls)) {
    for (const error of maybeSavedControls.left) {
        console.error(error);
    }
    throw new Error("Failed to decode");
}

const maybeControls = Controls.decode(maybeSavedControls.right);
if (isLeft(maybeControls)) {
    for (const error of maybeControls.left) {
        console.error(error);
    }
    throw new Error("Failed to decode");
}

const encoded = Controls.encode(maybeControls.right);
const saved = SavedControls.encode(encoded);
console.log(JSON.stringify(saved, null, 2));
