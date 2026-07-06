import { Resource } from 'nova_ecs/resource';

/**
 * Deterministic entity id allocation for entities spawned by the
 * simulation (projectiles, beams, blasts, bay ships). Replaces random
 * v4 uuids so identical runs produce identical ids. The counter is
 * simulation state: include it in rollback snapshots.
 */
export class IdFactory {
    private count = 0;

    constructor(private readonly instance: string = '') { }

    next(kind = 'entity'): string {
        const instance = this.instance ? `${this.instance}:` : '';
        return `${instance}${kind}:${this.count++}`;
    }
}

export const IdFactoryResource = new Resource<IdFactory>('IdFactory');
