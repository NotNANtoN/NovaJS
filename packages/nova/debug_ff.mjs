import { Angle } from 'nova_ecs/datatypes/angle';
import { Position } from 'nova_ecs/datatypes/position';
import { Vector } from 'nova_ecs/datatypes/vector';
import { MovementStateComponent } from 'nova_ecs/plugins/movement_plugin';
import { MultiplayerData } from 'nova_ecs/plugins/multiplayer_plugin';
import { getIntegrationGameData } from './dist/src/communication/simulation_test_fixture.js';
import { completeEntity, loadShipGameData } from './dist/src/nova_plugin/entity_data_loader.js';
import { WeaponEntries } from './dist/src/nova_plugin/fire_weapon_plugin.js';
import { FiringGroupComponent } from './dist/src/nova_plugin/firing_group.js';
import { makeShip } from './dist/src/nova_plugin/make_ship.js';
import { makeSystem } from './dist/src/nova_plugin/make_system.js';
import { NpcComponent } from './dist/src/nova_plugin/npc_ai_plugin.js';
import { DamagedEvent } from './dist/src/nova_plugin/death_plugin.js';
import { System } from 'nova_ecs/system';
import { UUID } from 'nova_ecs/arg_types';

const gameData = await getIntegrationGameData();
const world = await makeSystem('nova:226', gameData, undefined, { npcs: false });
const damaged = [];
world.addSystem(new System({
    name: 'DamageRecorder', events: [DamagedEvent],
    args: [DamagedEvent, UUID], step: ({damager}, uuid) => { damaged.push({uuid, damager}); console.log('DAMAGED', uuid, 'by', damager); },
}));

const shipData = await gameData.data.Ship.get('nova:128');
async function addShip(uuid, x, y) {
    const ship = makeShip(shipData);
    ship.components.set(MultiplayerData, { owner: 'server' });
    await completeEntity(world, ship);
    ship.components.set(MovementStateComponent, {
        position: new Position(x, y), velocity: new Vector(0, 0),
        rotation: new Angle(0), accelerating: 0, turning: 0, turnBack: false,
    });
    world.entities.set(uuid, ship);
    return ship;
}

const weaponIds = await loadShipGameData(gameData, 'nova:128');
let gunId;
for (const id of [...weaponIds].sort()) {
    const w = await gameData.data.Weapon.get(id);
    if (w.type === 'ProjectileWeaponData' && w.guidance === 'unguided') { gunId = id; console.log('gun accuracy', w.accuracy); break; }
}
const gun = await world.resources.get(WeaponEntries).get(gunId);

const leader = await addShip('leader', 1000, 1000);
leader.components.set(FiringGroupComponent, { group: 'leader' });
leader.components.set(NpcComponent, { aiType: 2 });
const escort = await addShip('escort', 1000, 1080);
escort.components.set(FiringGroupComponent, { group: 'leader' });
for (let i = 0; i < 20; i++) world.step();

const friendly = gun.fireFromEntity('escort');
console.log('friendly shot?', !!friendly, JSON.stringify(friendly?.components.get(FiringGroupComponent)));
for (let i = 0; i < 90; i++) world.step();
console.log('after friendly phase, damaged:', JSON.stringify(damaged));
console.log('leader aggressor:', leader.components.get(NpcComponent)?.aggressor);
console.log('leader pos now:', JSON.stringify(leader.components.get(MovementStateComponent)?.position));
console.log('escort pos now:', JSON.stringify(escort.components.get(MovementStateComponent)?.position));

const outsider = await addShip('outsider', 1000, 1080);
for (let i = 0; i < 20; i++) world.step();
console.log('leader pos at outsider fire:', JSON.stringify(leader.components.get(MovementStateComponent)?.position));
const hostile = gun.fireFromEntity('outsider');
console.log('hostile shot?', !!hostile);
for (let i = 0; i < 20; i++) {
    world.step();
    const m = hostile.components.get(MovementStateComponent);
    console.log('tick', i, m?.position.x.toFixed(1), m?.position.y.toFixed(1));
}
console.log('damaged:', JSON.stringify(damaged));
process.exit(0);
