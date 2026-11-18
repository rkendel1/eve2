import { workspacePeers } from "#channel/auth/definitions.js";
import { localDev, placeholderAuth, vercelOidc } from "#public/channels/auth.js";
import { eveChannel } from "#eve-channel/index.js";

export default function createDefaultEveChannel() {
  return eveChannel({ auth: [vercelOidc(), workspacePeers(), localDev(), placeholderAuth()] });
}
