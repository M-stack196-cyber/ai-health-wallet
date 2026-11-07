// Web entry. Metro (see metro.config.js) starts the web build here instead of index.ts. Native builds never load it.
import { registerRootComponent } from "expo";
import WebApp from "./src/WebApp";
registerRootComponent(WebApp);
