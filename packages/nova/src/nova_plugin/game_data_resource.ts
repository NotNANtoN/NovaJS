import { GameDataInterface } from "novadatainterface/game_data_interface";
import { Resource } from "nova_ecs/resource";


export const GameDataResource = new Resource<GameDataInterface>('GameData');
