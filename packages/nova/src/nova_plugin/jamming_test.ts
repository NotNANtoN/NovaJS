import 'jasmine';
import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { Entity } from 'nova_ecs/entity';
import { MovementStateComponent }
    from 'nova_ecs/plugins/movement_plugin';
import { Random, RandomResource } from 'nova_ecs/plugins/random_plugin';
import { World } from 'nova_ecs/world';
import { getDefaultProjectileWeaponData, getDefaultSeekerFlags, SeekerFlags }
    from 'novadatainterface/weapon_data';
import { getDefaultOutfitData } from 'novadatainterface/outfit_data';
import { getDefaultGovtData, GovtData } from 'novadatainterface/govt_data';
import {
    decideJamReaction,
    deriveJamming,
    DecoyTargetComponent,
    effectiveJamming,
    findNearestDecoy,
    Jamming,
    JammingComponent,
    JamSteerComponent,
    JAM_FRAME_RATE,
    jamLoseLockProbability,
    MissileJammingSystem,
    RADAR_JAM_INDEX,
    SystemInterferenceResource,
} from './jamming_plugin.js';
import { ProjectileDataComponent } from './projectile_data.js';
import { SourceComponent } from './fire_weapon_plugin.js';
import { TargetComponent } from './target_component.js';

/** A stand-in for the simulation game data, exposing only Outfit.getCached. */
function mockGameData(outfits: Record<string, ReturnType<typeof getDefaultOutfitData>>,
    govts: Record<string, GovtData> = {}) {
    return {
        data: {
            Outfit: {
                getCached: (id: string) => outfits[id],
            },
            Govt: {
                getCached: (id: string) => govts[id],
            },
        },
    } as any;
}

/** A GovtData with the given InhJam1-4 and everything else at defaults. */
function govtWithInhJam(inhJam: [number, number, number, number]): GovtData {
    return { ...getDefaultGovtData(), inhJam };
}

function movement(x: number, y: number) {
    return {
        position: new Position(x, y),
        rotation: new Angle(0),
        velocity: new Vector(0, 0),
        accelerating: 0,
        turning: 0,
        turnBack: false,
    };
}

describe('deriveJamming (ship jamming accumulation from outfits)', () => {
    it('sums per-type jamming across outfits, scaled by count', () => {
        const irJammer = { ...getDefaultOutfitData(), jamming: [20, 0, 0, 0] as const };
        const radarJammer = { ...getDefaultOutfitData(), jamming: [0, 15, 0, 0] as const };
        const gameData = mockGameData({
            'nova:irJammer': irJammer,
            'nova:radarJammer': radarJammer,
        });

        const outfits = new Map([
            ['nova:irJammer', { count: 2 }],   // 2 * [20,0,0,0]
            ['nova:radarJammer', { count: 1 }], // 1 * [0,15,0,0]
        ]);

        const result = deriveJamming(outfits, gameData);
        expect(result).toEqual([40, 15, 0, 0]);
    });

    it('handles negative jamming contributions (they subtract)', () => {
        const jammer = { ...getDefaultOutfitData(), jamming: [30, 0, 0, 0] as const };
        const disruptor = { ...getDefaultOutfitData(), jamming: [-10, 0, 0, 0] as const };
        const gameData = mockGameData({ a: jammer, b: disruptor });
        const outfits = new Map([['a', { count: 1 }], ['b', { count: 1 }]]);
        expect(deriveJamming(outfits, gameData)).toEqual([20, 0, 0, 0]);
    });

    it('returns undefined when an outfit is not cached yet', () => {
        const gameData = mockGameData({});
        const outfits = new Map([['missing', { count: 1 }]]);
        expect(deriveJamming(outfits, gameData)).toBeUndefined();
    });

    it('returns all zeroes for a ship with no jamming outfits', () => {
        const plain = { ...getDefaultOutfitData(), jamming: [0, 0, 0, 0] as const };
        const gameData = mockGameData({ p: plain });
        const outfits = new Map([['p', { count: 3 }]]);
        expect(deriveJamming(outfits, gameData)).toEqual([0, 0, 0, 0]);
    });
});

describe('deriveJamming with a government (InhJam1-4 composition)', () => {
    it('gives a ship with a govt and no jammer outfits its govt InhJam values', () => {
        const gameData = mockGameData({},
            { 'nova:136': govtWithInhJam([50, 50, 35, 20]) });
        // No outfits at all.
        const result = deriveJamming(new Map(), gameData, 'nova:136');
        expect(result).toEqual([50, 50, 35, 20]);
    });

    it('takes the per-type MAX of outfit jamming and govt InhJam', () => {
        // Outfits sum to [40, 10, 0, 0]; govt InhJam is [20, 50, 35, 0].
        // Expect per-type max: [40, 50, 35, 0].
        const irJammer = { ...getDefaultOutfitData(), jamming: [20, 0, 0, 0] as const };
        const radarJammer = { ...getDefaultOutfitData(), jamming: [0, 10, 0, 0] as const };
        const gameData = mockGameData(
            { ir: irJammer, radar: radarJammer },
            { 'nova:g': govtWithInhJam([20, 50, 35, 0]) });
        const outfits = new Map([['ir', { count: 2 }], ['radar', { count: 1 }]]);
        expect(deriveJamming(outfits, gameData, 'nova:g')).toEqual([40, 50, 35, 0]);
    });

    it('does not let govt InhJam push a stronger outfit value down', () => {
        // Outfit out-jams the govt on type 1; the outfit value wins.
        const strong = { ...getDefaultOutfitData(), jamming: [80, 0, 0, 0] as const };
        const gameData = mockGameData({ s: strong },
            { 'nova:g': govtWithInhJam([50, 0, 0, 0]) });
        const outfits = new Map([['s', { count: 1 }]]);
        expect(deriveJamming(outfits, gameData, 'nova:g')).toEqual([80, 0, 0, 0]);
    });

    it('clamps a negative outfit total up to the govt InhJam floor (max)', () => {
        // A "disruptor" outfit makes the outfit total negative on type 1;
        // the govt's inherent jamming is the floor.
        const disruptor = { ...getDefaultOutfitData(), jamming: [-30, 0, 0, 0] as const };
        const gameData = mockGameData({ d: disruptor },
            { 'nova:g': govtWithInhJam([10, 0, 0, 0]) });
        const outfits = new Map([['d', { count: 1 }]]);
        expect(deriveJamming(outfits, gameData, 'nova:g')).toEqual([10, 0, 0, 0]);
    });

    it('leaves jamming outfit-only when no govt id is given (unchanged behaviour)', () => {
        const jammer = { ...getDefaultOutfitData(), jamming: [20, 0, 0, 0] as const };
        const gameData = mockGameData({ j: jammer },
            { 'nova:g': govtWithInhJam([90, 90, 90, 90]) });
        const outfits = new Map([['j', { count: 1 }]]);
        // No govtId -> the govt is never consulted.
        expect(deriveJamming(outfits, gameData)).toEqual([20, 0, 0, 0]);
    });

    it('returns undefined when the govt is given but not cached yet', () => {
        const jammer = { ...getDefaultOutfitData(), jamming: [20, 0, 0, 0] as const };
        const gameData = mockGameData({ j: jammer }); // no govts cached
        const outfits = new Map([['j', { count: 1 }]]);
        expect(deriveJamming(outfits, gameData, 'nova:missing')).toBeUndefined();
    });
});

describe('effectiveJamming', () => {
    const noSeeker = getDefaultSeekerFlags();

    it('clamps negative ship jamming to zero and caps at 100', () => {
        expect(effectiveJamming([-5, 200, 0, 0], noSeeker, 0))
            .toEqual([0, 100, 0, 0]);
    });

    it('adds system interference to the radar slot only for confusedByInterference missiles', () => {
        const radarSeeker: SeekerFlags = { ...noSeeker, confusedByInterference: true };
        const eff = effectiveJamming([0, 10, 0, 0], radarSeeker, 30);
        expect(eff[RADAR_JAM_INDEX]).toEqual(40); // 10 + 30
        // Other slots unaffected.
        expect(eff[0]).toEqual(0);
        expect(eff[2]).toEqual(0);
        expect(eff[3]).toEqual(0);
    });

    it('ignores system interference when the missile is not confusedByInterference', () => {
        const eff = effectiveJamming([0, 10, 0, 0], noSeeker, 30);
        expect(eff[RADAR_JAM_INDEX]).toEqual(10);
    });

    it('caps the interference-boosted radar slot at 100', () => {
        const radarSeeker: SeekerFlags = { ...noSeeker, confusedByInterference: true };
        const eff = effectiveJamming([0, 80, 0, 0], radarSeeker, 90);
        expect(eff[RADAR_JAM_INDEX]).toEqual(100);
    });
});

describe('jamLoseLockProbability (vulnerability application per type)', () => {
    it('is zero when the missile has no vulnerability, however strong the jamming', () => {
        expect(jamLoseLockProbability([0, 0, 0, 0], [100, 100, 100, 100])).toEqual(0);
    });

    it('is zero when the ship has no jamming, however vulnerable the missile', () => {
        expect(jamLoseLockProbability([100, 100, 100, 100], [0, 0, 0, 0])).toEqual(0);
    });

    it('scales a single matching type by vuln * jam * JAM_FRAME_RATE', () => {
        // 100% vuln vs 100% jam on one type => 1.0, times JAM_FRAME_RATE.
        expect(jamLoseLockProbability([100, 0, 0, 0], [100, 0, 0, 0]))
            .toBeCloseTo(JAM_FRAME_RATE, 10);
        // 50% vuln vs 50% jam => 0.25, times JAM_FRAME_RATE.
        expect(jamLoseLockProbability([50, 0, 0, 0], [50, 0, 0, 0]))
            .toBeCloseTo(0.25 * JAM_FRAME_RATE, 10);
    });

    it('combines independent types as 1 - product(1 - p_k)', () => {
        // Two types each at 100%/100% => keep = 0 => lose 1.0 * rate.
        expect(jamLoseLockProbability([100, 100, 0, 0], [100, 100, 0, 0]))
            .toBeCloseTo(JAM_FRAME_RATE, 10);
        // Two types each at 50%/50% (p=0.25 each): 1 - 0.75*0.75 = 0.4375.
        expect(jamLoseLockProbability([50, 50, 0, 0], [50, 50, 0, 0]))
            .toBeCloseTo((1 - 0.75 * 0.75) * JAM_FRAME_RATE, 10);
    });

    it('only counts matching type indices (IR jammer vs radar missile does nothing)', () => {
        // Missile vulnerable only to radar (index 1); ship jams only IR (index 0).
        expect(jamLoseLockProbability([0, 100, 0, 0], [100, 0, 0, 0])).toEqual(0);
    });
});

describe('decideJamReaction (seeker-flag precedence)', () => {
    const flags = (over: Partial<SeekerFlags>): SeekerFlags =>
        ({ ...getDefaultSeekerFlags(), ...over });

    it('returns none when the roll does not beat the probability', () => {
        expect(decideJamReaction(0.3, 0.5, flags({})).kind).toEqual('none');
        // Boundary: roll == probability is NOT a lose (roll >= p).
        expect(decideJamReaction(0.3, 0.3, flags({})).kind).toEqual('none');
    });

    it('flies straight by default when jammed with no special seeker flags', () => {
        expect(decideJamReaction(0.5, 0.1, flags({})).kind).toEqual('flyStraight');
    });

    it('prefers retargeting the parent over all other reactions', () => {
        const r = decideJamReaction(0.5, 0.1, flags({
            attackParentIfJammed: true,
            decoyedByAsteroids: true,
            turnsAwayIfJammed: true,
        }));
        expect(r.kind).toEqual('retargetParent');
    });

    it('prefers decoy over veer when both are set (and no parent flag)', () => {
        const r = decideJamReaction(0.5, 0.1, flags({
            decoyedByAsteroids: true,
            turnsAwayIfJammed: true,
        }));
        expect(r.kind).toEqual('retargetDecoy');
    });

    it('veers away when only turnsAwayIfJammed is set', () => {
        expect(decideJamReaction(0.5, 0.1, flags({ turnsAwayIfJammed: true })).kind)
            .toEqual('veerAway');
    });
});

describe('findNearestDecoy (decoy retargeting selection)', () => {
    function decoyEntity(x: number, y: number, weight = 1) {
        return new Entity()
            .addComponent(DecoyTargetComponent, { weight })
            .addComponent(MovementStateComponent, movement(x, y));
    }

    it('returns undefined when there are no decoys', () => {
        const entities = new Map<string, Entity>([
            ['plain', new Entity().addComponent(MovementStateComponent, movement(0, 0))],
        ]);
        expect(findNearestDecoy(entities, new Position(0, 0))).toBeUndefined();
    });

    it('ignores decoys out of range', () => {
        // 5000 units away, well beyond DECOY_DISTRACTION_RANGE (1000) but still
        // inside the wrapping ±10000 world, so it does not wrap back into range.
        const entities = new Map<string, Entity>([
            ['far', decoyEntity(5000, 0)],
        ]);
        expect(findNearestDecoy(entities, new Position(0, 0))).toBeUndefined();
    });

    it('picks the nearest in-range decoy at equal weight', () => {
        const entities = new Map<string, Entity>([
            ['near', decoyEntity(10, 0)],
            ['mid', decoyEntity(50, 0)],
        ]);
        expect(findNearestDecoy(entities, new Position(0, 0))).toEqual('near');
    });

    it('prefers higher weight even if farther', () => {
        const entities = new Map<string, Entity>([
            ['light-near', decoyEntity(10, 0, 1)],
            ['heavy-far', decoyEntity(200, 0, 5)],
        ]);
        expect(findNearestDecoy(entities, new Position(0, 0))).toEqual('heavy-far');
    });

    it('breaks exact ties by uuid for a total (deterministic) order', () => {
        const entities = new Map<string, Entity>([
            ['bbb', decoyEntity(10, 0)],
            ['aaa', decoyEntity(10, 0)],
        ]);
        // Same weight and distance: the lexicographically smaller id wins.
        expect(findNearestDecoy(entities, new Position(0, 0))).toEqual('aaa');
    });
});

/**
 * Builds a bare world with only what MissileJammingSystem needs: the random
 * generator, the interference resource, and the system itself.
 */
function makeJammingWorld(seed: number, interference = 0) {
    const world = new World('jamming-test');
    world.resources.set(RandomResource, new Random(seed));
    world.resources.set(SystemInterferenceResource, { interference });
    world.addSystem(MissileJammingSystem);
    return world;
}

/** A guided missile targeting `targetId`, vulnerable per the given vector. */
function makeMissile(targetId: string | undefined,
    jamVulnerabilities: [number, number, number, number],
    seeker: Partial<SeekerFlags> = {}) {
    const data = {
        ...getDefaultProjectileWeaponData(),
        guidance: 'guided' as const,
        jamVulnerabilities,
        seeker: { ...getDefaultSeekerFlags(), ...seeker },
    };
    const missile = new Entity('missile')
        .addComponent(ProjectileDataComponent, data)
        .addComponent(MovementStateComponent, movement(0, 0))
        .addComponent(TargetComponent, { target: targetId });
    return missile;
}

/** A jamming ship at a position. */
function makeShip(x: number, y: number, jamming: Jamming) {
    return new Entity('ship')
        .addComponent(MovementStateComponent, movement(x, y))
        .addComponent(JammingComponent, jamming);
}

describe('MissileJammingSystem (deterministic integration)', () => {
    it('never jams a missile whose vulnerabilities do not match the ship jamming', () => {
        const world = makeJammingWorld(1);
        // Ship jams IR (index 0); missile vulnerable only to radar (index 1).
        world.entities.set('ship', makeShip(0, 100, [100, 0, 0, 0]));
        world.entities.set('missile', makeMissile('ship', [0, 100, 0, 0]));

        for (let i = 0; i < 200; i++) {
            world.step();
        }
        const missile = world.entities.get('missile')!;
        // No jam steer override was ever set, and the target is unchanged.
        expect(missile.components.get(JamSteerComponent)).toBeUndefined();
        expect(missile.components.get(TargetComponent)!.target).toEqual('ship');
    });

    it('eventually jams a fully-vulnerable missile against a strong jammer', () => {
        const world = makeJammingWorld(1);
        world.entities.set('ship', makeShip(0, 100, [100, 0, 0, 0]));
        // Fully vulnerable to IR, no special seeker flags -> flyStraight.
        world.entities.set('missile', makeMissile('ship', [100, 0, 0, 0]));

        let sawFlyStraight = false;
        for (let i = 0; i < 50; i++) {
            world.step();
            if (world.entities.get('missile')!.components.get(JamSteerComponent)
                === 'flyStraight') {
                sawFlyStraight = true;
            }
        }
        expect(sawFlyStraight).toBeTrue();
    });

    it('is deterministic: identical seed and setup give identical jam outcomes', () => {
        const outcomes = (seed: number) => {
            const world = makeJammingWorld(seed);
            world.entities.set('ship', makeShip(0, 100, [50, 0, 0, 0]));
            world.entities.set('missile', makeMissile('ship', [50, 0, 0, 0]));
            const seq: (string | undefined)[] = [];
            for (let i = 0; i < 100; i++) {
                world.step();
                seq.push(world.entities.get('missile')!
                    .components.get(JamSteerComponent));
            }
            return seq;
        };
        // Same seed -> identical sequence of per-frame jam states.
        expect(outcomes(42)).toEqual(outcomes(42));
        // A different seed produces a (very likely) different sequence.
        expect(outcomes(42)).not.toEqual(outcomes(43));
    });

    it('retargets a jammed decoy-vulnerable missile onto a nearby decoy', () => {
        const world = makeJammingWorld(1);
        world.entities.set('ship', makeShip(0, 100, [100, 0, 0, 0]));
        world.entities.set('decoy', new Entity('decoy')
            .addComponent(DecoyTargetComponent, { weight: 1 })
            .addComponent(MovementStateComponent, movement(0, 50)));
        world.entities.set('missile',
            makeMissile('ship', [100, 0, 0, 0], { decoyedByAsteroids: true }));

        let retargeted = false;
        for (let i = 0; i < 50 && !retargeted; i++) {
            world.step();
            const target = world.entities.get('missile')!
                .components.get(TargetComponent)!.target;
            if (target === 'decoy') {
                retargeted = true;
            }
        }
        expect(retargeted).toBeTrue();
    });

    it('retargets a jammed attackParentIfJammed missile onto its parent', () => {
        const world = makeJammingWorld(1);
        world.entities.set('parent', makeShip(0, 200, [0, 0, 0, 0]));
        world.entities.set('ship', makeShip(0, 100, [100, 0, 0, 0]));
        const missile = makeMissile('ship', [100, 0, 0, 0],
            { attackParentIfJammed: true });
        missile.components.set(SourceComponent, 'parent');
        world.entities.set('missile', missile);

        let attackedParent = false;
        for (let i = 0; i < 50 && !attackedParent; i++) {
            world.step();
            if (world.entities.get('missile')!
                .components.get(TargetComponent)!.target === 'parent') {
                attackedParent = true;
            }
        }
        expect(attackedParent).toBeTrue();
    });

    it('adds system interference to jam a radar missile that a jam-free ship would not', () => {
        // Ship has no jamming at all; only system interference jams the missile,
        // and only because the missile is confusedByInterference + radar-vuln.
        const world = makeJammingWorld(1, /* interference */ 100);
        world.entities.set('ship', makeShip(0, 100, [0, 0, 0, 0]));
        world.entities.set('missile',
            makeMissile('ship', [0, 100, 0, 0], { confusedByInterference: true }));

        let jammed = false;
        for (let i = 0; i < 50 && !jammed; i++) {
            world.step();
            if (world.entities.get('missile')!
                .components.get(JamSteerComponent) !== undefined) {
                jammed = true;
            }
        }
        expect(jammed).toBeTrue();
    });

    it('does NOT let system interference jam a radar missile without the confused flag', () => {
        const world = makeJammingWorld(1, /* interference */ 100);
        world.entities.set('ship', makeShip(0, 100, [0, 0, 0, 0]));
        world.entities.set('missile',
            makeMissile('ship', [0, 100, 0, 0], { confusedByInterference: false }));

        for (let i = 0; i < 200; i++) {
            world.step();
        }
        expect(world.entities.get('missile')!
            .components.get(JamSteerComponent)).toBeUndefined();
    });
});
