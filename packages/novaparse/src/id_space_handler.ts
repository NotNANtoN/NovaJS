import * as fs from "fs";
import * as path from "path";
import { readNovaFile } from "./read_nova_file.js";
import { NovaResources, NovaResourceType, getEmptyNovaResources } from "./resource_parsers/resource_holder_base.js";

class BadDirectoryStructureError extends Error { };

//const log = console.log;
const log = (_m: string) => { };

// Parses Nova Files and Plug-ins into resources
// without dealing with the interactions that resources might
// have with one another. A resource that references another resource
// will not use a globalID to do so. Also, ships, which, if they don't have
// a PICT available, will instead use the pict of the last ship to
// have the same baseImage, are not linked to the correct PICT at this stage.
// All interactions are handled by NovaParse.ts
class IDSpaceHandler {
    private globalResources: Promise<NovaResources | Error>;
    private tmpBuildingResources: NovaResources;
    private novaFilesPath: string;
    private novaPluginsPath: string;

    constructor(novaPath: string,
        { novaFiles, novaPlugins }:
            { novaFiles: string, novaPlugins: string } =
            { novaFiles: "Nova\ Files", novaPlugins: "Plug-ins" }) {

        this.novaFilesPath = path.join(novaPath, novaFiles);
        this.novaPluginsPath = path.join(novaPath, novaPlugins);
        this.tmpBuildingResources = getEmptyNovaResources();
        this.globalResources = this.build().catch((e: Error) => {
            // Catch all promise rejections. They are instead handled when getting ID spaces.
            return e;
        });
    }

    private async build() {
        await this.addNovaFilesDirectory(this.novaFilesPath);
        await this.addNovaPluginsDirectory(this.novaPluginsPath);
        return this.tmpBuildingResources;
    }

    // Returns the IDSpace of namespace 'prefix'
    public async getIDSpace(prefix: string | null = null): Promise<NovaResources> {
        var result = await this.globalResources; // May be an error
        if (result instanceof Error) {
            throw result;
        }
        return this.getIDSpaceUnsafe(prefix);
    }

    // Gets the ID Space without requiring that everything be parsed
    // An ID space is a NovaResource that is constrained to a specific namespace, such as "plugin 1."
    // When it's asked for resources, it prepends all IDs given to it with
    // either "plugin 1:" or "nova:" depending on whether or not the ID already exists in the "nova"
    // namespace. It is used by nova resource parsers to reference other nova resources because those
    // references must occur in the correct namespace.
    private getIDSpaceUnsafe(prefix: string | null = null): NovaResources {
        var globalResources = this.tmpBuildingResources;

        if (prefix == null) {
            return globalResources;
        }

        return new Proxy(globalResources, {
            get: (target, resourceType) => {
                if (typeof resourceType === "symbol") {
                    console.warn("accessing resources by symbol");
                    return Reflect.get(target, resourceType);
                }

                var idList = Reflect.get(target, resourceType);
                if (!idList) {
                    Reflect.set(target, resourceType, {});
                    var idList = Reflect.get(target, resourceType);
                }

                return new Proxy(idList, {

                    // Replace requests for 324 with prefix:324
                    // or nova:324 if nova:324 exists
                    get: (target, localID) => {
                        if (typeof localID === "symbol") {
                            console.warn("accessing ids by symbol");
                            return Reflect.get(target, localID);
                        }
                        var novaScopeValue = Reflect.get(target, "nova:" + localID);
                        if (novaScopeValue) {
                            return novaScopeValue;
                        }
                        else {
                            var globalID = prefix + ":" + localID;
                            return Reflect.get(target, globalID);
                        }
                    },

                    // Replace setting 324 with setting prefix:324
                    // or nova:324 if nova:324 exists
                    set: (target, localID, value) => {
                        if (typeof localID === "symbol") {
                            throw new Error("Can't set by symbol");
                        }

                        // Assume it exists in the nova prefix
                        var usedPrefix = "nova";
                        var globalID = usedPrefix + ":" + localID;
                        if (!Reflect.get(target, globalID)) {
                            // It doesn't, so use its own prefix.
                            usedPrefix = prefix;
                            globalID = usedPrefix + ":" + localID;
                        }

                        // Setting the globalID here is necessary because
                        // this is the only place where it is known whether the prefix
                        // is "nova" or prefix. It's not the best practice...
                        value.globalID = globalID;
                        value.prefix = usedPrefix;


                        return Reflect.set(target, globalID, value);
                    }
                });
            }
        });
    }

    // Adds the Nova Plug-ins directory.
    //
    // Failure policy: a single broken third-party plug-in must NOT brick the
    // whole game. Each plug-in is parsed in isolation; if one fails to read or
    // parse (e.g. a missing/stripped resource fork throwing ENOENT), we log a
    // prominent error naming the exact file and the underlying exception, then
    // skip it and continue with the rest. Contrast with the core "Nova Files"
    // data, where any failure is fatal (see addNovaFilesDirectory).
    async addNovaPluginsDirectory(pluginsPath: string) {
        if (!(await isDirectory(pluginsPath))) {
            throw new BadDirectoryStructureError("Plug-ins must be a directory. Got " + pluginsPath + " instead");
        }

        if (!(path.basename(pluginsPath) == "Plug-ins")) {
            console.warn("Plug-ins parser given a directory called " + path.basename(pluginsPath) + " instead of Plug-ins");
        }

        var fileNames = (await readdir(pluginsPath)).reverse();
        for (let i in fileNames) {
            var name = fileNames[i];
            var currentPath = path.join(pluginsPath, name);
            var prefix = name.split(".")[0]; // Cut off extensions


            if (await isDirectory(currentPath)) {
                log(currentPath + " is a directory");
                await this.addDirectory(currentPath, prefix, /* fatalOnError */ false);
            }
            else {
                await this.addPluginSafe(currentPath, prefix);
            }
        }
    }

    // Adds the Nova Files directory.
    //
    // Failure policy: the core data is required for anything to work, so any
    // failure here propagates (is fatal) rather than being swallowed.
    async addNovaFilesDirectory(filePath: string) {
        if (!(await isDirectory(filePath))) {
            throw new BadDirectoryStructureError("Nova Files must be a directory. Got " + filePath + " instead");
        }

        await this.addDirectory(filePath, "nova", /* fatalOnError */ true);
    }

    // Adds a directory under a single ID prefix.
    // When fatalOnError is false (plug-in directories), a failure to read/parse
    // an individual file is logged and skipped rather than aborting everything.
    async addDirectory(dirPath: string, prefix: string, fatalOnError: boolean) {
        if (!(await isDirectory(dirPath))) {
            throw new BadDirectoryStructureError("Must be a directory. Got " + dirPath + " instead");
        }

        log("Adding Directory of plugins " + dirPath);

        var fileNames = await readdir(dirPath);
        for (let i in fileNames) {
            var name = fileNames[i];
            var currentPath = path.join(dirPath, name);
            if (fatalOnError) {
                await this.addPlugin(currentPath, prefix);
            } else {
                await this.addPluginSafe(currentPath, prefix);
            }
        }
    }

    // Wraps addPlugin so that a single unreadable/corrupt plug-in doesn't take
    // down the entire id space. Loudly logs the offending file and the
    // underlying error, then continues.
    async addPluginSafe(filePath: string, prefix: string): Promise<boolean> {
        try {
            return await this.addPlugin(filePath, prefix);
        } catch (e) {
            console.error(
                "\n" +
                "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n" +
                "NovaParse: FAILED to load plug-in file and SKIPPED it:\n" +
                "    " + filePath + "\n" +
                "Underlying error: " + errorDetail(e) + "\n" +
                "This plug-in's resources will be missing from the game. If it is a\n" +
                "macOS resource-fork file, check that its resource fork survived any\n" +
                "copy/transfer (see the xattr gotcha noted in addPlugin).\n" +
                "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n",
                e,
            );
            return false;
        }
    }

    // Adds a Nova Plug-in
    async addPlugin(filePath: string, prefix: string) {
        // Can't await this.getIDSpace because that causes an infinite loop
        // (getIDSpace awaits this.globalResources which depends on this function)

        var disallowedExtensions = new Set([".mp3", ".mov"]);
        if (disallowedExtensions.has(path.extname(filePath))) {
            return false;
        }

        log("Parsing " + filePath + " under prefix " + prefix);

        // This is the correct ID space because even though a plugin named,
        // for example, "cats", might have a resource that overwrites a nova resource,
        // that resource should still have access to all the other stuff in "cats"
        const resourceCount = await readNovaFile(filePath, this.getIDSpaceUnsafe(prefix));

        // A .plug / .ndat / .rez that parsed to zero resources almost always
        // means its resource fork is present-but-empty. On macOS the resource
        // fork lives in an extended attribute (com.apple.ResourceFork); copying
        // through a filesystem/tool that drops xattrs (zip, some cp, cloud sync,
        // git) silently strips it, leaving a forkless file that reads clean but
        // empty. Warn loudly so this doesn't manifest as mysteriously missing
        // ships/systems/planets down the line.
        if (resourceCount === 0 && likelyHasResources(filePath)) {
            console.warn(
                "\n" +
                "********************************************************************\n" +
                "NovaParse: plug-in parsed to ZERO resources:\n" +
                "    " + filePath + "\n" +
                "Its resource fork is likely empty. On macOS the resource fork is an\n" +
                "extended attribute; copying via a tool that drops xattrs (zip, some\n" +
                "cp invocations, cloud sync, git) silently strips it. Re-copy the\n" +
                "file preserving its resource fork (e.g. `cp -p`, `ditto`, or a DMG).\n" +
                "********************************************************************\n",
            );
        }

        return true;
    }
}

// Files that are expected to carry Nova resources. A zero-resource read from
// one of these is suspicious (empty/stripped resource fork).
function likelyHasResources(filePath: string): boolean {
    const resourceExtensions = new Set([".plug", ".ndat", ".rez", ".npif"]);
    const ext = path.extname(filePath).toLowerCase();
    // Classic Mac resource-fork plug-ins often have no extension at all.
    return resourceExtensions.has(ext) || ext === "";
}

// Renders an unknown thrown value into a readable, information-preserving
// string (name, message, code, and stack when available).
function errorDetail(e: unknown): string {
    if (e instanceof Error) {
        const code = (e as NodeJS.ErrnoException).code;
        const codePart = code ? " [" + code + "]" : "";
        return e.name + codePart + ": " + e.message + (e.stack ? "\n" + e.stack : "");
    }
    return String(e);
}

function isDirectory(path: string): Promise<boolean> {
    return new Promise(function(fulfill, reject) {
        fs.stat(path, (err, stats): void => {
            if (err) {
                if (err.code == "ENOENT") {
                    fulfill(false);
                }
                reject(err);
            }
            else {
                fulfill(stats.isDirectory());
            }
        });
    });
}


// Returns a list of files or directories in a directory.
function readdir(path: string): Promise<Array<string>> {
    return new Promise(function(fulfill, reject) {
        fs.readdir(path, function(err, files) {
            if (err) {
                reject(err);
            }
            else {
                fulfill(files.filter(function(p) {
                    return p[0] !== '.';
                }));
            }
        });
    });
}




export { IDSpaceHandler, BadDirectoryStructureError };
