import { RankData } from "novadatainterface/RankData";
import { RankParse } from "./src/parsers/RankParse";
import { RankResource } from "./src/resource_parsers/RankResource";
import { OopsData } from "novadatainterface/OopsData";
import { OopsParse } from "./src/parsers/OopsParse";
import { OopsResource } from "./src/resource_parsers/OopsResource";
import { CronData } from "novadatainterface/CronData";
import { CronParse } from "./src/parsers/CronParse";
import { CronResource } from "./src/resource_parsers/CronResource";
import * as path from "path";
import { ExplosionData } from "novadatainterface/ExplosionData";
import { DudeData } from "novadatainterface/DudeData";
import { GovtData } from "novadatainterface/GovtData";
import { GameDataInterface } from "novadatainterface/GameDataInterface";
import { Gettable } from "novadatainterface/Gettable";
import { NovaDataInterfaceWithMission, NovaIDNotFoundError } from "novadatainterface/NovaDataInterface";
import { getDefaultNovaIDs, NovaIDs } from "novadatainterface/NovaIDs";
import { OutfitData } from "novadatainterface/OutfitData";
import { PictData } from "novadatainterface/PictData";
import { PictImageData } from "novadatainterface/PictImage";
import { PlanetData } from "novadatainterface/PlanetData";
import { MissionData } from "novadatainterface/MissionData";
import { ShipData } from "novadatainterface/ShipData";
import { SpriteSheetData, SpriteSheetFramesData, SpriteSheetImageData } from "novadatainterface/SpriteSheetData";
import { StatusBarData } from "novadatainterface/StatusBarData";
import { AsteroidData } from "novadatainterface/AsteroidData";
import { NebulaData } from "novadatainterface/NebulaData";
import { StringListData } from "novadatainterface/StringListData";
import { SystemData } from "novadatainterface/SystemData";
import { TargetCornersData } from "novadatainterface/TargetCornersData";
import { WeaponData } from "novadatainterface/WeaponData";
import { GovtParse } from "./src/parsers/GovtParse";
import { DudeParse } from "./src/parsers/DudeParse";
import { IDSpaceHandler } from "./src/IDSpaceHandler";
import { ExplosionParse } from "./src/parsers/ExplosionParse";
import { OutfitParse } from "./src/parsers/OutfitParse";
import { PictImageMulti, PictImageMultiParse } from "./src/parsers/PictParse";
import { PlanetParse } from "./src/parsers/PlanetParse";
import { resourceIDNotFoundStrict, resourceIDNotFoundWarn } from "./src/parsers/ResourceIDNotFound";
import { ShipParseClosure, ShipPictMap, WeaponOutfitMap } from "./src/parsers/ShipParse";
import { SpriteSheetMulti, SpriteSheetMultiParse } from "./src/parsers/SpriteSheetMultiParse";
import { StatusBarParse } from "./src/parsers/StatusBarParse";
import { AsteroidParse } from "./src/parsers/AsteroidParse";
import { NebulaParse } from "./src/parsers/NebulaParse";
import { StringListParse } from "./src/parsers/StringListParse";
import { NebuResource } from "./src/resource_parsers/NebuResource";
import { StrhResource } from "./src/resource_parsers/StrhResource";
import { RoidResource } from "./src/resource_parsers/RoidResource";
import { SystemParse } from "./src/parsers/SystemParse";
import { MissionParse } from "./src/parsers/MissionParse";
import { TargetCornersParse } from "./src/parsers/TargetCornersParse";
import { WeaponParse } from "./src/parsers/WeaponParse";
import { BoomResource } from "./src/resource_parsers/BoomResource";
import { DudeResource } from "./src/resource_parsers/DudeResource";
import { MisnResource } from "./src/resource_parsers/MisnResource";
import { GovtResource } from "./src/resource_parsers/GovtResource";
import { BaseResource } from "./src/resource_parsers/NovaResourceBase";
import { OutfResource } from "./src/resource_parsers/OutfResource";
import { PictResource } from "./src/resource_parsers/PictResource";
import { NovaResources, NovaResourceType, ResList } from "./src/resource_parsers/ResourceHolderBase";
import { RledResource } from "./src/resource_parsers/RledResource";
import { ShipResource } from "./src/resource_parsers/ShipResource";
import { SpobResource } from "./src/resource_parsers/SpobResource";
import { SystResource } from "./src/resource_parsers/SystResource";
import { WeapResource } from "./src/resource_parsers/WeapResource";
import { Defaults } from "novadatainterface/Defaults";
import { SoundFileParse } from "./src/parsers/SoundFileParse";
import { SndResource } from "./src/resource_parsers/SndResource";
import { SoundFile } from "novadatainterface/SoundFile";
import { JunkData } from "novadatainterface/JunkData";
import { JunkParse } from "./src/parsers/JunkParse";
import { JunkResource } from "./src/resource_parsers/JunkResource";
import { PersData } from "novadatainterface/PersData";
import { PersParse } from "./src/parsers/PersParse";
import { PersResource } from "./src/resource_parsers/PersResource";


type ParseFunction<T extends BaseResource, O> = (resource: T, errorFunc: (message: string) => void) => Promise<O>;

export class NovaParse implements GameDataInterface {
    private pictImageGettable: Gettable<PictImageData>;
    private pictGettable: Gettable<PictData>;
    private pictMultiGettable: Gettable<PictImageMulti>;
    private spriteSheetDataGettable: Gettable<SpriteSheetData>;
    private spriteSheetFramesGettable: Gettable<SpriteSheetFramesData>;
    private spriteSheetImageGettable: Gettable<SpriteSheetImageData>;
    private spriteSheetMultiGettable: Gettable<SpriteSheetMulti>;

    private shipParser: (s: ShipResource, m: (message: string) => void) => Promise<ShipData>;

    private shipPICTMap: ShipPictMap;
    private targetPICTMap: ShipPictMap;
    private weaponOutfitMap: WeaponOutfitMap;
    resourceNotFoundFunction: (message: string) => void;
    public data: NovaDataInterfaceWithMission;
    path: string
    private idSpaceHandler: IDSpaceHandler;

    public readonly ids: Promise<NovaIDs>;
    public readonly idSpace: Promise<NovaResources | Error>;

    constructor(dataPath: string, strict: boolean = true,
        subPaths:
            { novaFiles: string, novaPlugins: string } =
            { novaFiles: "Nova\ Files", novaPlugins: "Plug-ins" }) {

        // Strict will throw an error if any resource is not found.
        // Otherwise, it will try to substitute default resources whenever possible (success may vary).
        if (strict) {
            this.resourceNotFoundFunction = resourceIDNotFoundStrict;
        }
        else {
            this.resourceNotFoundFunction = resourceIDNotFoundWarn;
        }

        this.path = path.join(dataPath);
        this.idSpaceHandler = new IDSpaceHandler(dataPath, subPaths);
        this.idSpace = this.idSpaceHandler.getIDSpace().catch((e: Error) => {
            // Suppress all promise rejections. These are instead thrown when specific resources are requested
            //console.log("Got an error");
            return e;
        });


        this.idSpace.catch((_e: Error) => { });

        this.shipPICTMap = this.makeShipPictMap();
        this.targetPICTMap = this.makeShipPictMap(
            ship => ship.targetPictID, false, null);
        this.weaponOutfitMap = this.makeWeaponOutfitMap();
        this.shipParser = ShipParseClosure(
            this.shipPICTMap, this.targetPICTMap,
            this.weaponOutfitMap, this.idSpace);


        // Holds spriteSheetMulti which gets split up
        this.spriteSheetMultiGettable = this.makeGettable<RledResource, SpriteSheetMulti>(NovaResourceType.rlëD, SpriteSheetMultiParse);
        // Since everything about a spriteSheet is parsed at once, it needs to be split up here
        this.spriteSheetDataGettable = new Gettable(this.getSpriteSheetData.bind(this));
        this.spriteSheetImageGettable = new Gettable(this.getSpriteSheetImage.bind(this));
        this.spriteSheetFramesGettable = new Gettable(this.getSpriteSheetFrames.bind(this));



        // Similar for pict
        this.pictMultiGettable = this.makeGettable<PictResource, PictImageMulti>(NovaResourceType.PICT, PictImageMultiParse);
        this.pictGettable = new Gettable(this.getPictData.bind(this));
        this.pictImageGettable = new Gettable(this.getPictImage.bind(this));


        this.ids = this.buildIDs();
        this.data = this.buildData();

    }

    private buildIDsForResource(resourceList: ResList<BaseResource>): Array<string> {

        return Object.keys(resourceList);
    }

    private async buildIDs(): Promise<NovaIDs> {
        var idSpace = await this.idSpace;
        if (idSpace instanceof Error) {
            return getDefaultNovaIDs();
        }

        return {
            Ship: this.buildIDsForResource(idSpace.shïp),
            Outfit: this.buildIDsForResource(idSpace.oütf),
            Weapon: this.buildIDsForResource(idSpace.wëap),
            Pict: this.buildIDsForResource(idSpace.PICT),
            PictImage: this.buildIDsForResource(idSpace.PICT),
            Cicn: this.buildIDsForResource(idSpace.cicn),
            CicnImage: this.buildIDsForResource(idSpace.cicn),
            Dude: this.buildIDsForResource(idSpace.düde),
            Planet: this.buildIDsForResource(idSpace.spöb),
            System: this.buildIDsForResource(idSpace.sÿst),
            Mission: this.buildIDsForResource(idSpace.mïsn),
            TargetCorners: [], // TODO: parse these
            SpriteSheet: this.buildIDsForResource(idSpace.rlëD),
            SpriteSheetImage: this.buildIDsForResource(idSpace.rlëD),
            SpriteSheetFrames: this.buildIDsForResource(idSpace.rlëD),
            StatusBar: this.buildIDsForResource(idSpace.ïntf),
            Explosion: this.buildIDsForResource(idSpace.bööm),
            Govt: this.buildIDsForResource(idSpace.gövt),
            Asteroid: this.buildIDsForResource(idSpace.röid),
            Nebula: this.buildIDsForResource(idSpace.nëbu),
            StringList: this.buildIDsForResource(idSpace.STRH),
            Junk: this.buildIDsForResource(idSpace.jünk),
            Pers: this.buildIDsForResource(idSpace.përs),
            Cron: this.buildIDsForResource(idSpace.crön),
            Rank: this.buildIDsForResource(idSpace.ränk),
            Oops: this.buildIDsForResource(idSpace.öops),
            SoundFile: this.buildIDsForResource(idSpace["snd "]),
        }
    }

    // Assigns all the gettables to this.data
    private buildData(): NovaDataInterfaceWithMission {
        // This should really use NovaDataType.Ship etc but that isn't allowed when constructing like this.
        var data: NovaDataInterfaceWithMission = {
            Ship: this.makeGettable<ShipResource, ShipData>(NovaResourceType.shïp, this.shipParser),
            Outfit: this.makeGettable<OutfResource, OutfitData>(NovaResourceType.oütf, OutfitParse),
            Weapon: this.makeGettable<WeapResource, WeaponData>(NovaResourceType.wëap, WeaponParse),
            Pict: this.pictGettable,
            PictImage: this.pictImageGettable,
            Cicn: new Gettable(async () => Defaults.Cicn), // TODO
            CicnImage: new Gettable(async () => Defaults.CicnImage), // TODO
            Dude: this.makeGettable<DudeResource, DudeData>(
                NovaResourceType.düde, DudeParse),
            Planet: this.makeGettable<SpobResource, PlanetData>(NovaResourceType.spöb, PlanetParse),
            System: this.makeGettable<SystResource, SystemData>(NovaResourceType.sÿst, SystemParse),
            Mission: this.makeGettable<MisnResource, MissionData>(NovaResourceType.mïsn, MissionParse),
            TargetCorners: this.makeGettable<BaseResource, TargetCornersData>(NovaResourceType.cicn, TargetCornersParse),
            SpriteSheet: this.spriteSheetDataGettable,
            SpriteSheetImage: this.spriteSheetImageGettable,
            SpriteSheetFrames: this.spriteSheetFramesGettable,
            StatusBar: this.makeGettable<BaseResource, StatusBarData>(NovaResourceType.ïntf, StatusBarParse),
            Explosion: this.makeGettable<BoomResource, ExplosionData>(NovaResourceType.bööm, ExplosionParse),
            Govt: this.makeGettable<GovtResource, GovtData>(NovaResourceType.gövt, GovtParse),
            Asteroid: this.makeGettable<RoidResource, AsteroidData>(
                NovaResourceType.röid, AsteroidParse),
            Nebula: this.makeGettable<NebuResource, NebulaData>(
                NovaResourceType.nëbu, NebulaParse),
            StringList: this.makeGettable<StrhResource, StringListData>(
                NovaResourceType.STRH, StringListParse),
            Junk: this.makeGettable<JunkResource, JunkData>(
                NovaResourceType.jünk, JunkParse),
            Pers: this.makeGettable<PersResource, PersData>(
                NovaResourceType.përs, PersParse),
            SoundFile: this.makeGettable<SndResource, SoundFile>(NovaResourceType.snd, SoundFileParse),
        }

        return data;
    }

    private makeGettable<T extends BaseResource, O>(resourceType: NovaResourceType, parseFunction: ParseFunction<T, O>): Gettable<O> {
        return new Gettable(async (id: string) => {
            var idSpace = await this.idSpace; // May be an error
            if (idSpace instanceof Error) {
                throw idSpace;
            }

            // `STR#` is stored under the key STRH because `#` is not a valid
            // identifier, so the enum value cannot index the id space.
            const idSpaceKey = resourceType === NovaResourceType.STRH
                ? "STRH" : resourceType;
            var resource = <T>idSpace[idSpaceKey][id];

            // Shouldn't this just call resourceNotFoundFunction???
            if (typeof resource === "undefined") {
                throw new NovaIDNotFoundError("NovaParse could not find " + resourceType + " of ID " + id + ".");
            }

            return await parseFunction(resource, this.resourceNotFoundFunction);
        });
    }

    /**
     * Ships whose corresponding PICT does not exist use the PICT of the
     * lowest-numbered ship with the same base rlëD image. This is shared by
     * the 5000-series shipyard art and the 3000-series targeting art.
     */
    private async makeShipPictMap(
        pictID = (ship: ShipResource) => ship.pictID,
        reportMissingShan = true,
        missingBaseFallback: string | null = "default",
    ): ShipPictMap {
        var idSpace = await this.idSpace;
        if (idSpace instanceof Error) {
            return {};
        }

        // Maps shïp ids to their baseImage ids
        var shipPICTMap: { [index: string]: string } = {};

        // maps baseImage ids to pict ids
        var baseImagePICTMap: { [index: string]: string } = {};

        const ships = Object.values(idSpace.shïp)
            .sort((left, right) => left.id - right.id
                || left.globalID.localeCompare(right.globalID));

        // Populate baseImagePICTMap in numeric order.
        for (const ship of ships) {
            var pict = ship.idSpace.PICT[pictID(ship)];

            if (!pict) {
                continue; // Ship has no corresponding pict, so don't set anything.
            }

            var shan = ship.idSpace.shän[ship.id];
            if (!shan) {
                if (reportMissingShan) {
                    this.resourceNotFoundFunction(
                        "shïp id " + ship.globalID + " missing shan");
                }
                continue; // If it's not found, there's no baseImage to map from
            }
            var baseImageLocalID = shan.images.baseImage.ID;
            var baseImageGlobalID = shan.idSpace.rlëD[baseImageLocalID]?.globalID;
            if (!baseImageGlobalID) {
                continue;
            }

            // Don't overwrite if it already exists. The first ship with the
            // baseImage determines the PICT
            if (!baseImagePICTMap[baseImageGlobalID]) {
                // The base image corresponds to this pict.
                baseImagePICTMap[baseImageGlobalID] = pict.globalID;
            }
        }

        // Populate shipPICTMap
        for (const ship of ships) {
            const shipGlobalID = ship.globalID;
            var pict = ship.idSpace.PICT[pictID(ship)];

            if (pict) {
                // Then there is a pict for this ship.
                // Set it in the map.
                shipPICTMap[shipGlobalID] = pict.globalID;
            }
            else {
                // No pict found for this ship, so look up the first
                // ship's baseImage in the baseImagePICTMap
                var shan = ship.idSpace.shän[ship.id];
                if (!shan) {
                    continue
                }
                var baseImageLocalID = shan.images.baseImage.ID;
                var baseImageGlobalID = shan.idSpace.rlëD[baseImageLocalID]?.globalID;
                if (baseImageGlobalID) {
                    const sharedPict = baseImagePICTMap[baseImageGlobalID];
                    if (sharedPict) {
                        shipPICTMap[shipGlobalID] = sharedPict;
                    }
                } else if (missingBaseFallback) {
                    shipPICTMap[shipGlobalID] = missingBaseFallback;
                }
            }
        }
        return shipPICTMap;
    }

    private async makeWeaponOutfitMap(): WeaponOutfitMap {
        var idSpace = await this.idSpace;
        if (idSpace instanceof Error) {
            return {};
        }

        // Maps a weapon to the first outfit that provides it.
        var weaponOutfitMap: { [index: string]: string } = {};

        for (let outfitID in idSpace.oütf) {

            var outfit = await this.data.Outfit.get(outfitID);
            for (let weaponID in outfit.weapons) {
                if (!(weaponOutfitMap[weaponID])) {
                    weaponOutfitMap[weaponID] = outfitID;
                }
            }
        }
        return weaponOutfitMap;
    }

    private async getSpriteSheetData(id: string): Promise<SpriteSheetData> {
        var multi: SpriteSheetMulti = await this.spriteSheetMultiGettable.get(id);
        return multi.spriteSheet
    }
    private async getSpriteSheetImage(id: string): Promise<SpriteSheetImageData> {
        var multi: SpriteSheetMulti = await this.spriteSheetMultiGettable.get(id);
        return multi.spriteSheetImage;
    }
    private async getSpriteSheetFrames(id: string): Promise<SpriteSheetFramesData> {
        var multi: SpriteSheetMulti = await this.spriteSheetMultiGettable.get(id);
        return multi.spriteSheetFrames;
    }

    private async getPictData(id: string): Promise<PictData> {
        var multi: PictImageMulti = await this.pictMultiGettable.get(id);
        return multi.pict;
    }
    private async getPictImage(id: string): Promise<PictImageData> {
        var multi: PictImageMulti = await this.pictMultiGettable.get(id);
        return multi.image;
    }
}
