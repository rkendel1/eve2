import { host } from "./abg.js";
import { encode, decode } from "./wire.js";

export class HostLanguageModel {
  specificationVersion = "v4";
  provider = "appboundry.host";
  supportedUrls = {};
  constructor(reference) {
    this.modelId = reference;
  }
  async doGenerate() {
    throw new Error(
      "eve streams its model calls; doGenerate is not part of the guest's model boundary",
    );
  }
  async doStream(options) {
    const { abortSignal: _signal, headers: _headers, ...call } = options;
    const answer = await host("model.stream", { model: this.modelId, call: encode(call) });
    const parts = decode(answer.parts);
    return {
      stream: new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      }),
      request: answer.request ?? {},
      response: answer.response ? decode(answer.response) : undefined,
    };
  }
}
