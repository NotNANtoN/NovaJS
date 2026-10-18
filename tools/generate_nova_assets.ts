/**
 * Generates EV Nova-styled Outfit PICT artwork and Outfit JSON definitions for
 * Galactic Conquest Mode using Google's Nano Banana 2.1 (`gemini-nano-banana-2.1`
 * / `gemini-3.1-flash-image`), passing 6 related original EV Nova PICT artworks
 * per item as multimodal style references.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';
import { readResourceFork } from 'resource_fork';
import sharp from 'sharp';
import { PICTParse } from '../novaparse/src/resource_parsers/PICTParse';

interface ConquestAssetSpec {
    id: string;
    name: string;
    referencePictIds: readonly number[];
    tint: [number, number, number];
    accent: [number, number, number];
    prompt: string;
    price: number;
    max: number;
    freeMass: number;
    cargoScoop?: boolean;
    repairSystem?: boolean;
    physics: {
        freeMass: number;
        speed?: number;
        acceleration?: number;
        turnRate?: number;
        shield?: number;
        shieldRecharge?: number;
        armor?: number;
        armorRecharge?: number;
    };
    desc: string;
}

const CONQUEST_ASSETS: readonly ConquestAssetSpec[] = [
    {
        id: 'conquest:hyperthrusters',
        name: 'Overdrive Thruster Pack',
        referencePictIds: [6069, 6074, 6049, 6050, 6004, 6067],
        tint: [1.35, 0.95, 0.65],
        accent: [255, 140, 40],
        prompt: 'Study these 6 original Escape Velocity Nova (2002) pre-rendered 3D outfit icons. Generate a brand-new 1:1 square icon in this EXACT early-2000s LightWave 3D pre-rendered style on a pure solid black (#000000) background: an Overdrive Thruster Pack featuring twin dark-metallic cylindrical rocket nozzles firing bright golden-orange plasma exhaust plumes with subtle blue shock diamonds. No text, no borders, no UI.',
        price: 35_000,
        max: 5,
        freeMass: 4,
        physics: {
            freeMass: 4,
            speed: 95,
            acceleration: 140,
            turnRate: 18,
        },
        desc: 'Designed for the Sol-Aurora border conflict, the Overdrive Thruster Pack couples twin plasma injectors directly to your sublight drive. Each unit dramatically boosts top speed, thrust acceleration, and combat turn rate. Up to five packs can be stacked.',
    },
    {
        id: 'conquest:mining_tractor',
        name: 'Magnetic Ore Attractor',
        referencePictIds: [6143, 6142, 6065, 6067, 6075, 6069],
        tint: [0.65, 1.3, 1.45],
        accent: [40, 220, 255],
        prompt: 'Study these 6 original Escape Velocity Nova (2002) pre-rendered 3D outfit icons. Generate a brand-new 1:1 square icon in this EXACT early-2000s LightWave 3D pre-rendered style on a pure solid black (#000000) background: a Magnetic Ore Attractor cargo scoop array with brushed steel intake jaws and glowing cyan-blue gravimetric tractor rings pulling in glowing mineral ore chunks. No text, no borders, no UI.',
        price: 25_000,
        max: 1,
        freeMass: 3,
        cargoScoop: true,
        physics: {
            freeMass: 3,
        },
        desc: 'Projects a wide-area gravimetric tractor field that pulls scattered asteroid ore and ship salvage packages into your collector from 380 units away, while refining mineral purity for a +50% credit bonus on every scooped package.',
    },
    {
        id: 'conquest:seismic_drill',
        name: 'Seismic Mining Capacitor',
        referencePictIds: [6142, 6001, 6004, 6021, 6049, 6143],
        tint: [1.4, 1.25, 0.55],
        accent: [255, 220, 50],
        prompt: 'Study these 6 original Escape Velocity Nova (2002) pre-rendered 3D outfit icons. Generate a brand-new 1:1 square icon in this EXACT early-2000s LightWave 3D pre-rendered style on a pure solid black (#000000) background: a heavy industrial Seismic Mining Laser Capacitor with ribbed brass/titanium emitter barrels and a glowing amber-gold resonance core. No text, no borders, no UI.',
        price: 30_000,
        max: 3,
        freeMass: 3,
        physics: {
            freeMass: 3,
        },
        desc: 'Modulates your ship’s weapon frequency to match the crystalline fracture harmonics of asteroid rock. Each installed capacitor increases your weapon damage against asteroids by +150%, letting you shatter huge motherlodes in seconds.',
    },
    {
        id: 'conquest:shield_overcharger',
        name: 'Aegis Shield Matrix',
        referencePictIds: [6065, 6067, 6049, 6050, 6107, 6075],
        tint: [0.65, 1.05, 1.5],
        accent: [70, 150, 255],
        prompt: 'Study these 6 original Escape Velocity Nova (2002) pre-rendered 3D outfit icons. Generate a brand-new 1:1 square icon in this EXACT early-2000s LightWave 3D pre-rendered style on a pure solid black (#000000) background: an Aegis Shield Matrix generator mounted on a dark warship hull with glowing electric-blue energy conduits and a translucent hemispherical forcefield dome. No text, no borders, no UI.',
        price: 45_000,
        max: 4,
        freeMass: 5,
        physics: {
            freeMass: 5,
            shield: 250,
            shieldRecharge: 80,
        },
        desc: 'A heavy military-grade shield emitter matrix developed by Federation and Auroran fleet engineers. Adds +250 maximum shield capacity and +80 shield regeneration per unit.',
    },
    {
        id: 'conquest:hull_nanites',
        name: 'Nano-Armor Plating',
        referencePictIds: [6074, 6067, 6051, 6004, 6142, 6065],
        tint: [0.75, 1.35, 0.85],
        accent: [60, 240, 120],
        prompt: 'Study these 6 original Escape Velocity Nova (2002) pre-rendered 3D outfit icons. Generate a brand-new 1:1 square icon in this EXACT early-2000s LightWave 3D pre-rendered style on a pure solid black (#000000) background: interlocking beveled tritanium Nano-Armor hull plates with glowing emerald-green nanite repair veins between the armor seams. No text, no borders, no UI.',
        price: 40_000,
        max: 4,
        freeMass: 5,
        repairSystem: true,
        physics: {
            freeMass: 5,
            armor: 220,
            armorRecharge: 50,
        },
        desc: 'Bonds self-healing ablative tritanium plates and active repair nanites to your hull. Adds +220 armor integrity and +50 continuous in-flight armor regeneration per unit.',
    },
    {
        id: 'conquest:vellos_dart_license',
        name: 'Vell-os T3 Attunement (Dart)',
        referencePictIds: [5045, 6093, 6124, 6125, 6121, 5046],
        tint: [0.95, 0.75, 1.5],
        accent: [190, 90, 255],
        prompt: 'Study these 6 original Escape Velocity Nova (2002) Vell-os pre-rendered 3D artworks (note the smooth matte-grey telepathic core, translucent rippled blue-glass psionic wings of the Vell-os Dart in image 1, and golden Flower of Spring psionic energy in image 2). Generate a brand-new 1:1 square icon in this EXACT early-2000s LightWave 3D pre-rendered style on a pure solid black (#000000) background: a Vell-os T3 Telepathic Attunement resonant psi-crystal crest shaped like the crescent Vell-os Dart with translucent rippled blue-glass psionic wings and a warm golden Flower of Spring psychic core aura. No text, no borders, no UI.',
        price: 450_000,
        max: 1,
        freeMass: 0,
        physics: {
            freeMass: 0,
        },
        desc: 'Awakens third-order Vell-os telepathic resonance. Once attuned, you may manifest a Vell-os Dart (600 top speed, regenerating psionic energy, and built-in Flower of Spring beam) in the Sol Shipyard at zero credit cost.',
    },
    {
        id: 'conquest:vellos_arrow_license',
        name: 'Vell-os T2 Attunement (Arrow)',
        referencePictIds: [5046, 6094, 6093, 6124, 5045, 5047],
        tint: [1.35, 0.65, 1.45],
        accent: [255, 80, 220],
        prompt: 'Study these 6 original Escape Velocity Nova (2002) Vell-os pre-rendered 3D artworks (note the sleek spindle core and twin translucent rippled blue-glass psionic wings of the Vell-os Arrow in image 1, and crimson-magenta Summer Bloom psychic energy in image 2). Generate a brand-new 1:1 square icon in this EXACT early-2000s LightWave 3D pre-rendered style on a pure solid black (#000000) background: a Vell-os T2 Telepathic Attunement psionic focus artifact featuring the twin-bladed Vell-os Arrow crystalline wing geometry radiating intense crimson-magenta Summer Bloom telepathic energy waves. No text, no borders, no UI.',
        price: 1_800_000,
        max: 1,
        freeMass: 0,
        physics: {
            freeMass: 0,
        },
        desc: 'Awakens second-order Vell-os telepathic mastery. Once attuned, you may manifest a Vell-os Arrow (990 shields, Summer Bloom turret beam, and Flower of Spring) or Dart in the Sol Shipyard at zero credit cost.',
    },
    {
        id: 'conquest:vellos_javelin_license',
        name: 'Vell-os T1 Attunement (Javelin)',
        referencePictIds: [5047, 6095, 6096, 6094, 5046, 6124],
        tint: [1.4, 1.1, 1.55],
        accent: [230, 160, 255],
        prompt: 'Study these 6 original Escape Velocity Nova (2002) Vell-os pre-rendered 3D artworks (note the swept delta translucent rippled blue-glass psionic wings of the Vell-os Javelin in image 1, brilliant white Autumn Petal beam in image 2, and cyan Winter Tempest lightning in image 3). Generate a brand-new 1:1 square icon in this EXACT early-2000s LightWave 3D pre-rendered style on a pure solid black (#000000) background: the supreme Vell-os T1 Ruling-Caste Telepathic Attunement crown — an ornate floating Vell-os Javelin psionic crystal matrix with swept translucent blue-glass wings, a blazing white-silver Autumn Petal core, and arcs of cyan Winter Tempest psionic lightning. No text, no borders, no UI.',
        price: 4_500_000,
        max: 1,
        freeMass: 0,
        physics: {
            freeMass: 0,
        },
        desc: 'Awakens first-order Vell-os ruling-caste telepathy. Once attuned, you may manifest the supreme Vell-os Javelin (1,740 shields, Autumn Petal, Summer Bloom, Flower of Spring, and Create Dart psychic bay) in the Sol Shipyard at zero credit cost.',
    },
];

function resolveGeminiApiKey(): string | undefined {
    if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
    if (process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY;
    try {
        const key = execSync(
            'security find-internet-password -s "https://generativelanguage.googleapis.com" -w 2>/dev/null',
            { encoding: 'utf8' },
        ).trim();
        if (key) return key;
    } catch {
        // Fallback below
    }
    try {
        const key = execSync(
            'security find-generic-password -s "gemini" -w 2>/dev/null',
            { encoding: 'utf8' },
        ).trim();
        if (key) return key;
    } catch {
        // Ignore
    }
    return undefined;
}

async function loadAllRetailPicts(pictIds: ReadonlySet<number>): Promise<Map<number, Buffer>> {
    const result = new Map<number, Buffer>();
    const dir = path.resolve(__dirname, '../nova/Nova_Data/Nova Files');
    if (!fs.existsSync(dir)) return result;
    for (const file of fs.readdirSync(dir).filter(n => n.endsWith('.ndat'))) {
        const fork = await readResourceFork(path.join(dir, file), false);
        const pictMap = (fork as Record<string, any>).PICT;
        if (!pictMap) continue;
        for (const id of pictIds) {
            if (!result.has(id) && pictMap[id]) {
                const png = new PICTParse(pictMap[id].data).PNG;
                result.set(id, PNG.sync.write(png));
            }
        }
    }
    return result;
}

async function generateWithNanoBanana(
    prompt: string,
    referencePngs: readonly Buffer[],
    apiKey: string,
): Promise<Buffer | undefined> {
    const models = [
        process.env.NOVA_IMAGE_MODEL,
        'gemini-nano-banana-2.1',
        'gemini-3.1-flash-image-preview',
        'gemini-3.1-flash-image',
    ].filter((m): m is string => Boolean(m));

    const parts: any[] = [
        ...referencePngs.map(buf => ({
            inlineData: {
                mimeType: 'image/png',
                data: buf.toString('base64'),
            },
        })),
        { text: prompt },
    ];

    for (const model of models) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts }],
                    generationConfig: {
                        responseModalities: ['IMAGE', 'TEXT'],
                    },
                }),
            });
            if (!response.ok) {
                console.warn(`Model ${model} returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
                continue;
            }
            const json = await response.json() as any;
            for (const candidate of json.candidates ?? []) {
                for (const part of candidate.content?.parts ?? []) {
                    if (part.inlineData?.data) {
                        const raw = Buffer.from(part.inlineData.data, 'base64');
                        const resized = await sharp(raw)
                            .resize(200, 200, { fit: 'cover' })
                            .png()
                            .toBuffer();
                        console.log(`  -> Generated via ${model} using ${referencePngs.length} EV Nova reference artworks`);
                        return resized;
                    }
                }
            }
        } catch (err) {
            console.warn(`Model ${model} failed:`, err);
        }
    }
    return undefined;
}

function stylePictPng(
    sourceBuf: Buffer | undefined,
    tint: [number, number, number],
    accent: [number, number, number],
): Buffer {
    const source = sourceBuf ? PNG.sync.read(sourceBuf) : undefined;
    const width = source?.width ?? 200;
    const height = source?.height ?? 200;
    const out = new PNG({ width, height });

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (width * y + x) << 2;
            let r = source ? source.data[idx] : 0;
            let g = source ? source.data[idx + 1] : 0;
            let b = source ? source.data[idx + 2] : 0;

            const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
            r = Math.min(255, Math.round(r * tint[0] + lum * lum * accent[0] * 0.28));
            g = Math.min(255, Math.round(g * tint[1] + lum * lum * accent[1] * 0.28));
            b = Math.min(255, Math.round(b * tint[2] + lum * lum * accent[2] * 0.28));

            out.data[idx] = r;
            out.data[idx + 1] = g;
            out.data[idx + 2] = b;
            out.data[idx + 3] = 255;
        }
    }
    return PNG.sync.write(out);
}

async function main() {
    const objectsDir = path.resolve(__dirname, '../nova/objects');
    const outfitDir = path.join(objectsDir, 'Outfit');
    const pictDir = path.join(objectsDir, 'Pict');
    const pictImageDir = path.join(objectsDir, 'PictImage');
    fs.mkdirSync(outfitDir, { recursive: true });
    fs.mkdirSync(pictDir, { recursive: true });
    fs.mkdirSync(pictImageDir, { recursive: true });

    const allPictIds = new Set<number>();
    for (const spec of CONQUEST_ASSETS) {
        for (const id of spec.referencePictIds) {
            allPictIds.add(id);
        }
    }
    const retailPicts = await loadAllRetailPicts(allPictIds);
    const apiKey = resolveGeminiApiKey();

    const filterArg = process.argv[2]?.toLowerCase();
    const specs = filterArg
        ? CONQUEST_ASSETS.filter(s => s.id.toLowerCase().includes(filterArg))
        : CONQUEST_ASSETS;

    await Promise.all(specs.map(async spec => {
        const encoded = encodeURIComponent(spec.id);
        const refs = spec.referencePictIds
            .map(id => retailPicts.get(id))
            .filter((b): b is Buffer => Boolean(b));

        console.log(`Generating ${spec.id} (${spec.name}) with ${refs.length} reference images...`);
        let finalPng = apiKey
            ? await generateWithNanoBanana(spec.prompt, refs, apiKey)
            : undefined;
        if (!finalPng) {
            finalPng = stylePictPng(refs[0], spec.tint, spec.accent);
        }

        fs.writeFileSync(path.join(pictImageDir, `${encoded}.png`), finalPng);
        fs.writeFileSync(
            path.join(pictDir, `${encoded}.json`),
            JSON.stringify({
                id: spec.id,
                name: spec.name,
                prefix: 'conquest',
            }, null, 2) + '\n',
        );

        const outfitJson = {
            id: spec.id,
            name: spec.name,
            prefix: 'conquest',
            weapons: {},
            repairSystem: Boolean(spec.repairSystem),
            cloak: false,
            cargoScoop: Boolean(spec.cargoScoop),
            physics: spec.physics,
            pict: spec.id,
            price: spec.price,
            desc: spec.desc,
            displayWeight: 90,
            flags: 0,
            max: spec.max,
            techLevel: 1,
            availabilityNCB: '',
            onPurchase: '',
            onSell: '',
            contribute: [0, 0],
            require: [0, 0],
            isEscapePod: false,
            isAutoRecharger: false,
        };
        fs.writeFileSync(
            path.join(outfitDir, `${encoded}.json`),
            JSON.stringify(outfitJson, null, 2) + '\n',
        );
    }));
}

void main();
