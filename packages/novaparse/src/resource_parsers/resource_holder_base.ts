import { BaseResource } from "./nova_resource_base.js";
import { BoomResource } from "./boom_resource.js";
import { CharResource } from "./char_resource.js";
import { ColrResource } from "./colr_resource.js";
import { CronResource } from "./cron_resource.js";
import { DescResource } from "./desc_resource.js";
import { DudeResource } from "./dude_resource.js";
import { FletResource } from "./flet_resource.js";
import { GovtResource } from "./govt_resource.js";
import { IntfResource } from "./intf_resource.js";
import { JunkResource } from "./junk_resource.js";
import { MisnResource } from "./misn_resource.js";
import { NebuResource } from "./nebu_resource.js";
import { OopsResource } from "./oops_resource.js";
import { OutfResource } from "./outf_resource.js";
import { PersResource } from "./pers_resource.js";
import { PictResource } from "./pict_resource.js";
import { PpatResource } from "./ppat_resource.js";
import { RankResource } from "./rank_resource.js";
import { RledResource } from "./rled_resource.js";
import { RoidResource } from "./roid_resource.js";
import { ShanResource } from "./shan_resource.js";
import { ShipResource } from "./ship_resource.js";
import { SpinResource } from "./spin_resource.js";
import { SpobResource } from "./spob_resource.js";
import { StrResource } from "./str_resource.js";
import { StrNResource } from "./strn_resource.js";
import { SystResource } from "./syst_resource.js";
import { VersResource } from "./vers_resource.js";
import { WeapResource } from "./weap_resource.js";



enum NovaResourceType {
    bööm = "bööm",
    chär = "chär",
    cicn = "cicn",
    cölr = "cölr",
    crön = "crön",
    dësc = "dësc",
    DITL = "DITL",
    DLOG = "DLOG",
    düde = "düde",
    flët = "flët",
    gövt = "gövt",
    ïntf = "ïntf",
    jünk = "jünk",
    mïsn = "mïsn",
    nëbu = "nëbu",
    öops = "öops",
    oütf = "oütf",
    përs = "përs",
    PICT = "PICT",
    ppat = "ppat",
    ränk = "ränk",
    rlë8 = "rlë8",
    rlëD = "rlëD",
    röid = "röid",
    shän = "shän",
    shïp = "shïp",
    snd = "snd ",
    spïn = "spïn",
    spöb = "spöb",
    STR = "STR ",
    STRH = "STR#",
    sÿst = "sÿst",
    vers = "vers",
    wëap = "wëap"
}

type ResList<T> = {
    [index: string]: T
}

// type NovaResources = {
//     [index: string]: { // ResourceType
//         [index: string]: BaseResource  // ID (local or global depending on prefix)

//     }
// };


// Types without dedicated parsers: cicn, DITL, DLOG (classic Mac UI
// resources) and rlë8 (8-bit sprites; unused by the game).
type NovaResources = {
    [index: string]: ResList<BaseResource>;
    bööm: ResList<BoomResource>;
    chär: ResList<CharResource>;
    cicn: ResList<BaseResource>;
    cölr: ResList<ColrResource>;
    crön: ResList<CronResource>;
    dësc: ResList<DescResource>;
    DITL: ResList<BaseResource>;
    DLOG: ResList<BaseResource>;
    düde: ResList<DudeResource>;
    flët: ResList<FletResource>;
    gövt: ResList<GovtResource>;
    ïntf: ResList<IntfResource>;
    jünk: ResList<JunkResource>;
    mïsn: ResList<MisnResource>;
    nëbu: ResList<NebuResource>;
    öops: ResList<OopsResource>;
    oütf: ResList<OutfResource>;
    përs: ResList<PersResource>;
    PICT: ResList<PictResource>;
    ppat: ResList<PpatResource>;
    ränk: ResList<RankResource>;
    rlë8: ResList<BaseResource>;
    rlëD: ResList<RledResource>;
    röid: ResList<RoidResource>;
    shän: ResList<ShanResource>;
    shïp: ResList<ShipResource>;
    "snd ": ResList<BaseResource>;
    spïn: ResList<SpinResource>;
    spöb: ResList<SpobResource>;
    "STR ": ResList<StrResource>;
    "STR#": ResList<StrNResource>;
    sÿst: ResList<SystResource>;
    vers: ResList<VersResource>;
    wëap: ResList<WeapResource>;
}
function getEmptyNovaResources(): NovaResources {
    return {
        bööm: {},
        chär: {},
        cicn: {},
        cölr: {},
        crön: {},
        dësc: {},
        DITL: {},
        DLOG: {},
        düde: {},
        flët: {},
        gövt: {},
        ïntf: {},
        jünk: {},
        mïsn: {},
        nëbu: {},
        öops: {},
        oütf: {},
        përs: {},
        PICT: {},
        ppat: {},
        ränk: {},
        rlë8: {},
        rlëD: {},
        röid: {},
        shän: {},
        shïp: {},
        "snd ": {},
        spïn: {},
        spöb: {},
        "STR ": {},
        "STR#": {},
        sÿst: {},
        vers: {},
        wëap: {}
    };
}





export { NovaResources, NovaResourceType, getEmptyNovaResources, ResList }
