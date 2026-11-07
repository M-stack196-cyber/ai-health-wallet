// Metro configuration for the patient app. It is the Expo default plus ONE web-only hook.
// On the "web" platform the hook swaps four modules that cannot work in a browser for small web shims (src/web-shims).
// It also starts the web build from index.web.ts. On every other platform (android, ios) the hook returns exactly what Expo would have returned: nothing is redirected.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const shims = path.join(__dirname, "src", "web-shims");
// Module names redirected by name, web only.
const byName = {
  "expo-file-system": path.join(shims, "expo-file-system.ts"),
  "expo-screen-capture": path.join(shims, "expo-screen-capture.ts"),
};
// react-native-web files replaced after normal resolution, web only (its Alert does nothing; its Share has no honest fallback).
const byFile = [
  [/[\\/]react-native-web[\\/]dist[\\/](?:cjs[\\/])?exports[\\/]Alert[\\/]index\.js$/, path.join(shims, "alert.ts")],
  [/[\\/]react-native-web[\\/]dist[\\/](?:cjs[\\/])?exports[\\/]Share[\\/]index\.js$/, path.join(shims, "share.ts")],
];
const entry = path.join(__dirname, "index.ts");
const webEntry = path.join(__dirname, "index.web.ts");
const trace = process.env.HW_METRO_TRACE === "1";
const original = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = original ?? context.resolveRequest;
  if (platform !== "web") return resolve(context, moduleName, platform);
  if (Object.hasOwn(byName, moduleName) && !context.originModulePath.startsWith(shims)) {
    if (trace) console.log("[hw-metro] web redirect " + moduleName);
    return { type: "sourceFile", filePath: byName[moduleName] };
  }
  const resolution = resolve(context, moduleName, platform);
  if (resolution && resolution.type === "sourceFile") {
    // The web build starts from index.web.ts (Metro does not do this by itself for an entry named with its extension).
    if (resolution.filePath === entry) {
      if (trace) console.log("[hw-metro] web redirect entry");
      return { type: "sourceFile", filePath: webEntry };
    }
    for (const [pattern, target] of byFile) {
      if (pattern.test(resolution.filePath)) {
        if (trace) console.log("[hw-metro] web redirect " + path.basename(path.dirname(resolution.filePath)));
        return { type: "sourceFile", filePath: target };
      }
    }
  }
  return resolution;
};
module.exports = config;
