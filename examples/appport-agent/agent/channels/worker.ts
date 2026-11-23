import { jwtHmac } from "eve/channels/auth";
import { workChannel } from "eve/channels/work";

export default workChannel({
  auth: jwtHmac({
    algorithm: "HS256",
    audiences: [process.env.AGENT_JWT_AUDIENCE ?? "appport-agent"],
    issuer: process.env.AGENT_JWT_ISSUER ?? "appport-agent-operator",
    secret: process.env.AGENT_JWT_SECRET ?? "",
  }),
});
