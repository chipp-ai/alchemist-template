/** The app's module switches (web/src/chipp-app.json); see app-modules.ts. */
import chippApp from "../chipp-app.json";
import { type AppModule, type ChippAppConfig, isModuleOn } from "./app-modules";

export const appConfig: ChippAppConfig = chippApp;

export function moduleOn(module: AppModule): boolean {
  return isModuleOn(appConfig, module);
}
