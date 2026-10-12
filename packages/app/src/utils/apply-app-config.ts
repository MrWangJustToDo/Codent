import type { AppConfig } from "../adapter/types.js";

/**
 * Copy optional host fields onto the app config store.
 * `initConfig` must call this so CLI-parsed `toolConfig` / `remoteSession` survive
 * into `adapter.initialize` → `Host.create`.
 */
export function applyOptionalAppConfig(target: AppConfig, source: Partial<AppConfig>): void {
  target.modelInfo = source.modelInfo;
  target.providerMode = source.providerMode;
  target.toolConfig = source.toolConfig;
  target.productName = source.productName;
  target.remotePlanes = source.remotePlanes;
  target.acp = source.acp;
  target.remoteEnv = source.remoteEnv;
  target.remoteProvider = source.remoteProvider;
  target.remoteSession = source.remoteSession;
}

/** Drop optional host fields (used by `useConfig.reset`). */
export function clearOptionalAppConfig(target: AppConfig): void {
  target.modelInfo = undefined;
  target.providerMode = undefined;
  target.toolConfig = undefined;
  target.productName = undefined;
  target.remotePlanes = undefined;
  target.acp = undefined;
  target.remoteEnv = undefined;
  target.remoteProvider = undefined;
  target.remoteSession = undefined;
}
