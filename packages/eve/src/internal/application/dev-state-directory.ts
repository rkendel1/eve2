import { join, resolve } from "node:path";

import {
  EVE_DEV_STATE_DIR_ENV,
  isEveDevEnvironment,
} from "#internal/application/dev-environment.js";

export function resolveDevelopmentStateDirectory(appRoot: string): string {
  const override = process.env[EVE_DEV_STATE_DIR_ENV];
  if (!isEveDevEnvironment() || override === undefined || override.length === 0) {
    return join(appRoot, ".eve");
  }
  return resolve(appRoot, override);
}
