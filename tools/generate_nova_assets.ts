/**
 * Generates EV Nova-styled Outfit PICT artwork and Outfit JSON definitions for
 * Galactic Conquest Mode.
 *
 * Supports two modes:
 * 1. Google Nano Banana 2.1 (`gemini-3.1-flash-image-preview`) AI generation
 *    when `GEMINI_API_KEY` or `GOOGLE_API_KEY` is set in the environment: passes
 *    an original EV Nova PICT from `Nova_Data` as a style reference image and
 *    prompts the model to render a matching 200x200 3D pre-rendered icon.
 * 2. Deterministic offline synthesis from retail `Nova_Data` PICT resources
 *    with custom color-grading and plasma rim lighting so builds work offline.
 *
 * Usage:
 *   GEMINI_API_KEY=... bun tools/generate_nova_assets.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';
import { readResourceFork } from 'resource_fork';
import { PICTParse } from '../novaparse/src/resource_parsers/PICTParse';

interface ConquestAssetSpec {
    id: string;
    name: string;
    basePictId: number;
    tint: [number, number, number];
    accent: [number, number, number];
    prompt: string;
    price: number;
    max: number;
    freeMass: number;
    cargoScoop?: boolean;
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
        basePictId: 6069, // Afterburner
        tint: [1.35, 0.95, 0.65],
        accent: [255, 140, 40],
        prompt: 'Create a 200x200 pre-rendered 3D sci-fi spacecraft twin plasma overdrive thruster module in the exact early-2000s LightWave 3D style of Escape Velocity Nova, isolated on a pure black background with warm orange-gold exhaust glow and brushed titanium housing.',
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
        basePictId: 6143, // Asteroid Scoop
        tint: [0.65, 1.3, 1.45],
        accent: [40, 220, 255],
        prompt: 'Create a 200x200 pre-rendered 3D sci-fi electromagnetic graviton tractor beam projector array in the exact early-2000s LightWave 3D style of Escape Velocity Nova, isolated on a pure black background with cyan magnetic emitter coils.',
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
        basePictId: 6142, // Asteroid Mining Laser
        tint: [1.4, 1.25, 0.55],
        accent: [255, 220, 50],
        prompt: 'Create a 200x200 pre-rendered 3D sci-fi high-voltage seismic resonance mining laser capacitor in the exact early-2000s LightWave 3D style of Escape Velocity Nova, isolated on a pure black background with glowing amber-yellow energy conduits.',
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
        basePictId: 6065, // Shield Recharger
        tint: [0.65, 1.05, 1.5],
        accent: [70, 150, 255],
        prompt: 'Create a 200x200 pre-rendered 3D sci-fi toroidal shield generator matrix in the exact early-2000s LightWave 3D style of Escape Velocity Nova, isolated on a pure black background with deep electric-blue field coils.',
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
        basePictId: 6074, // Horizontal Booster
        tint: [0.75, 1.35, 0.85],
        accent: [60, 240, 120],
        prompt: 'Create a 200x200 pre-rendered 3D sci-fi interlocking reactive nano-armor hull plate assembly in the exact early-2000s LightWave 3D style of Escape Velocity Nova, isolated on a pure black background with emerald repair nanite conduits.',
        price: 40_000,
        max: 4,
        freeMass: 5,
        repairSystem: true,
        physics: {
            freeMass: 5,
            armor: 220,
            armorRecharge: 50,
        },
        desc: ' Bonds self-healing ablative tritanium plates and active repair nanites to your hull. Adds +220 armor integrity and +50 continuous in-flight armor regeneration per unit.',
    } as ConquestAssetSpec & { repairSystem?: boolean },
];

async function extractRetailPictPng(pictId: number): Promise<PNG | undefined> {
    const dir = path.resolve(__dirname, '../nova/Nova_Data/Nova Files');
    if (!fs.existsSync(dir)) return undefined;
    for (const file of fs.readdirSync(dir).filter(n => n.endsWith('.ndat'))) {
        const fork = await readResourceFork(path.join(dir, file), false);
        const pictMap = (fork as Record<string, any>).PICT;
        if (pictMap && pictMap[pictId]) {
            return new PICTParse(pictMap[pictId].data).PNG;
        }
    }
    return undefined;
}

async function generateWithNanoBanana(
    prompt: string,
    referencePng: Buffer | undefined,
    apiKey: string,
): Promise<Buffer | undefined> {
    const model = process.env.NOVA_IMAGE_MODEL || 'gemini-3.1-flash-image-preview';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const parts: any[] = [{ text: prompt }];
    if (referencePng) {
        parts.unshift({
            inlineData: {
                mimeType: 'image/png',
                data: referencePng.toString('base64'),
            },
        });
    }
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
        console.warn(`Nano Banana API returned ${response.status}: ${await response.text()}`);
        return undefined;
    }
    const json = await response.json() as any;
    for (const candidate of json.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
            if (part.inlineData?.data) {
                return Buffer.from(part.inlineData.data, 'base64');
            }
        }
    }
    return undefined;
}

function stylePictPng(
    source: PNG | undefined,
    tint: [number, number, number],
    accent: [number, number, number],
): Buffer {
    const width = source?.width ?? 200;
    const height = source?.height ?? 200;
    const out = new PNG({ width, height });

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (width * y + x) << 2;
            let r = source ? source.data[idx] : 0;
            let g = source ? source.data[idx + 1] : 0;
            let b = source ? source.data[idx + 2] : 0;

            // Color-grade the pre-rendered 3D sprite while keeping deep black shadows
            const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
            r = Math.min(255, Math.round(r * tint[0] + lum * lum * accent[0] * 0.28));
            g = Math.min(255, Math.round(g * tint[1] + lum * lum * accent[1] * 0.28));
            b = Math.min(255, Math.round(b * tint[2] + lum * lum * accent[2] * 0.28));

            // Subtle tech frame border glow on the 200x200 tile
            const edgeDist = Math.min(x, y, width - 1 - x, height - 1 - y);
            if (edgeDist === 2 || edgeDist === 3) {
                r = Math.min(255, r + Math.round(accent[0] * 0.35));
                g = Math.min(255, g + Math.round(accent[1] * 0.35));
                b = Math.min(255, b + Math.round(accent[2] * 0.35));
            }

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

    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

    for (const spec of CONQUEST_ASSETS) {
        const encoded = encodeURIComponent(spec.id);
        const basePng = await extractRetailPictPng(spec.basePictId);
        const baseBuf = basePng ? PNG.sync.write(basePng) : undefined;

        let finalPng = apiKey
            ? await generateWithNanoBanana(spec.prompt, baseBuf, apiKey)
            : undefined;
        if (!finalPng) {
            finalPng = stylePictPng(basePng, spec.tint, spec.accent);
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
            repairSystem: Boolean((spec as any).repairSystem),
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
        console.log(`Generated ${spec.id} (${spec.name})`);
    }
}

void main();
