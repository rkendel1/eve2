import { describeSessionHost } from "./battery.js";
import { inProcessDurableHost } from "./host-under-test.js";

describeSessionHost("in-process-durable", inProcessDurableHost);
