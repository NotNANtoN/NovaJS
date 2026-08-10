import 'jasmine';
import { getDefaultOutfitData, OutfitData } from 'novadatainterface/outfit_data';
import {
    getDefaultProjectileWeaponData, WeaponData,
} from 'novadatainterface/weapon_data';
import { Entity } from 'nova_ecs/entity';
import { FuelComponent } from '../nova_plugin/health_plugin.js';
import {
    OutfitsState, OutfitsStateComponent,
} from '../nova_plugin/outfit_plugin.js';
import { Stat } from '../nova_plugin/stat.js';
import {
    RestockGameData, restockCarriedEscorts, restockEscortEntity,
} from './escort_restock.js';

function outfit(o: Partial<OutfitData> & { id: string }): OutfitData {
    return { ...getDefaultOutfitData(), ...o };
}

function launcherWeapon(w: Partial<WeaponData> & { id: string }): WeaponData {
    return { ...getDefaultProjectileWeaponData(), ...w } as WeaponData;
}

/** A game data stub over fixed outfit and weapon tables. */
function gameDataOf(outfits: OutfitData[], weapons: WeaponData[]):
    RestockGameData {
    const outfitMap = new Map(outfits.map(o => [o.id, o]));
    const weaponMap = new Map(weapons.map(w => [w.id, w]));
    return {
        getOutfit: async id => outfitMap.get(id),
        getWeapon: async id => weaponMap.get(id),
    };
}

function stat(current: number, max: number): Stat {
    return new Stat({ current, max, min: 0, recharge: 0 });
}

function escortEntity(outfits: OutfitsState, fuel?: Stat): Entity {
    const entity = new Entity('escort');
    entity.components.set(OutfitsStateComponent, outfits);
    if (fuel) {
        entity.components.set(FuelComponent, fuel);
    }
    return entity;
}

describe('escort restock', () => {
    it('refuels to full', async () => {
        const entity = escortEntity(new Map(), stat(17, 400));
        await restockEscortEntity(entity, gameDataOf([], []));
        expect(entity.components.get(FuelComponent)!.current).toEqual(400);
    });

    it('leaves an entity with no fuel stat alone', async () => {
        const entity = escortEntity(new Map());
        await restockEscortEntity(entity, gameDataOf([], []));
        expect(entity.components.has(FuelComponent)).toBeFalse();
    });

    it('restocks ammo to launcher maxAmmo times the launcher count',
        async () => {
            // Two launchers aboard, each holding 10 rounds: capacity 20.
            const rocket = outfit({ id: 'ammo', ammoFor: 'launcher' });
            const launcherOutfit = outfit({
                id: 'launcherOutfit', weapons: { launcher: 1 },
            });
            const weapon = launcherWeapon({
                id: 'launcher', maxAmmo: 10, ammoType: ['weapon', 'launcher'],
            });
            const outfits: OutfitsState = new Map([
                ['ammo', { count: 3 }],
                ['launcherOutfit', { count: 2 }],
            ]);
            await restockEscortEntity(escortEntity(outfits),
                gameDataOf([rocket, launcherOutfit], [weapon]));
            expect(outfits.get('ammo')!.count).toEqual(20);
        });

    it('falls back to the outfit Max when the weapon has no maxAmmo',
        async () => {
            // maxAmmo 0 means "constrained by the ammo outfit's Max".
            const ammo = outfit({ id: 'ammo', ammoFor: 'gun', max: 50 });
            const weapon = launcherWeapon({ id: 'gun', maxAmmo: 0 });
            const outfits: OutfitsState = new Map([['ammo', { count: 4 }]]);
            await restockEscortEntity(escortEntity(outfits),
                gameDataOf([ammo], [weapon]));
            expect(outfits.get('ammo')!.count).toEqual(50);
        });

    it('applies increases-max items to the Max fallback', async () => {
        const ammo = outfit({ id: 'ammo', ammoFor: 'gun', max: 50 });
        const expander = outfit({ id: 'expander', increasesMax: 'ammo' });
        const weapon = launcherWeapon({ id: 'gun', maxAmmo: 0 });
        const outfits: OutfitsState = new Map([
            ['ammo', { count: 4 }], ['expander', { count: 3 }],
        ]);
        await restockEscortEntity(escortEntity(outfits),
            gameDataOf([ammo, expander], [weapon]));
        expect(outfits.get('ammo')!.count).toEqual(150);
    });

    it('leaves unlimited ammo (Max <= 0, no launcher cap) untouched',
        async () => {
            const ammo = outfit({ id: 'ammo', ammoFor: 'gun', max: 0 });
            const weapon = launcherWeapon({ id: 'gun', maxAmmo: 0 });
            const outfits: OutfitsState = new Map([['ammo', { count: 4 }]]);
            await restockEscortEntity(escortEntity(outfits),
                gameDataOf([ammo], [weapon]));
            expect(outfits.get('ammo')!.count).toEqual(4);
        });

    it("restores a carrier's fighter complement, which is ammo too",
        async () => {
            // A bay outfit is a launcher whose "ammo" is the fighter.
            const fighters = outfit({ id: 'fighters', ammoFor: 'bay' });
            const bayOutfit = outfit({ id: 'bayOutfit', weapons: { bay: 1 } });
            const bay = launcherWeapon({
                id: 'bay', maxAmmo: 4, ammoType: ['weapon', 'bay'],
            });
            // Two fighters were launched and lost: 2 of 4 left.
            const outfits: OutfitsState = new Map([
                ['fighters', { count: 2 }], ['bayOutfit', { count: 1 }],
            ]);
            await restockEscortEntity(escortEntity(outfits),
                gameDataOf([fighters, bayOutfit], [bay]));
            expect(outfits.get('fighters')!.count).toEqual(4);
        });

    it('never trims a magazine that is somehow overfull', async () => {
        const ammo = outfit({ id: 'ammo', ammoFor: 'gun', max: 10 });
        const weapon = launcherWeapon({ id: 'gun', maxAmmo: 0 });
        const outfits: OutfitsState = new Map([['ammo', { count: 25 }]]);
        await restockEscortEntity(escortEntity(outfits),
            gameDataOf([ammo], [weapon]));
        expect(outfits.get('ammo')!.count).toEqual(25);
    });

    it('leaves non-ammo outfits alone', async () => {
        const armorPlate = outfit({ id: 'plate', max: 4 });
        const outfits: OutfitsState = new Map([['plate', { count: 1 }]]);
        await restockEscortEntity(escortEntity(outfits),
            gameDataOf([armorPlate], []));
        expect(outfits.get('plate')!.count).toEqual(1);
    });

    it('restocks a whole batch', async () => {
        const ammo = outfit({ id: 'ammo', ammoFor: 'gun', max: 9 });
        const weapon = launcherWeapon({ id: 'gun', maxAmmo: 0 });
        const first: OutfitsState = new Map([['ammo', { count: 1 }]]);
        const second: OutfitsState = new Map([['ammo', { count: 2 }]]);
        const batch = [
            { entity: escortEntity(first, stat(0, 300)) },
            { entity: escortEntity(second, stat(50, 300)) },
        ];
        await restockCarriedEscorts(batch, gameDataOf([ammo], [weapon]));
        expect(first.get('ammo')!.count).toEqual(9);
        expect(second.get('ammo')!.count).toEqual(9);
        for (const { entity } of batch) {
            expect(entity.components.get(FuelComponent)!.current).toEqual(300);
        }
    });
});
