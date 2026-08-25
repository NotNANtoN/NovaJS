import { BaseData } from 'novadatainterface/BaseData';
import { DudeData } from 'novadatainterface/DudeData';
import { BaseParse } from './BaseParse';
import { DudeResource } from '../resource_parsers/DudeResource';

export async function DudeParse(
    dude: DudeResource,
    _notFoundFunction: (message: string) => void,
): Promise<DudeData> {
    const base: BaseData = await BaseParse(dude, _notFoundFunction);
    const ships = dude.shipTypes
        .map((shipType, index) => ({
            id: dude.idSpace.shïp[shipType]?.globalID ?? '',
            weight: dude.probabilities[index] ?? 0,
        }))
        .filter(ship => ship.id && ship.weight > 0);
    return {
        ...base,
        aiType: dude.aiType,
        government: dude.government,
        flags: dude.flags,
        infoTypes: dude.infoTypes,
        ships,
    };
}
