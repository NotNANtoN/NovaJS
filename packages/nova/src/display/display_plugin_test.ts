import "jasmine";
import { System } from "nova_ecs/system";
import { Display } from "./display_plugin.js";
import { AnimationGraphicPlugin } from "./animation_graphic_plugin.js";
import { AnimationPlugin } from "../nova_plugin/animation_plugin.js";
import { ScreenSizePlugin } from "./screen_size_plugin.js";
import { Stage } from "./stage_resource.js";
import { Space } from "./space_resource.js";

describe("Display plugin", () => {
    it("installs AnimationPlugin before AnimationGraphicPlugin", async () => {
        const plugins: unknown[] = [];
        const fakeWorld = {
            resources: {
                set: jasmine.createSpy("set"),
                get: jasmine.createSpy("get").and.returnValue(undefined),
                delete: jasmine.createSpy("delete"),
            },
            addPlugin: jasmine.createSpy("addPlugin").and.callFake(async (plugin: unknown) => {
                plugins.push(plugin);
            }),
            removePlugin: jasmine.createSpy("removePlugin").and.resolveTo(true),
            addSystem: jasmine.createSpy("addSystem"),
            removeSystem: jasmine.createSpy("removeSystem"),
        };

        await Display.build(fakeWorld as never);

        expect(fakeWorld.resources.set).toHaveBeenCalledWith(Stage, jasmine.anything());
        expect(fakeWorld.resources.set).toHaveBeenCalledWith(Space, jasmine.anything());

        const animationPluginIndex = plugins.indexOf(AnimationPlugin);
        const animationGraphicPluginIndex = plugins.indexOf(AnimationGraphicPlugin);
        expect(animationPluginIndex).toBeGreaterThanOrEqual(0);
        expect(animationGraphicPluginIndex).toBeGreaterThan(animationPluginIndex);
        expect(plugins[0]).toBe(ScreenSizePlugin);
    });
});
