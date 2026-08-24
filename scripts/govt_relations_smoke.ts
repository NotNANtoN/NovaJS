import { NovaParse } from "novaparse/NovaParse";
import {
    GovernmentData,
    relation,
} from "../nova/src/nova_plugin/govt_relations";

const dataPath = process.argv[2] ?? "/tmp/Nova Files ndat";
const firstGovernment = 128;
const lastGovernment = 140;

async function main() {
    const gameData = new NovaParse(
        dataPath,
        false,
        { novaFiles: ".", novaPlugins: "." },
    );
    const governments = new Map<number, GovernmentData>();

    for (let id = firstGovernment; id <= lastGovernment; id++) {
        const govt = await gameData.data.Govt!.get(`nova:${id}`);
        governments.set(id, govt);
    }

    console.log("government relation matrix (128-140):");
    console.log(["id", ...governments.keys()].join("\t"));
    for (const [id, govt] of governments) {
        const row = [...governments].map(([, other]) => relation(govt, other)[0]);
        console.log([id, ...row].join("\t"));
    }

    const federation = governments.get(128);
    const pirates = [...governments.entries()]
        .find(([, govt]) => /pirate/i.test(govt.name));
    const knownAlly = [...governments.entries()]
        .flatMap(([aId, a]) => [...governments.entries()]
            .filter(([bId]) => bId > aId)
            .map(([bId, b]) => [aId, bId, relation(a, b)] as const))
        .find(([, , value]) => value === "ally");
    const knownEnemy = [...governments.entries()]
        .flatMap(([aId, a]) => [...governments.entries()]
            .filter(([bId]) => bId > aId)
            .map(([bId, b]) => [aId, bId, relation(a, b)] as const))
        .find(([, , value]) => value === "enemy");

    console.log("federation:", federation?.name);
    console.log(
        "federation classes/enemies:",
        federation?.classes,
        federation?.enemies,
    );
    console.log("pirate sample:", pirates?.[0], pirates?.[1].name);
    console.log("pirate classes:", pirates?.[1].classes);
    if (federation && pirates) {
        console.log(
            "Federation vs Pirate:",
            relation(federation, pirates[1]),
        );
    }
    console.log("known ally pair:", knownAlly?.slice(0, 2));
    console.log("known enemy pair:", knownEnemy?.slice(0, 2));

    if (!federation || !pirates
        || relation(federation, pirates[1]) !== "enemy"
        || !knownAlly || !knownEnemy) {
        throw new Error("Retail government relation smoke assertions failed");
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
