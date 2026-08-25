import { NovaParse } from '../novaparse/NovaParse';
import {
    advanceMissionGoal,
    newMissionGoal,
} from '../nova/src/nova_plugin/mission_goals';
import { formatMissionText } from '../nova/src/nova_plugin/mission_text';
import { resolveSystemSelector } from '../nova/src/nova_plugin/stellar_selector';

const dataPath = process.env.NOVA_DATA_PATH
    ?? `${process.cwd()}/nova/Nova_Data`;

async function main() {
    const gameData = new NovaParse(dataPath, false);
    const ids = await gameData.ids;
    const missionIds = (ids.Mission ?? [])
        .filter(id => /^nova:\d+$/.test(id));
    const systems = await Promise.all((ids.System ?? []).map(id =>
        gameData.data.System.get(id)));
    const missions = (await Promise.all(missionIds.map(id =>
        gameData.data.Mission.get(id)))).filter(mission =>
            mission.shipCount > 0 && mission.shipGoal === 0);
    const combatMissions = missions.slice(0, 2);

    console.log(`retail combat missions: ${missions.length}`);
    for (const mission of combatMissions) {
        let progress = newMissionGoal(mission.shipGoal, mission.shipCount);
        for (let i = 0; i < mission.shipCount; i++) {
            progress = advanceMissionGoal(progress, 'destroyed');
        }
        const dude = await gameData.data.Dude?.get(
            `nova:${mission.shipDude}`);
        const shipSystem = resolveSystemSelector(mission.shipSyst, {
            systems,
            initialSystemId: 'nova:130',
            currentSystemId: 'nova:130',
        }).selected;
        console.log(JSON.stringify({
            id: mission.id,
            dude: `nova:${mission.shipDude}`,
            dudeShips: dude?.ships,
            count: mission.shipCount,
            system: shipSystem ?? `nova:${mission.shipSyst}`,
            behavior: mission.shipBehav,
            goal: mission.shipGoal,
            simulatedGoalComplete: progress.completed,
        }));
    }

    const withWildcard = missions.find(mission =>
        /<(?:DSY|DST|RSY|RST|CT|CQ|DL|PAY|REG|PN|PNN|PSN|PST|PRK|SRK)>|{\s*!?[GBP]\b/i
            .test(mission.briefText));
    if (withWildcard) {
        console.log('briefText before:', withWildcard.briefText);
        console.log('briefText after:', formatMissionText(
            withWildcard.briefText,
            {
                destination: 'Luna',
                returnDestination: 'Earth',
                destinationSystem: 'Sol',
                pilotName: 'Captain',
                shipName: 'NovaJS',
                shipType: 'Shuttle',
                specialShipName: 'Target',
                missionBits: new Set(),
            },
        ));
    } else {
        console.log('briefText wildcard sample: none found');
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
