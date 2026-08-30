import { GovtData } from 'novadatainterface/GovtData';
import { PlanetData } from 'novadatainterface/PlanetData';
import { SystemData } from 'novadatainterface/SystemData';
import { STANDARD_COMMODITIES } from 'novadatainterface/CommodityData';
import { resourceId } from '../common/resource_id';
import {
    hasSpaceportService,
} from './availability';
import {
    isCriminal,
    LEGAL_STATUS_LADDER,
    legalStatus,
    recordFor,
} from '../nova_plugin/legal_record';
import { refuelsOnLanding } from '../nova_plugin/fuel';
import { formatGameDate } from '../nova_plugin/player_state';

const SERVICE_NAMES = [
    'Trading',
    'Outfitting',
    'Shipyard',
    'Bar',
    'Recharge',
] as const;

export interface StarmapPanelInput {
    system?: SystemData;
    currentSystemId: string;
    known: boolean;
    planets?: readonly PlanetData[];
    government?: GovtData;
    legalRecords?: Readonly<Record<string, number>>;
    gameDate?: number;
    transmissions?: readonly string[];
}

export interface StarmapPanelData {
    heading: 'Current System' | 'Selected System';
    systemName: string;
    government?: string;
    legalStatus?: string;
    goods: string[];
    services: string[];
    ports: string[];
    navigationHazards?: string;
    date?: string;
    transmissions?: string[];
}

/**
 * Retail's map only names the two useful asteroid-density bands. Keeping the
 * cutoffs here makes the UI wording independent from the Pixi renderer.
 */
export function navigationHazard(
    asteroidDensity: number,
): string | undefined {
    if (asteroidDensity >= 7) {
        return 'Dense asteroid field';
    }
    if (asteroidDensity > 0) {
        return 'Asteroid field';
    }
    return undefined;
}

function landablePlanets(
    planets: readonly PlanetData[],
): readonly PlanetData[] {
    return planets.filter(planet => planet.canLand === true);
}

export function starmapGoods(
    planets: readonly PlanetData[],
): string[] {
    const available = new Set(
        landablePlanets(planets).flatMap(planet =>
            (planet.tradeCommodities ?? []).map(item => item.commodity)),
    );
    return [
        ...STANDARD_COMMODITIES.filter(commodity => available.has(commodity)),
        ...[...available]
            .filter(commodity => !STANDARD_COMMODITIES.includes(commodity))
            .sort((a, b) => a.localeCompare(b)),
    ];
}

export function starmapServices(
    planets: readonly PlanetData[],
): string[] {
    const landable = landablePlanets(planets);
    const available = new Set<string>();
    if (landable.some(planet =>
        hasSpaceportService(planet, 'commodity'))) {
        available.add('Trading');
    }
    if (landable.some(planet =>
        hasSpaceportService(planet, 'outfitter'))) {
        available.add('Outfitting');
    }
    if (landable.some(planet =>
        hasSpaceportService(planet, 'shipyard'))) {
        available.add('Shipyard');
    }
    if (landable.some(planet =>
        hasSpaceportService(planet, 'bar'))) {
        available.add('Bar');
    }
    if (landable.some(planet => refuelsOnLanding(planet))) {
        available.add('Recharge');
    }
    return SERVICE_NAMES.filter(service => available.has(service));
}

export function starmapPorts(
    planets: readonly PlanetData[],
): string[] {
    return landablePlanets(planets).map(planet => planet.name);
}

function governmentId(system: SystemData): string | undefined {
    if (system.government === undefined || system.government < 0) {
        return undefined;
    }
    return resourceId(system.government);
}

function legalStatusFor(
    input: StarmapPanelInput,
    govt: GovtData,
): string {
    const id = governmentId(input.system!);
    const record = input.legalRecords?.[govt.id] !== undefined
        ? input.legalRecords[govt.id]!
        : recordFor(input.legalRecords, id ?? govt.id, govt);
    const status = legalStatus(
        record,
        govt.crimeTolerance ?? 0,
        LEGAL_STATUS_LADDER,
    );
    return isCriminal(record, govt.crimeTolerance ?? 0)
        ? `${status} (hunted)`
        : status;
}

export function starmapPanelData(
    input: StarmapPanelInput,
): StarmapPanelData {
    const heading = input.system?.id === input.currentSystemId
        ? 'Current System'
        : 'Selected System';
    const date = input.gameDate === undefined
        ? undefined
        : formatGameDate(input.gameDate);
    if (!input.known || !input.system) {
        return {
            heading,
            systemName: '',
            goods: [],
            services: [],
            ports: [],
            date,
        };
    }

    const planets = input.planets ?? [];
    const govt = input.system.government !== undefined
        && input.system.government >= 0
        ? input.government
        : undefined;
    return {
        heading,
        systemName: input.system.name,
        government: govt?.name ?? 'Independent',
        legalStatus: govt ? legalStatusFor(input, govt) : undefined,
        goods: starmapGoods(planets),
        services: starmapServices(planets),
        ports: starmapPorts(planets),
        navigationHazards: navigationHazard(input.system.asteroidDensity),
        date,
        transmissions: input.transmissions ? [...input.transmissions] : undefined,
    };
}

/**
 * Keep the bottom strip readable without cutting a stellar name in half.
 * The renderer still masks the text as a final guard against unusual artwork.
 */
export function formatStarmapPorts(
    ports: readonly string[],
    maxLength = 56,
): string {
    if (ports.length === 0) {
        return 'None';
    }
    let result = '';
    for (const port of ports) {
        const next = result ? `${result}, ${port}` : port;
        if (next.length > maxLength) {
            return result ? `${result}, …` : '…';
        }
        result = next;
    }
    return result;
}

export function starmapPanelText(
    panel: StarmapPanelData,
): { heading: string; body: string; bottom: string; date: string } {
    if (!panel.systemName) {
        return {
            heading: `${panel.heading}:`,
            body: '',
            bottom: '',
            date: panel.date ?? '',
        };
    }
    const body = [
        panel.systemName,
        '',
        'Government:',
        panel.government ?? 'Independent',
        ...(panel.legalStatus
            ? ['', 'Legal Status:', panel.legalStatus]
            : []),
        ...(panel.transmissions && panel.transmissions.length > 0
            ? ['', 'Active Transmissions:', ...panel.transmissions]
            : []),
        '',
        'Goods Traded:',
        ...(panel.goods.length > 0 ? panel.goods : ['None']),
        '',
        'Services:',
        ...(panel.services.length > 0 ? panel.services : ['None']),
    ].join('\n');
    const bottomLines = [`Ports: ${formatStarmapPorts(panel.ports)}`];
    if (panel.navigationHazards) {
        bottomLines.push(`Navigation Hazards: ${panel.navigationHazards}`);
    }
    return {
        heading: `${panel.heading}:`,
        body,
        bottom: bottomLines.join('\n'),
        date: panel.date ?? '',
    };
}
