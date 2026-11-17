import type { ModelCatalogSnapshot } from "#internal/model-catalog.js";

export const MODEL_CATALOG_SNAPSHOT: ModelCatalogSnapshot = {
  fetchedAt: "2026-11-17T00:00:00.000Z",
  models: [
    {
      slug: "alibaba/qwen-3-14b",
      providers: [
        { provider: "deepinfra", providerModelId: "Qwen/Qwen3-14B", contextWindowTokens: 40960 },
      ],
    },
    {
      slug: "alibaba/qwen-3-30b",
      providers: [
        {
          provider: "deepinfra",
          providerModelId: "Qwen/Qwen3-30B-A3B",
          contextWindowTokens: 40960,
        },
      ],
    },
    {
      slug: "alibaba/qwen-3-32b",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "qwen.qwen3-32b-v1:0",
          contextWindowTokens: 128000,
        },
        { provider: "deepinfra", providerModelId: "Qwen/Qwen3-32B", contextWindowTokens: 40960 },
      ],
    },
    {
      slug: "alibaba/qwen3-coder-30b-a3b",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "qwen.qwen3-coder-30b-a3b-v1:0",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "alibaba/qwen3-coder-next",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "qwen.qwen3-coder-next",
          contextWindowTokens: 256000,
        },
      ],
    },
    {
      slug: "alibaba/qwen3-embedding-0.6b",
      providers: [
        {
          provider: "deepinfra",
          providerModelId: "Qwen/Qwen3-Embedding-0.6B",
          contextWindowTokens: 32768,
        },
      ],
    },
    {
      slug: "alibaba/qwen3-embedding-4b",
      providers: [
        {
          provider: "deepinfra",
          providerModelId: "Qwen/Qwen3-Embedding-4B",
          contextWindowTokens: 32768,
        },
      ],
    },
    {
      slug: "alibaba/qwen3-embedding-8b",
      providers: [
        {
          provider: "deepinfra",
          providerModelId: "Qwen/Qwen3-Embedding-8B",
          contextWindowTokens: 32768,
        },
        {
          provider: "nebius",
          providerModelId: "Qwen/Qwen3-Embedding-8B",
          contextWindowTokens: 41000,
        },
      ],
    },
    {
      slug: "alibaba/qwen3-max-thinking",
      providers: [
        {
          provider: "alibaba",
          providerModelId: "qwen3-max-2026-01-23",
          contextWindowTokens: 256000,
        },
      ],
    },
    {
      slug: "alibaba/qwen3-next-80b-a3b-instruct",
      providers: [
        {
          provider: "deepinfra",
          providerModelId: "Qwen/Qwen3-Next-80B-A3B-Instruct",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "alibaba/qwen3-vl-instruct",
      providers: [
        {
          provider: "deepinfra",
          providerModelId: "Qwen/Qwen3-VL-235B-A22B-Instruct",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "alibaba/qwen3.5-flash",
      providers: [
        { provider: "alibaba", providerModelId: "qwen3.5-flash", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "alibaba/qwen3.5-plus",
      providers: [
        { provider: "alibaba", providerModelId: "qwen3.5-plus", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "alibaba/qwen3.6-27b",
      providers: [
        { provider: "alibaba", providerModelId: "qwen3.6-27b", contextWindowTokens: 256000 },
      ],
    },
    {
      slug: "alibaba/qwen3.6-35b-a3b",
      providers: [
        { provider: "alibaba", providerModelId: "qwen3.6-35b-a3b", contextWindowTokens: 262144 },
        {
          provider: "parasail",
          providerModelId: "Qwen/Qwen3.6-35B-A3B",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "alibaba/qwen3.6-plus",
      providers: [
        { provider: "alibaba", providerModelId: "qwen3.6-plus", contextWindowTokens: 1000000 },
        {
          provider: "togetherai",
          providerModelId: "Qwen/Qwen3.6-Plus",
          contextWindowTokens: 1000000,
        },
      ],
    },
    {
      slug: "alibaba/qwen3.7-flash",
      providers: [
        { provider: "alibaba", providerModelId: "qwen3.7-flash", contextWindowTokens: 991000 },
      ],
    },
    {
      slug: "alibaba/qwen3.7-max",
      providers: [
        { provider: "alibaba", providerModelId: "qwen3.7-max", contextWindowTokens: 991000 },
      ],
    },
    {
      slug: "alibaba/qwen3.7-plus",
      providers: [
        { provider: "alibaba", providerModelId: "qwen3.7-plus", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "alibaba/qwen3.8-2.4t-a95b",
      providers: [
        {
          provider: "fireworks",
          providerModelId: "accounts/fireworks/models/qwen3p8-max",
          contextWindowTokens: 262144,
        },
        { provider: "gmicloud", providerModelId: "Qwen/Qwen3.8-Max", contextWindowTokens: 262144 },
        {
          provider: "modal",
          providerModelId: "vercelaigateway--ep-qwen3-8-2-4t-a95b-server.us-west.modal.direct",
          contextWindowTokens: 262144,
        },
        { provider: "novita", providerModelId: "qwen/qwen3.8-max", contextWindowTokens: 262144 },
        {
          provider: "togetherai",
          providerModelId: "Qwen/Qwen3.8-2.4T-A95B",
          contextWindowTokens: 256000,
        },
      ],
    },
    {
      slug: "alibaba/qwen3.8-27b",
      providers: [
        { provider: "alibaba", providerModelId: "qwen3.8-27b", contextWindowTokens: 1000000 },
        { provider: "cerebras", providerModelId: "qwen-3.8-27b", contextWindowTokens: 131072 },
        { provider: "deepinfra", providerModelId: "Qwen/Qwen3.8-27B", contextWindowTokens: 262144 },
        { provider: "novita", providerModelId: "qwen/qwen3.8-27b", contextWindowTokens: 1000000 },
        {
          provider: "parasail",
          providerModelId: "parasail-qwen38-27b",
          contextWindowTokens: 262144,
        },
        { provider: "runinfra", providerModelId: "qwen3-8-27b", contextWindowTokens: 262144 },
        { provider: "wafer", providerModelId: "Qwen3.8-27B", contextWindowTokens: 262144 },
      ],
    },
    {
      slug: "alibaba/qwen3.8-flash",
      providers: [
        { provider: "alibaba", providerModelId: "qwen3.8-flash", contextWindowTokens: 991000 },
      ],
    },
    {
      slug: "alibaba/qwen3.8-max",
      providers: [
        { provider: "alibaba", providerModelId: "qwen3.8-max", contextWindowTokens: 1000000 },
        {
          provider: "fireworks",
          providerModelId: "accounts/fireworks/models/qwen3p8-max",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "alibaba/qwen3.8-max-0902",
      providers: [
        { provider: "alibaba", providerModelId: "qwen3.8-max-0902", contextWindowTokens: 991000 },
      ],
    },
    {
      slug: "alibaba/qwen3.8-max-prime",
      providers: [
        { provider: "alibaba", providerModelId: "qwen3.8-max-prime", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "alibaba/qwen3.8-omni-flash",
      providers: [
        {
          provider: "alibaba",
          providerModelId: "qwen3.8-omni-flash",
          contextWindowTokens: 1000000,
        },
      ],
    },
    {
      slug: "alibaba/qwen4-max",
      providers: [
        { provider: "alibaba", providerModelId: "qwen4-max", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "amazon/nova-2-lite",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "us.amazon.nova-2-lite-v1:0",
          contextWindowTokens: 1000000,
        },
      ],
    },
    {
      slug: "amazon/nova-lite",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "us.amazon.nova-lite-v1:0",
          contextWindowTokens: 300000,
        },
      ],
    },
    {
      slug: "amazon/nova-micro",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "us.amazon.nova-micro-v1:0",
          contextWindowTokens: 128000,
        },
      ],
    },
    {
      slug: "amazon/nova-pro",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "us.amazon.nova-pro-v1:0",
          contextWindowTokens: 300000,
        },
      ],
    },
    {
      slug: "anthropic/claude-fable-5",
      providers: [
        { provider: "anthropic", providerModelId: "claude-fable-5", contextWindowTokens: 1000000 },
        {
          provider: "bedrock",
          providerModelId: "global.anthropic.claude-fable-5",
          contextWindowTokens: 1000000,
        },
        { provider: "vertex", providerModelId: "claude-fable-5", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "anthropic/claude-fable-5.1",
      providers: [
        {
          provider: "anthropic",
          providerModelId: "claude-fable-5-1",
          contextWindowTokens: 1000000,
        },
        {
          provider: "bedrock",
          providerModelId: "global.anthropic.claude-fable-5-1",
          contextWindowTokens: 1000000,
        },
        { provider: "vertex", providerModelId: "claude-fable-5-1", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "anthropic/claude-fable-5.2",
      providers: [
        {
          provider: "anthropic",
          providerModelId: "claude-fable-5-2",
          contextWindowTokens: 1000000,
        },
        {
          provider: "bedrock",
          providerModelId: "global.anthropic.claude-fable-5-2",
          contextWindowTokens: 1000000,
        },
        { provider: "vertex", providerModelId: "claude-fable-5-2", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "anthropic/claude-fable-5.2-fast",
      providers: [
        {
          provider: "anthropic",
          providerModelId: "claude-fable-5-2",
          contextWindowTokens: 1000000,
        },
      ],
    },
    {
      slug: "anthropic/claude-haiku-4.5",
      providers: [
        {
          provider: "anthropic",
          providerModelId: "claude-haiku-4-5-20251001",
          contextWindowTokens: 200000,
        },
        {
          provider: "bedrock",
          providerModelId: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
          contextWindowTokens: 200000,
        },
        { provider: "claudeaws", providerModelId: "claude-haiku-4-5", contextWindowTokens: 200000 },
        {
          provider: "vertex",
          providerModelId: "claude-haiku-4-5@20251001",
          contextWindowTokens: 200000,
        },
      ],
    },
    {
      slug: "anthropic/claude-haiku-5.5",
      providers: [
        {
          provider: "anthropic",
          providerModelId: "claude-haiku-5-5",
          contextWindowTokens: 1000000,
        },
        {
          provider: "bedrock",
          providerModelId: "global.anthropic.claude-haiku-5-5",
          contextWindowTokens: 1000000,
        },
        {
          provider: "claudeaws",
          providerModelId: "claude-haiku-5-5",
          contextWindowTokens: 1000000,
        },
        { provider: "vertex", providerModelId: "claude-haiku-5-5", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "anthropic/claude-opus-4.5",
      providers: [
        {
          provider: "anthropic",
          providerModelId: "claude-opus-4-5-20251101",
          contextWindowTokens: 200000,
        },
        {
          provider: "bedrock",
          providerModelId: "global.anthropic.claude-opus-4-5-20251101-v1:0",
          contextWindowTokens: 200000,
        },
        {
          provider: "vertex",
          providerModelId: "claude-opus-4-5@20251101",
          contextWindowTokens: 200000,
        },
      ],
    },
    {
      slug: "anthropic/claude-opus-4.6",
      providers: [
        { provider: "anthropic", providerModelId: "claude-opus-4-6", contextWindowTokens: 1000000 },
        {
          provider: "bedrock",
          providerModelId: "global.anthropic.claude-opus-4-6-v1",
          contextWindowTokens: 1000000,
        },
        { provider: "vertex", providerModelId: "claude-opus-4-6", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "anthropic/claude-opus-4.7",
      providers: [
        { provider: "anthropic", providerModelId: "claude-opus-4-7", contextWindowTokens: 1000000 },
        {
          provider: "bedrock",
          providerModelId: "global.anthropic.claude-opus-4-7",
          contextWindowTokens: 1000000,
        },
        { provider: "vertex", providerModelId: "claude-opus-4-7", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "anthropic/claude-opus-4.8",
      providers: [
        { provider: "anthropic", providerModelId: "claude-opus-4-8", contextWindowTokens: 1000000 },
        {
          provider: "bedrock",
          providerModelId: "global.anthropic.claude-opus-4-8",
          contextWindowTokens: 1000000,
        },
        { provider: "claudeaws", providerModelId: "claude-opus-4-8", contextWindowTokens: 1000000 },
        { provider: "vertex", providerModelId: "claude-opus-4-8", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "anthropic/claude-opus-4.8-fast",
      providers: [
        { provider: "anthropic", providerModelId: "claude-opus-4-8", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "anthropic/claude-opus-5",
      providers: [
        { provider: "anthropic", providerModelId: "claude-opus-5", contextWindowTokens: 1000000 },
        {
          provider: "bedrock",
          providerModelId: "global.anthropic.claude-opus-5",
          contextWindowTokens: 1000000,
        },
        { provider: "claudeaws", providerModelId: "claude-opus-5", contextWindowTokens: 1000000 },
        { provider: "vertex", providerModelId: "claude-opus-5", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "anthropic/claude-opus-5-fast",
      providers: [
        { provider: "anthropic", providerModelId: "claude-opus-5", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "anthropic/claude-opus-5.5",
      providers: [
        { provider: "anthropic", providerModelId: "claude-opus-5-5", contextWindowTokens: 1000000 },
        {
          provider: "bedrock",
          providerModelId: "global.anthropic.claude-opus-5-5",
          contextWindowTokens: 1000000,
        },
        { provider: "claudeaws", providerModelId: "claude-opus-5-5", contextWindowTokens: 1000000 },
        { provider: "vertex", providerModelId: "claude-opus-5-5", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "anthropic/claude-opus-5.5-fast",
      providers: [
        { provider: "anthropic", providerModelId: "claude-opus-5-5", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "anthropic/claude-sonnet-4.5",
      providers: [
        {
          provider: "anthropic",
          providerModelId: "claude-sonnet-4-5-20250929",
          contextWindowTokens: 1000000,
        },
        {
          provider: "bedrock",
          providerModelId: "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
          contextWindowTokens: 1000000,
        },
        {
          provider: "vertex",
          providerModelId: "claude-sonnet-4-5@20250929",
          contextWindowTokens: 1000000,
        },
      ],
    },
    {
      slug: "anthropic/claude-sonnet-4.6",
      providers: [
        {
          provider: "anthropic",
          providerModelId: "claude-sonnet-4-6",
          contextWindowTokens: 1000000,
        },
        {
          provider: "bedrock",
          providerModelId: "global.anthropic.claude-sonnet-4-6",
          contextWindowTokens: 1000000,
        },
        {
          provider: "claudeaws",
          providerModelId: "claude-sonnet-4-6",
          contextWindowTokens: 1000000,
        },
        { provider: "vertex", providerModelId: "claude-sonnet-4-6", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "anthropic/claude-sonnet-5",
      providers: [
        { provider: "anthropic", providerModelId: "claude-sonnet-5", contextWindowTokens: 1000000 },
        {
          provider: "bedrock",
          providerModelId: "global.anthropic.claude-sonnet-5",
          contextWindowTokens: 1000000,
        },
        { provider: "claudeaws", providerModelId: "claude-sonnet-5", contextWindowTokens: 1000000 },
        { provider: "vertex", providerModelId: "claude-sonnet-5", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "anthropic/claude-sonnet-5.5",
      providers: [
        {
          provider: "anthropic",
          providerModelId: "claude-sonnet-5-5",
          contextWindowTokens: 1000000,
        },
        {
          provider: "bedrock",
          providerModelId: "global.anthropic.claude-sonnet-5-5",
          contextWindowTokens: 1000000,
        },
        {
          provider: "claudeaws",
          providerModelId: "claude-sonnet-5-5",
          contextWindowTokens: 1000000,
        },
        { provider: "vertex", providerModelId: "claude-sonnet-5-5", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "baseten/elephant-1",
      providers: [
        {
          provider: "baseten",
          providerModelId: "decision-models/baseten-elephant-9b-latest",
          contextWindowTokens: 16384,
        },
      ],
    },
    {
      slug: "baseten/joey-1",
      providers: [
        {
          provider: "baseten",
          providerModelId: "decision-models/baseten-joey-2b-latest",
          contextWindowTokens: 16384,
        },
      ],
    },
    {
      slug: "baseten/mammoth-1",
      providers: [
        {
          provider: "baseten",
          providerModelId: "decision-models/baseten-mammoth-27b-latest",
          contextWindowTokens: 16384,
        },
      ],
    },
    {
      slug: "bfl/flux-2-max",
      providers: [{ provider: "bfl", providerModelId: "flux-2-max", contextWindowTokens: 67300 }],
    },
    {
      slug: "bfl/flux-2-pro",
      providers: [
        { provider: "bfl", providerModelId: "flux-2-pro-preview", contextWindowTokens: 67300 },
      ],
    },
    {
      slug: "bfl/flux-kontext-max",
      providers: [
        { provider: "bfl", providerModelId: "flux-kontext-max", contextWindowTokens: 512 },
      ],
    },
    {
      slug: "bfl/flux-kontext-pro",
      providers: [
        { provider: "bfl", providerModelId: "flux-kontext-pro", contextWindowTokens: 512 },
        {
          provider: "prodia",
          providerModelId: "inference.flux-kontext.pro.txt2img.v2",
          contextWindowTokens: 512,
        },
      ],
    },
    {
      slug: "bytedance/seed-2.1-turbo",
      providers: [
        {
          provider: "bytedance",
          providerModelId: "dola-seed-2-1-turbo-260628",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "callstack/apex",
      providers: [{ provider: "callstack", providerModelId: "apex", contextWindowTokens: 262144 }],
    },
    {
      slug: "cohere/command-a",
      providers: [
        { provider: "cohere", providerModelId: "command-a-03-2025", contextWindowTokens: 256000 },
      ],
    },
    {
      slug: "cohere/embed-v4.0",
      providers: [
        { provider: "bedrock", providerModelId: "cohere.embed-v4:0", contextWindowTokens: 128000 },
      ],
    },
    {
      slug: "cohere/embed-v5.0-fast",
      providers: [
        { provider: "cohere", providerModelId: "embed-v5.0-fast", contextWindowTokens: 128000 },
      ],
    },
    {
      slug: "cohere/embed-v5.0-pro",
      providers: [
        { provider: "cohere", providerModelId: "embed-v5.0-pro", contextWindowTokens: 128000 },
      ],
    },
    {
      slug: "cohere/rerank-v3.5",
      providers: [
        { provider: "bedrock", providerModelId: "cohere.rerank-v3-5:0", contextWindowTokens: 4096 },
      ],
    },
    {
      slug: "cohere/rerank-v4-fast",
      providers: [
        { provider: "cohere", providerModelId: "rerank-v4.0-fast", contextWindowTokens: 32000 },
      ],
    },
    {
      slug: "cohere/rerank-v4-pro",
      providers: [
        { provider: "cohere", providerModelId: "rerank-v4.0-pro", contextWindowTokens: 32000 },
      ],
    },
    {
      slug: "cohere/rerank-v5-fast",
      providers: [
        { provider: "cohere", providerModelId: "rerank-v5.0-fast", contextWindowTokens: 32768 },
      ],
    },
    {
      slug: "cohere/rerank-v5-pro",
      providers: [
        { provider: "cohere", providerModelId: "rerank-v5.0-pro", contextWindowTokens: 32768 },
      ],
    },
    {
      slug: "convaiinnovations/laya",
      providers: [
        {
          provider: "boundless",
          providerModelId: "convaiinnovations/laya",
          contextWindowTokens: 8192,
        },
      ],
    },
    {
      slug: "deepseek/deepseek-r1",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "us.deepseek.r1-v1:0",
          contextWindowTokens: 128000,
        },
      ],
    },
    {
      slug: "deepseek/deepseek-v3.1",
      providers: [
        {
          provider: "deepinfra",
          providerModelId: "deepseek-ai/DeepSeek-V3.1",
          contextWindowTokens: 163840,
        },
      ],
    },
    {
      slug: "deepseek/deepseek-v3.2",
      providers: [
        { provider: "bedrock", providerModelId: "deepseek.v3.2", contextWindowTokens: 128000 },
        {
          provider: "deepinfra",
          providerModelId: "deepseek-ai/DeepSeek-V3.2",
          contextWindowTokens: 163842,
        },
      ],
    },
    {
      slug: "deepseek/deepseek-v3.2-thinking",
      providers: [
        { provider: "bedrock", providerModelId: "deepseek.v3.2", contextWindowTokens: 128000 },
        {
          provider: "deepinfra",
          providerModelId: "deepseek-ai/DeepSeek-V3.2",
          contextWindowTokens: 163842,
        },
      ],
    },
    {
      slug: "deepseek/deepseek-v4-flash",
      providers: [
        {
          provider: "alibaba",
          providerModelId: "deepseek-v4-flash-0731",
          contextWindowTokens: 1000000,
        },
        { provider: "azure", providerModelId: "DeepSeek-V4-Flash", contextWindowTokens: 1000000 },
        {
          provider: "baseten",
          providerModelId: "deepseek-ai/DeepSeek-V4-Flash-0731",
          contextWindowTokens: 1000000,
        },
        {
          provider: "deepinfra",
          providerModelId: "deepseek-ai/DeepSeek-V4-Flash-0731",
          contextWindowTokens: 1048576,
        },
        {
          provider: "digitalocean",
          providerModelId: "deepseek-4-flash",
          contextWindowTokens: 262114,
        },
        {
          provider: "gmicloud",
          providerModelId: "deepseek-ai/DeepSeek-V4-Flash-0731",
          contextWindowTokens: 1048575,
        },
        {
          provider: "novita",
          providerModelId: "deepseek/deepseek-v4-flash-0731",
          contextWindowTokens: 1048576,
        },
        {
          provider: "wafer",
          providerModelId: "DeepSeek-V4-Flash-0731-Fast",
          contextWindowTokens: 1000000,
        },
      ],
    },
    {
      slug: "deepseek/deepseek-v4-flash-0731",
      providers: [
        {
          provider: "alibaba",
          providerModelId: "deepseek-v4-flash-0731",
          contextWindowTokens: 1000000,
        },
        {
          provider: "baseten",
          providerModelId: "deepseek-ai/DeepSeek-V4-Flash-0731",
          contextWindowTokens: 1000000,
        },
        { provider: "boundless", providerModelId: "dsv4", contextWindowTokens: 1048576 },
        {
          provider: "deepinfra",
          providerModelId: "deepseek-ai/DeepSeek-V4-Flash-0731",
          contextWindowTokens: 1048576,
        },
        {
          provider: "digitalocean",
          providerModelId: "deepseek-v4-flash-0731",
          contextWindowTokens: 1048576,
        },
        {
          provider: "gmicloud",
          providerModelId: "deepseek-ai/DeepSeek-V4-Flash-0731",
          contextWindowTokens: 1048575,
        },
        {
          provider: "inceptron",
          providerModelId: "deepseek-ai/DeepSeek-V4-Flash-0731",
          contextWindowTokens: 1000000,
        },
        {
          provider: "morph",
          providerModelId: "morph-dsv4flash-0731",
          contextWindowTokens: 1048576,
        },
        {
          provider: "novita",
          providerModelId: "deepseek/deepseek-v4-flash-0731",
          contextWindowTokens: 1048576,
        },
        {
          provider: "parasail",
          providerModelId: "deepseek-ai/DeepSeek-V4-Flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "relace",
          providerModelId: "deepseek-ai/DeepSeek-V4-Flash-0731",
          contextWindowTokens: 1000000,
        },
        {
          provider: "runware",
          providerModelId: "deepseek:v4@flash-vercel",
          contextWindowTokens: 1000000,
        },
        {
          provider: "streamlake",
          providerModelId: "DeepSeek-V4-Flash-0731",
          contextWindowTokens: 1024000,
        },
        {
          provider: "wafer",
          providerModelId: "DeepSeek-V4-Flash-0731-Fast",
          contextWindowTokens: 1000000,
        },
      ],
    },
    {
      slug: "deepseek/deepseek-v4-flash-vision-exp",
      providers: [
        {
          provider: "deepinfra",
          providerModelId: "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp",
          contextWindowTokens: 1048576,
        },
      ],
    },
    {
      slug: "deepseek/deepseek-v4-pro",
      providers: [
        { provider: "alibaba", providerModelId: "deepseek-v4-pro", contextWindowTokens: 1048600 },
        { provider: "azure", providerModelId: "DeepSeek-V4-Pro", contextWindowTokens: 1000000 },
        {
          provider: "baseten",
          providerModelId: "deepseek-ai/DeepSeek-V4-Pro-0813",
          contextWindowTokens: 1048600,
        },
        {
          provider: "deepinfra",
          providerModelId: "deepseek-ai/DeepSeek-V4-Pro",
          contextWindowTokens: 65536,
        },
        { provider: "deepseek", providerModelId: "deepseek-v4-pro", contextWindowTokens: 1000000 },
        {
          provider: "novita",
          providerModelId: "deepseek/deepseek-v4-pro",
          contextWindowTokens: 1048576,
        },
      ],
    },
    {
      slug: "deepseek/deepseek-v4-pro-0813",
      providers: [
        {
          provider: "alibaba",
          providerModelId: "deepseek-v4-pro-0813",
          contextWindowTokens: 1000000,
        },
        {
          provider: "baseten",
          providerModelId: "deepseek-ai/DeepSeek-V4-Pro-0813",
          contextWindowTokens: 1048600,
        },
        {
          provider: "deepinfra",
          providerModelId: "deepseek-ai/DeepSeek-V4-Pro-0813",
          contextWindowTokens: 1000000,
        },
        { provider: "deepseek", providerModelId: "deepseek-v4-pro", contextWindowTokens: 1000000 },
        {
          provider: "digitalocean",
          providerModelId: "deepseek-v4-pro-0813",
          contextWindowTokens: 1048576,
        },
        {
          provider: "gmicloud",
          providerModelId: "deepseek-ai/DeepSeek-V4-Pro-0813",
          contextWindowTokens: 1048575,
        },
        {
          provider: "novita",
          providerModelId: "deepseek/deepseek-v4-pro-0813",
          contextWindowTokens: 1000000,
        },
        {
          provider: "parasail",
          providerModelId: "deepseek-ai/DeepSeek-V4-Pro-0813",
          contextWindowTokens: 1048576,
        },
        {
          provider: "streamlake",
          providerModelId: "DeepSeek-V4-Pro-0813",
          contextWindowTokens: 1024000,
        },
        {
          provider: "tencent",
          providerModelId: "deepseek-v4-pro-0813",
          contextWindowTokens: 1000000,
        },
      ],
    },
    {
      slug: "deepseek/deepseek-v4.1-flash",
      providers: [
        {
          provider: "alibaba",
          providerModelId: "deepseek-v4.1-flash",
          contextWindowTokens: 1000000,
        },
        {
          provider: "baseten",
          providerModelId: "deepseek-ai/DeepSeek-V4.1-Flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "boundless",
          providerModelId: "deepseek-v4.1-flash",
          contextWindowTokens: 1000000,
        },
        {
          provider: "deepinfra",
          providerModelId: "deepseek-ai/DeepSeek-V4.1-Flash",
          contextWindowTokens: 1048576,
        },
        { provider: "deepseek", providerModelId: "deepseek-flash", contextWindowTokens: 1000000 },
        {
          provider: "digitalocean",
          providerModelId: "deepseek-v4.1-flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "fireworks",
          providerModelId: "accounts/fireworks/models/deepseek-v4p1-flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "gmicloud",
          providerModelId: "deepseek-ai/DeepSeek-V4.1-Flash",
          contextWindowTokens: 1048575,
        },
        {
          provider: "inference-net",
          providerModelId: "deepseek-v4.1-flash",
          contextWindowTokens: 1040000,
        },
        {
          provider: "modal",
          providerModelId: "vercelaigateway--ep-deepseek-v4-1-flash-server.us-west.modal.direct",
          contextWindowTokens: 1048576,
        },
        { provider: "morph", providerModelId: "morph-dsv41flash", contextWindowTokens: 1048576 },
        {
          provider: "novita",
          providerModelId: "deepseek/deepseek-v4.1-flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "parasail",
          providerModelId: "deepseek-ai/DeepSeek-V4.1-Flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "pareto",
          providerModelId: "deepseek/deepseek-v4.1-flash",
          contextWindowTokens: 1000000,
        },
        {
          provider: "particle",
          providerModelId: "deepseek-v4.1-flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "relace",
          providerModelId: "deepseek-ai/DeepSeek-V4.1-Flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "runinfra",
          providerModelId: "deepseek-ai/DeepSeek-V4.1-Flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "runware",
          providerModelId: "deepseek:v4.1@flash-vercel",
          contextWindowTokens: 1048576,
        },
        {
          provider: "tencent",
          providerModelId: "deepseek-v4.1-flash",
          contextWindowTokens: 1000000,
        },
        {
          provider: "togetherai",
          providerModelId: "deepseek-ai/DeepSeek-V4.1-Flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "vertex",
          providerModelId: "deepseek-ai/deepseek-v4.1-flash-maas",
          contextWindowTokens: 1048576,
        },
        { provider: "wafer", providerModelId: "DeepSeek-V4.1-Flash", contextWindowTokens: 1048576 },
      ],
    },
    {
      slug: "deepseek/deepseek-v4.1-flash-1017",
      providers: [
        {
          provider: "alibaba",
          providerModelId: "deepseek-v4.1-flash-1017",
          contextWindowTokens: 1000000,
        },
        {
          provider: "baseten",
          providerModelId: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
          contextWindowTokens: 1048576,
        },
        {
          provider: "boundless",
          providerModelId: "deepseek/deepseek-v4.1-flash-1017",
          contextWindowTokens: 1048576,
        },
        {
          provider: "deepinfra",
          providerModelId: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
          contextWindowTokens: 1048576,
        },
        { provider: "deepseek", providerModelId: "deepseek-flash", contextWindowTokens: 1000000 },
        {
          provider: "digitalocean",
          providerModelId: "deepseek-v4.1-flash-1017",
          contextWindowTokens: 1048576,
        },
        {
          provider: "fireworks",
          providerModelId: "accounts/fireworks/models/deepseek-v4p1-flash-1017",
          contextWindowTokens: 1048576,
        },
        {
          provider: "gmicloud",
          providerModelId: "deepseek-ai/deepseek-v4.1-flash-1017",
          contextWindowTokens: 1048575,
        },
        {
          provider: "inference-net",
          providerModelId: "deepseek-v4.1-flash-1017",
          contextWindowTokens: 262144,
        },
        {
          provider: "morph",
          providerModelId: "morph-dsv41flash-1017",
          contextWindowTokens: 1048576,
        },
        {
          provider: "nebius",
          providerModelId: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
          contextWindowTokens: 1048576,
        },
        {
          provider: "novita",
          providerModelId: "deepseek/deepseek-v4.1-flash-1017",
          contextWindowTokens: 1048576,
        },
        {
          provider: "parasail",
          providerModelId: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
          contextWindowTokens: 1048576,
        },
        {
          provider: "pareto",
          providerModelId: "deepseek/deepseek-v4.1-flash",
          contextWindowTokens: 1000000,
        },
        {
          provider: "particle",
          providerModelId: "deepseek-v41-flash-1017",
          contextWindowTokens: 1048576,
        },
        {
          provider: "relace",
          providerModelId: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
          contextWindowTokens: 1048576,
        },
        {
          provider: "runinfra",
          providerModelId: "deepseek-v4-1-flash-1017",
          contextWindowTokens: 1048576,
        },
        {
          provider: "runware",
          providerModelId: "deepseek:v4.1@flash-1017-vercel",
          contextWindowTokens: 1048576,
        },
        {
          provider: "sail-research",
          providerModelId: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
          contextWindowTokens: 1048576,
        },
        {
          provider: "streamlake",
          providerModelId: "DeepSeek-V4.1-Flash-1017",
          contextWindowTokens: 1024000,
        },
        {
          provider: "subconscious",
          providerModelId: "subconscious/deepseek-v4.1-flash-marathon",
          contextWindowTokens: 1000000,
        },
        {
          provider: "telnyx",
          providerModelId: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
          contextWindowTokens: 1048576,
        },
        {
          provider: "togetherai",
          providerModelId: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
          contextWindowTokens: 1048576,
        },
        {
          provider: "wafer",
          providerModelId: "DeepSeek-V4.1-Flash-1017",
          contextWindowTokens: 1000000,
        },
      ],
    },
    {
      slug: "deepseek/deepseek-v4.1-flash-1017-fast",
      providers: [
        {
          provider: "baseten",
          providerModelId: "deepseek-ai/DeepSeek-V4.1-Flash-1017-Fast",
          contextWindowTokens: 1048576,
        },
      ],
    },
    {
      slug: "deepseek/deepseek-v4.1-flash-1017-ultrafast",
      providers: [
        {
          provider: "fireworks",
          providerModelId: "accounts/fireworks/routers/deepseek-v4p1-flash-1017-ultrafast",
          contextWindowTokens: 1048576,
        },
      ],
    },
    {
      slug: "deepseek/deepseek-v4.1-flash-fast",
      providers: [
        {
          provider: "baseten",
          providerModelId: "deepseek-ai/DeepSeek-V4.1-Flash-Fast",
          contextWindowTokens: 1048576,
        },
      ],
    },
    {
      slug: "elorian/glimpse",
      providers: [
        { provider: "elorian", providerModelId: "elorian-1-agent", contextWindowTokens: 220000 },
      ],
    },
    {
      slug: "fireworks/ember-1",
      providers: [
        {
          provider: "fireworks",
          providerModelId: "accounts/fireworks/models/ember-1",
          contextWindowTokens: 1048576,
        },
      ],
    },
    {
      slug: "google/gemini-2.5-flash",
      providers: [
        { provider: "google", providerModelId: "gemini-2.5-flash", contextWindowTokens: 1000000 },
        { provider: "vertex", providerModelId: "gemini-2.5-flash", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "google/gemini-2.5-flash-image",
      providers: [
        {
          provider: "google",
          providerModelId: "gemini-2.5-flash-image",
          contextWindowTokens: 32768,
        },
        {
          provider: "vertex",
          providerModelId: "gemini-2.5-flash-image",
          contextWindowTokens: 32768,
        },
      ],
    },
    {
      slug: "google/gemini-2.5-flash-lite",
      providers: [
        {
          provider: "google",
          providerModelId: "gemini-2.5-flash-lite",
          contextWindowTokens: 1048576,
        },
        {
          provider: "vertex",
          providerModelId: "gemini-2.5-flash-lite",
          contextWindowTokens: 1048576,
        },
      ],
    },
    {
      slug: "google/gemini-2.5-pro",
      providers: [
        { provider: "google", providerModelId: "gemini-2.5-pro", contextWindowTokens: 1048576 },
        { provider: "vertex", providerModelId: "gemini-2.5-pro", contextWindowTokens: 1048576 },
      ],
    },
    {
      slug: "google/gemini-3-flash",
      providers: [
        {
          provider: "google",
          providerModelId: "gemini-3-flash-preview",
          contextWindowTokens: 1000000,
        },
        {
          provider: "vertex",
          providerModelId: "gemini-3-flash-preview",
          contextWindowTokens: 1000000,
        },
      ],
    },
    {
      slug: "google/gemini-3-pro-image",
      providers: [
        { provider: "google", providerModelId: "gemini-3-pro-image", contextWindowTokens: 65536 },
        { provider: "vertex", providerModelId: "gemini-3-pro-image", contextWindowTokens: 65536 },
      ],
    },
    {
      slug: "google/gemini-3.1-flash-image",
      providers: [
        {
          provider: "google",
          providerModelId: "gemini-3.1-flash-image",
          contextWindowTokens: 131072,
        },
        {
          provider: "vertex",
          providerModelId: "gemini-3.1-flash-image",
          contextWindowTokens: 131072,
        },
      ],
    },
    {
      slug: "google/gemini-3.1-flash-lite",
      providers: [
        {
          provider: "google",
          providerModelId: "gemini-3.1-flash-lite",
          contextWindowTokens: 1000000,
        },
        {
          provider: "vertex",
          providerModelId: "gemini-3.1-flash-lite",
          contextWindowTokens: 1000000,
        },
      ],
    },
    {
      slug: "google/gemini-3.1-flash-lite-image",
      providers: [
        {
          provider: "google",
          providerModelId: "gemini-3.1-flash-lite-image",
          contextWindowTokens: 65536,
        },
        {
          provider: "vertex",
          providerModelId: "gemini-3.1-flash-lite-image",
          contextWindowTokens: 65536,
        },
      ],
    },
    {
      slug: "google/gemini-3.1-pro-preview",
      providers: [
        {
          provider: "google",
          providerModelId: "gemini-3.1-pro-preview-customtools",
          contextWindowTokens: 1000000,
        },
        {
          provider: "vertex",
          providerModelId: "gemini-3.1-pro-preview",
          contextWindowTokens: 1000000,
        },
      ],
    },
    {
      slug: "google/gemini-3.5-flash",
      providers: [
        { provider: "vertex", providerModelId: "gemini-3.5-flash", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "google/gemini-3.5-flash-lite",
      providers: [
        {
          provider: "google",
          providerModelId: "gemini-3.5-flash-lite",
          contextWindowTokens: 1000000,
        },
        {
          provider: "vertex",
          providerModelId: "gemini-3.5-flash-lite",
          contextWindowTokens: 1000000,
        },
      ],
    },
    {
      slug: "google/gemini-3.6-flash",
      providers: [
        { provider: "google", providerModelId: "gemini-3.6-flash", contextWindowTokens: 1000000 },
        { provider: "vertex", providerModelId: "gemini-3.6-flash", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "google/gemini-3.7-flash",
      providers: [
        { provider: "vertex", providerModelId: "gemini-3.7-flash", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "google/gemini-3.8-flash",
      providers: [
        { provider: "google", providerModelId: "gemini-3.8-flash", contextWindowTokens: 1000000 },
        { provider: "vertex", providerModelId: "gemini-3.8-flash", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "google/gemini-3.8-flash-lite-tts",
      providers: [
        {
          provider: "vertex",
          providerModelId: "gemini-3.8-flash-lite-tts",
          contextWindowTokens: 8192,
        },
      ],
    },
    {
      slug: "google/gemini-3.8-flash-tts",
      providers: [
        { provider: "vertex", providerModelId: "gemini-3.8-flash-tts", contextWindowTokens: 8192 },
      ],
    },
    {
      slug: "google/gemini-4-argon",
      providers: [
        { provider: "google", providerModelId: "gemini-4-argon", contextWindowTokens: 1000000 },
        { provider: "vertex", providerModelId: "gemini-4-argon", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "google/gemini-4-carbon",
      providers: [
        { provider: "google", providerModelId: "gemini-4-carbon", contextWindowTokens: 1000000 },
        { provider: "vertex", providerModelId: "gemini-4-carbon", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "google/gemini-4-hydrogen",
      providers: [
        { provider: "google", providerModelId: "gemini-4-hydrogen", contextWindowTokens: 1000000 },
        { provider: "vertex", providerModelId: "gemini-4-hydrogen", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "google/gemini-decision-1",
      providers: [
        { provider: "google", providerModelId: "gemini-decision-1", contextWindowTokens: 262144 },
      ],
    },
    {
      slug: "google/gemini-nano-banana-2.1",
      providers: [
        {
          provider: "google",
          providerModelId: "gemini-nano-banana-2.1",
          contextWindowTokens: 131072,
        },
        {
          provider: "vertex",
          providerModelId: "gemini-nano-banana-2.1",
          contextWindowTokens: 131072,
        },
      ],
    },
    {
      slug: "google/gemini-omni-1.2-flash",
      providers: [
        {
          provider: "google",
          providerModelId: "gemini-omni-1.2-flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "vertex",
          providerModelId: "gemini-omni-1.2-flash",
          contextWindowTokens: 131072,
        },
      ],
    },
    {
      slug: "google/gemini-omni-flash-preview",
      providers: [
        {
          provider: "vertex",
          providerModelId: "gemini-omni-flash-preview",
          contextWindowTokens: 1000000,
        },
      ],
    },
    {
      slug: "google/gemma-4-26b-a4b-it",
      providers: [
        {
          provider: "gmicloud",
          providerModelId: "google/gemma-4-26b-a4b-it",
          contextWindowTokens: 1048576,
        },
        {
          provider: "novita",
          providerModelId: "google/gemma-4-26b-a4b-it",
          contextWindowTokens: 262144,
        },
        {
          provider: "parasail",
          providerModelId: "google/gemma-4-26B-A4B-it",
          contextWindowTokens: 262144,
        },
        {
          provider: "vertex",
          providerModelId: "google/gemma-4-26b-a4b-it-maas",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "google/gemma-4-31b-it",
      providers: [
        {
          provider: "friendli",
          providerModelId: "google/gemma-4-31B-it",
          contextWindowTokens: 256000,
        },
        {
          provider: "gmicloud",
          providerModelId: "google/gemma-4-31b-it",
          contextWindowTokens: 1048576,
        },
        {
          provider: "novita",
          providerModelId: "google/gemma-4-31b-it",
          contextWindowTokens: 262144,
        },
        {
          provider: "parasail",
          providerModelId: "google/gemma-4-31B-it",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "heygen/heygen-decision-1",
      providers: [
        { provider: "heygen", providerModelId: "heygen-decision-1", contextWindowTokens: 131072 },
      ],
    },
    {
      slug: "heygen/heygen-decision-1-turbo",
      providers: [
        {
          provider: "heygen",
          providerModelId: "heygen-decision-1-turbo",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "humansand/ampersand-v0.1",
      providers: [
        { provider: "humansand", providerModelId: "ampersand-v0.1", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "inception/mercury-3",
      providers: [
        { provider: "inception", providerModelId: "mercury-3", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "inclusionai/ling-3.0-flash",
      providers: [
        {
          provider: "novita",
          providerModelId: "inclusionai/ling-3.0-flash",
          contextWindowTokens: 256000,
        },
      ],
    },
    {
      slug: "inclusionai/ling-3.0-flash-fin",
      providers: [
        {
          provider: "novita",
          providerModelId: "inclusionai/ling-3.0-flash-fin",
          contextWindowTokens: 256000,
        },
      ],
    },
    {
      slug: "inclusionai/ling-3.0-flash-sante",
      providers: [
        {
          provider: "novita",
          providerModelId: "inclusionai/ling-3.0-flash-sante",
          contextWindowTokens: 256000,
        },
      ],
    },
    {
      slug: "inclusionai/ling-3.0-flash-vl",
      providers: [
        {
          provider: "novita",
          providerModelId: "inclusionai/ling-3.0-flash-vl",
          contextWindowTokens: 256000,
        },
      ],
    },
    {
      slug: "inclusionai/ling-3.1-flash",
      providers: [
        {
          provider: "novita",
          providerModelId: "inclusionai/ling-3.1-flash",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "inclusionai/ling-3.1-flash-1019",
      providers: [
        {
          provider: "novita",
          providerModelId: "inclusionai/ling-3.1-flash-1019",
          contextWindowTokens: 1000000,
        },
      ],
    },
    {
      slug: "inference-net/schematron-v2-small",
      providers: [
        {
          provider: "inference-net",
          providerModelId: "inference-net/schematron-v2-small",
          contextWindowTokens: 128000,
        },
      ],
    },
    {
      slug: "inference-net/schematron-v2-turbo",
      providers: [
        {
          provider: "inference-net",
          providerModelId: "inference-net/schematron-v2-turbo",
          contextWindowTokens: 128000,
        },
      ],
    },
    {
      slug: "interfaze/interfaze-beta",
      providers: [
        { provider: "interfaze", providerModelId: "interfaze-beta", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "liquid/d1",
      providers: [{ provider: "liquid", providerModelId: "d1", contextWindowTokens: 65536 }],
    },
    {
      slug: "liquid/d1-ultra",
      providers: [{ provider: "liquid", providerModelId: "d1-ultra", contextWindowTokens: 32768 }],
    },
    {
      slug: "liquid/d1.2",
      providers: [{ provider: "liquid", providerModelId: "d1.2", contextWindowTokens: 65536 }],
    },
    {
      slug: "liquid/d1.2-ultra",
      providers: [
        { provider: "liquid", providerModelId: "d1.2-ultra", contextWindowTokens: 65536 },
      ],
    },
    {
      slug: "liquid/lfm2.5-24b-a2b",
      providers: [
        {
          provider: "liquid",
          providerModelId: "LiquidAI/LFM2.5-24B-A2B",
          contextWindowTokens: 128000,
        },
      ],
    },
    {
      slug: "meituan/longcat-2.5",
      providers: [
        { provider: "meituan", providerModelId: "LongCat-2.5", contextWindowTokens: 1048576 },
      ],
    },
    {
      slug: "meta/llama-3.1-70b",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "us.meta.llama3-1-70b-instruct-v1:0",
          contextWindowTokens: 128000,
        },
      ],
    },
    {
      slug: "meta/llama-3.1-8b",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "us.meta.llama3-1-8b-instruct-v1:0",
          contextWindowTokens: 128000,
        },
        {
          provider: "novita",
          providerModelId: "meta-llama/llama-3.1-8b-instruct",
          contextWindowTokens: 16384,
        },
      ],
    },
    {
      slug: "meta/llama-3.3-70b",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "us.meta.llama3-3-70b-instruct-v1:0",
          contextWindowTokens: 128000,
        },
      ],
    },
    {
      slug: "meta/llama-4-maverick",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "us.meta.llama4-maverick-17b-instruct-v1:0",
          contextWindowTokens: 128000,
        },
      ],
    },
    {
      slug: "meta/llama-4-scout",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "us.meta.llama4-scout-17b-instruct-v1:0",
          contextWindowTokens: 128000,
        },
        {
          provider: "deepinfra",
          providerModelId: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
          contextWindowTokens: 131072,
        },
      ],
    },
    {
      slug: "meta/muse-ember",
      providers: [
        { provider: "meta", providerModelId: "muse-ember-1.0", contextWindowTokens: 1048576 },
      ],
    },
    {
      slug: "meta/muse-glimmer-30b",
      providers: [
        {
          provider: "togetherai",
          providerModelId: "meta-models/Muse-Glimmer-30B",
          contextWindowTokens: 131072,
        },
      ],
    },
    {
      slug: "meta/muse-spark-1.1",
      providers: [
        { provider: "meta", providerModelId: "muse-spark-1.1", contextWindowTokens: 1048576 },
      ],
    },
    {
      slug: "meta/muse-spark-1.2",
      providers: [
        { provider: "meta", providerModelId: "muse-spark-1.2", contextWindowTokens: 1048576 },
      ],
    },
    {
      slug: "meta/muse-spark-1.2-contributor",
      providers: [
        {
          provider: "meta",
          providerModelId: "muse-spark-1.2-contributor",
          contextWindowTokens: 1048576,
        },
      ],
    },
    {
      slug: "meta/muse-spark-1.3",
      providers: [
        { provider: "meta", providerModelId: "muse-spark-1.3", contextWindowTokens: 1048576 },
      ],
    },
    {
      slug: "meta/muse-spark-1.3-contributor",
      providers: [
        {
          provider: "meta",
          providerModelId: "muse-spark-1.3-contributor",
          contextWindowTokens: 1048576,
        },
      ],
    },
    {
      slug: "meta/muse-spark-open",
      providers: [
        {
          provider: "baseten",
          providerModelId: "meta-models/muse-spark-open",
          contextWindowTokens: 1048576,
        },
        {
          provider: "fireworks",
          providerModelId: "accounts/fireworks/models/muse-spark-open",
          contextWindowTokens: 1048576,
        },
        {
          provider: "modal",
          providerModelId:
            "vercelaigateway--ep-muse-spark-open-816b-a42b-server.us-west.modal.direct",
          contextWindowTokens: 1048576,
        },
        {
          provider: "nebius",
          providerModelId: "meta-models/muse-spark-open",
          contextWindowTokens: 1048576,
        },
        {
          provider: "togetherai",
          providerModelId: "meta-models/Muse-Spark-Open-816B-A42B",
          contextWindowTokens: 1048576,
        },
      ],
    },
    {
      slug: "meta/muse-wonder-1.0",
      providers: [
        { provider: "meta", providerModelId: "muse-wonder-1.0", contextWindowTokens: 1048576 },
      ],
    },
    {
      slug: "microsoft/microsoft-decision-1",
      providers: [{ provider: "azure", providerModelId: "Decision-1", contextWindowTokens: 32768 }],
    },
    {
      slug: "minimax/minimax-m2",
      providers: [
        { provider: "minimax", providerModelId: "MiniMax-M2-Stable", contextWindowTokens: 205000 },
      ],
    },
    {
      slug: "minimax/minimax-m2.1",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "minimax.minimax-m2.1",
          contextWindowTokens: 204800,
        },
        { provider: "minimax", providerModelId: "MiniMax-M2.1", contextWindowTokens: 204800 },
      ],
    },
    {
      slug: "minimax/minimax-m2.1-lightning",
      providers: [
        {
          provider: "minimax",
          providerModelId: "MiniMax-M2.1-lightning",
          contextWindowTokens: 204800,
        },
      ],
    },
    {
      slug: "minimax/minimax-m2.5",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "minimax.minimax-m2.5",
          contextWindowTokens: 1000000,
        },
        { provider: "minimax", providerModelId: "MiniMax-M2.5", contextWindowTokens: 204800 },
      ],
    },
    {
      slug: "minimax/minimax-m2.5-highspeed",
      providers: [
        {
          provider: "minimax",
          providerModelId: "minimax-m2.5-highspeed",
          contextWindowTokens: 204800,
        },
      ],
    },
    {
      slug: "minimax/minimax-m2.7",
      providers: [
        {
          provider: "gmicloud",
          providerModelId: "MiniMaxAI/MiniMax-M2.7",
          contextWindowTokens: 196608,
        },
        { provider: "minimax", providerModelId: "minimax-m2.7", contextWindowTokens: 204800 },
        {
          provider: "novita",
          providerModelId: "minimax/minimax-m2.7",
          contextWindowTokens: 204800,
        },
      ],
    },
    {
      slug: "minimax/minimax-m2.7-highspeed",
      providers: [
        {
          provider: "minimax",
          providerModelId: "minimax-m2.7-highspeed",
          contextWindowTokens: 204800,
        },
      ],
    },
    {
      slug: "minimax/minimax-m3",
      providers: [
        {
          provider: "fireworks",
          providerModelId: "accounts/fireworks/models/minimax-m3",
          contextWindowTokens: 512000,
        },
        {
          provider: "gmicloud",
          providerModelId: "MiniMaxAI/MiniMax-M3",
          contextWindowTokens: 1048576,
        },
        { provider: "minimax", providerModelId: "MiniMax-M3", contextWindowTokens: 1000000 },
        {
          provider: "nebius",
          providerModelId: "MiniMaxAI/MiniMax-M3",
          contextWindowTokens: 1049000,
        },
      ],
    },
    {
      slug: "minimax/minimax-m3.1-flash",
      providers: [
        {
          provider: "digitalocean",
          providerModelId: "minimax-m3.1-flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "fireworks",
          providerModelId: "accounts/fireworks/models/minimax-m3p1-flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "gmicloud",
          providerModelId: "MiniMaxAI/MiniMax-M3.1-Flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "inference-net",
          providerModelId: "minimax-m3.1-flash",
          contextWindowTokens: 1000000,
        },
        {
          provider: "minimax",
          providerModelId: "MiniMax-M3.1-Flash",
          contextWindowTokens: 1000000,
        },
        {
          provider: "nebius",
          providerModelId: "MiniMaxAI/MiniMax-M3.1-Flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "novita",
          providerModelId: "minimax/minimax-m3.1-flash",
          contextWindowTokens: 1000000,
        },
        {
          provider: "parasail",
          providerModelId: "MiniMaxAI/MiniMax-M3.1-Flash",
          contextWindowTokens: 1000000,
        },
        {
          provider: "togetherai",
          providerModelId: "MiniMaxAI/MiniMax-M3.1-Flash",
          contextWindowTokens: 1048576,
        },
      ],
    },
    {
      slug: "mistral/codestral",
      providers: [
        { provider: "mistral", providerModelId: "codestral-latest", contextWindowTokens: 128000 },
      ],
    },
    {
      slug: "mistral/ministral-14b",
      providers: [
        {
          provider: "mistral",
          providerModelId: "ministral-14b-latest",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "mistral/ministral-3b",
      providers: [
        {
          provider: "mistral",
          providerModelId: "ministral-3b-latest",
          contextWindowTokens: 131072,
        },
      ],
    },
    {
      slug: "mistral/ministral-8b",
      providers: [
        {
          provider: "mistral",
          providerModelId: "ministral-8b-latest",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "mistral/mistral-large-3",
      providers: [
        {
          provider: "mistral",
          providerModelId: "mistral-large-latest",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "mistral/mistral-large-4",
      providers: [
        { provider: "mistral", providerModelId: "mistral-large-4", contextWindowTokens: 1048576 },
      ],
    },
    {
      slug: "mistral/mistral-medium-3.5",
      providers: [
        { provider: "mistral", providerModelId: "mistral-medium-3-5", contextWindowTokens: 262144 },
      ],
    },
    {
      slug: "mistral/mistral-nemo",
      providers: [
        {
          provider: "deepinfra",
          providerModelId: "mistralai/Mistral-Nemo-Instruct-2407",
          contextWindowTokens: 131072,
        },
      ],
    },
    {
      slug: "mistral/mistral-small",
      providers: [
        {
          provider: "mistral",
          providerModelId: "mistral-small-latest",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "mistral/voxtral-mini-transcribe-3",
      providers: [
        {
          provider: "mistral",
          providerModelId: "voxtral-mini-transcribe-3-0",
          contextWindowTokens: 65536,
        },
      ],
    },
    {
      slug: "mistral/voxtral-mini-tts-3",
      providers: [
        { provider: "mistral", providerModelId: "voxtral-mini-tts-3-0", contextWindowTokens: 4096 },
      ],
    },
    {
      slug: "mistral/voxtral-small-transcribe-3",
      providers: [
        {
          provider: "mistral",
          providerModelId: "voxtral-small-transcribe-3-0",
          contextWindowTokens: 65536,
        },
      ],
    },
    {
      slug: "mixedbread/toast-1",
      providers: [
        { provider: "mixedbread", providerModelId: "toast-1", contextWindowTokens: 131000 },
      ],
    },
    {
      slug: "moonshotai/kimi-k2",
      providers: [
        {
          provider: "novita",
          providerModelId: "moonshotai/kimi-k2-instruct",
          contextWindowTokens: 131072,
        },
      ],
    },
    {
      slug: "moonshotai/kimi-k2.5",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "moonshotai.kimi-k2.5",
          contextWindowTokens: 256000,
        },
        {
          provider: "novita",
          providerModelId: "moonshotai/kimi-k2.5",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "moonshotai/kimi-k2.6",
      providers: [
        { provider: "moonshotai", providerModelId: "kimi-k2.6", contextWindowTokens: 262000 },
        {
          provider: "novita",
          providerModelId: "moonshotai/kimi-k2.6",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "moonshotai/kimi-k2.7-code",
      providers: [
        { provider: "moonshotai", providerModelId: "kimi-k2.7-code", contextWindowTokens: 256000 },
      ],
    },
    {
      slug: "moonshotai/kimi-k2.7-code-highspeed",
      providers: [
        {
          provider: "moonshotai",
          providerModelId: "kimi-k2.7-code-highspeed",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "moonshotai/kimi-k3",
      providers: [
        { provider: "alibaba", providerModelId: "kimi-k3", contextWindowTokens: 1000000 },
        {
          provider: "baseten",
          providerModelId: "moonshotai/Kimi-K3",
          contextWindowTokens: 1000000,
        },
        {
          provider: "bedrock",
          providerModelId: "global.moonshotai.kimi-k3",
          contextWindowTokens: 1000000,
        },
        { provider: "boundless", providerModelId: "kimi-k3", contextWindowTokens: 1000000 },
        {
          provider: "deepinfra",
          providerModelId: "moonshotai/Kimi-K3",
          contextWindowTokens: 1048576,
        },
        { provider: "digitalocean", providerModelId: "kimi-k3", contextWindowTokens: 1000000 },
        {
          provider: "fireworks",
          providerModelId: "accounts/fireworks/models/kimi-k3",
          contextWindowTokens: 1000000,
        },
        {
          provider: "inference-net",
          providerModelId: "moonshotai/kimi-k3",
          contextWindowTokens: 1048576,
        },
        {
          provider: "modal",
          providerModelId: "vercelaigateway--ep-kimi-k3-server.us-west.modal.direct",
          contextWindowTokens: 1000000,
        },
        { provider: "moonshotai", providerModelId: "kimi-k3", contextWindowTokens: 1000000 },
        { provider: "morph", providerModelId: "morph-kimik3", contextWindowTokens: 1000000 },
        { provider: "nebius", providerModelId: "moonshotai/Kimi-K3", contextWindowTokens: 1024000 },
        { provider: "parasail", providerModelId: "parasail-kimi-k3", contextWindowTokens: 1000000 },
        { provider: "relace", providerModelId: "moonshotai/kimi-k3", contextWindowTokens: 1048576 },
        {
          provider: "runware",
          providerModelId: "moonshotai:kimi@k3",
          contextWindowTokens: 1048576,
        },
        {
          provider: "sail-research",
          providerModelId: "moonshotai/Kimi-K3",
          contextWindowTokens: 1048576,
        },
        {
          provider: "togetherai",
          providerModelId: "moonshotai/Kimi-K3",
          contextWindowTokens: 1000000,
        },
        { provider: "wafer", providerModelId: "kimi-k3", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "moonshotai/kimi-k3-fast",
      providers: [
        {
          provider: "fireworks",
          providerModelId: "accounts/fireworks/routers/kimi-k3-fast",
          contextWindowTokens: 1000000,
        },
        { provider: "morph", providerModelId: "morph-kimik3-fast", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "moonshotai/kimi-k3.1-pro",
      providers: [
        { provider: "alibaba", providerModelId: "kimi-k3.1-pro", contextWindowTokens: 1048576 },
        {
          provider: "baseten",
          providerModelId: "moonshotai/Kimi-K3.1-Pro",
          contextWindowTokens: 1000000,
        },
        {
          provider: "boundless",
          providerModelId: "moonshotai/kimi-k3.1-pro",
          contextWindowTokens: 1048576,
        },
        {
          provider: "deepinfra",
          providerModelId: "moonshotai/Kimi-K3.1-Pro",
          contextWindowTokens: 1048576,
        },
        {
          provider: "digitalocean",
          providerModelId: "kimi-k3.1-pro",
          contextWindowTokens: 1048576,
        },
        {
          provider: "fireworks",
          providerModelId: "accounts/fireworks/models/kimi-k3p1-pro",
          contextWindowTokens: 1048576,
        },
        {
          provider: "inference-net",
          providerModelId: "moonshotai/kimi-k3.1-pro",
          contextWindowTokens: 1048576,
        },
        {
          provider: "modal",
          providerModelId: "vercelaigateway--ep-kimi-k3-1-pro-server.us-west.modal.direct",
          contextWindowTokens: 1048576,
        },
        { provider: "moonshotai", providerModelId: "kimi-k3.1-pro", contextWindowTokens: 1048576 },
        { provider: "morph", providerModelId: "morph-kimik31", contextWindowTokens: 1048576 },
        {
          provider: "nebius",
          providerModelId: "moonshotai/Kimi-K3.1-Pro",
          contextWindowTokens: 1048576,
        },
        {
          provider: "parasail",
          providerModelId: "moonshotai/Kimi-K3.1-Pro",
          contextWindowTokens: 1048576,
        },
        {
          provider: "pareto",
          providerModelId: "moonshotai/kimi-k3.1-pro",
          contextWindowTokens: 1048576,
        },
        {
          provider: "relace",
          providerModelId: "moonshotai/kimi-k3.1-pro",
          contextWindowTokens: 1048576,
        },
        {
          provider: "runware",
          providerModelId: "moonshotai:kimi@k3.1-pro",
          contextWindowTokens: 1048576,
        },
        {
          provider: "togetherai",
          providerModelId: "moonshotai/Kimi-K3.1-Pro",
          contextWindowTokens: 1048576,
        },
        { provider: "wafer", providerModelId: "Kimi-K3.1-Pro", contextWindowTokens: 1048576 },
      ],
    },
    {
      slug: "moonshotai/kimi-k3.1-pro-highspeed",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "global.moonshotai.kimi-k3.1",
          contextWindowTokens: 1048576,
        },
        {
          provider: "moonshotai",
          providerModelId: "kimi-k3.1-pro-highspeed",
          contextWindowTokens: 1048576,
        },
      ],
    },
    {
      slug: "morph/morph-v3-fast",
      providers: [
        { provider: "morph", providerModelId: "morph-v3-fast", contextWindowTokens: 81920 },
      ],
    },
    {
      slug: "morph/morph-v3-large",
      providers: [
        { provider: "morph", providerModelId: "morph-v3-large", contextWindowTokens: 81920 },
      ],
    },
    {
      slug: "nace-ai/drex-max-finance",
      providers: [
        { provider: "nace-ai", providerModelId: "drex-max-finance", contextWindowTokens: 262144 },
      ],
    },
    {
      slug: "nace-ai/drex-max-v1.1",
      providers: [
        { provider: "nace-ai", providerModelId: "drex-max-v1.1", contextWindowTokens: 262144 },
      ],
    },
    {
      slug: "nace-ai/drex-v2.0",
      providers: [
        { provider: "nace-ai", providerModelId: "drex-v2.0", contextWindowTokens: 262144 },
      ],
    },
    {
      slug: "nvidia/nemotron-3-super-120b-a12b",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "nvidia.nemotron-super-3-120b",
          contextWindowTokens: 256000,
        },
      ],
    },
    {
      slug: "nvidia/nemotron-3-ultra-550b-a55b",
      providers: [
        {
          provider: "baseten",
          providerModelId: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
          contextWindowTokens: 1000000,
        },
        {
          provider: "deepinfra",
          providerModelId: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "nvidia/nemotron-3.5-lightning",
      providers: [
        {
          provider: "deepinfra",
          providerModelId: "nvidia/NVIDIA-Nemotron-3.5-Lightning",
          contextWindowTokens: 262144,
        },
        {
          provider: "runinfra",
          providerModelId: "nemotron-3-5-lightning-30b",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "nvidia/nemotron-3.5-lightning-free",
      providers: [
        {
          provider: "nvidia",
          providerModelId: "private/nemotron-3.5-lightning-30b-a3b",
          contextWindowTokens: 1000000,
        },
      ],
    },
    {
      slug: "nvidia/nemotron-3.5-super-vl",
      providers: [
        {
          provider: "baseten",
          providerModelId: "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B",
          contextWindowTokens: 1048576,
        },
        {
          provider: "deepinfra",
          providerModelId: "nvidia/NVIDIA-Nemotron-3.5-Super-VL",
          contextWindowTokens: 262144,
        },
        {
          provider: "togetherai",
          providerModelId: "nvidia/NVIDIA-Nemotron-3.5-Super-VL",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "nvidia/nemotron-nano-12b-v2-vl",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "nvidia.nemotron-nano-12b-v2",
          contextWindowTokens: 131072,
        },
      ],
    },
    {
      slug: "nvidia/nemotron-nano-9b-v2",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "nvidia.nemotron-nano-9b-v2",
          contextWindowTokens: 131072,
        },
      ],
    },
    {
      slug: "openai/gpt-4.1",
      providers: [
        { provider: "azure", providerModelId: "gpt-4.1", contextWindowTokens: 1047576 },
        { provider: "openai", providerModelId: "gpt-4.1", contextWindowTokens: 1047576 },
      ],
    },
    {
      slug: "openai/gpt-4.1-fast",
      providers: [{ provider: "openai", providerModelId: "gpt-4.1", contextWindowTokens: 1047576 }],
    },
    {
      slug: "openai/gpt-4.1-mini",
      providers: [
        { provider: "azure", providerModelId: "gpt-4.1-mini", contextWindowTokens: 1047576 },
        { provider: "openai", providerModelId: "gpt-4.1-mini", contextWindowTokens: 1047576 },
      ],
    },
    {
      slug: "openai/gpt-4.1-mini-fast",
      providers: [
        { provider: "openai", providerModelId: "gpt-4.1-mini", contextWindowTokens: 1047576 },
      ],
    },
    {
      slug: "openai/gpt-4.1-nano",
      providers: [
        { provider: "azure", providerModelId: "gpt-4.1-nano", contextWindowTokens: 1047576 },
      ],
    },
    {
      slug: "openai/gpt-4o",
      providers: [
        { provider: "azure", providerModelId: "gpt-4o", contextWindowTokens: 128000 },
        { provider: "openai", providerModelId: "gpt-4o", contextWindowTokens: 128000 },
      ],
    },
    {
      slug: "openai/gpt-4o-fast",
      providers: [{ provider: "openai", providerModelId: "gpt-4o", contextWindowTokens: 128000 }],
    },
    {
      slug: "openai/gpt-4o-mini",
      providers: [
        { provider: "azure", providerModelId: "gpt-4o-mini", contextWindowTokens: 128000 },
        { provider: "openai", providerModelId: "gpt-4o-mini", contextWindowTokens: 128000 },
      ],
    },
    {
      slug: "openai/gpt-4o-mini-fast",
      providers: [
        { provider: "openai", providerModelId: "gpt-4o-mini", contextWindowTokens: 128000 },
      ],
    },
    {
      slug: "openai/gpt-5",
      providers: [
        { provider: "azure", providerModelId: "gpt-5", contextWindowTokens: 400000 },
        { provider: "openai", providerModelId: "gpt-5-2025-08-07", contextWindowTokens: 400000 },
      ],
    },
    {
      slug: "openai/gpt-5-codex",
      providers: [
        { provider: "azure", providerModelId: "gpt-5-codex", contextWindowTokens: 400000 },
      ],
    },
    {
      slug: "openai/gpt-5-fast",
      providers: [
        { provider: "openai", providerModelId: "gpt-5-2025-08-07", contextWindowTokens: 400000 },
      ],
    },
    {
      slug: "openai/gpt-5-mini",
      providers: [
        { provider: "azure", providerModelId: "gpt-5-mini", contextWindowTokens: 400000 },
        {
          provider: "openai",
          providerModelId: "gpt-5-mini-2025-08-07",
          contextWindowTokens: 400000,
        },
      ],
    },
    {
      slug: "openai/gpt-5-mini-fast",
      providers: [
        {
          provider: "openai",
          providerModelId: "gpt-5-mini-2025-08-07",
          contextWindowTokens: 400000,
        },
      ],
    },
    {
      slug: "openai/gpt-5-nano",
      providers: [
        { provider: "azure", providerModelId: "gpt-5-nano", contextWindowTokens: 400000 },
        {
          provider: "openai",
          providerModelId: "gpt-5-nano-2025-08-07",
          contextWindowTokens: 400000,
        },
      ],
    },
    {
      slug: "openai/gpt-5-pro",
      providers: [
        { provider: "openai", providerModelId: "gpt-5-pro", contextWindowTokens: 400000 },
      ],
    },
    {
      slug: "openai/gpt-5.1-codex",
      providers: [
        { provider: "azure", providerModelId: "gpt-5.1-codex", contextWindowTokens: 400000 },
      ],
    },
    {
      slug: "openai/gpt-5.1-codex-max",
      providers: [
        { provider: "azure", providerModelId: "gpt-5.1-codex-max", contextWindowTokens: 400000 },
      ],
    },
    {
      slug: "openai/gpt-5.1-codex-mini",
      providers: [
        { provider: "azure", providerModelId: "gpt-5.1-codex-mini", contextWindowTokens: 400000 },
      ],
    },
    {
      slug: "openai/gpt-5.1-thinking",
      providers: [
        { provider: "azure", providerModelId: "gpt-5.1", contextWindowTokens: 400000 },
        { provider: "openai", providerModelId: "gpt-5.1", contextWindowTokens: 400000 },
      ],
    },
    {
      slug: "openai/gpt-5.1-thinking-fast",
      providers: [{ provider: "openai", providerModelId: "gpt-5.1", contextWindowTokens: 400000 }],
    },
    {
      slug: "openai/gpt-5.2",
      providers: [
        { provider: "azure", providerModelId: "gpt-5.2", contextWindowTokens: 400000 },
        { provider: "openai", providerModelId: "gpt-5.2", contextWindowTokens: 400000 },
      ],
    },
    {
      slug: "openai/gpt-5.2-codex",
      providers: [
        { provider: "azure", providerModelId: "gpt-5.2-codex", contextWindowTokens: 400000 },
      ],
    },
    {
      slug: "openai/gpt-5.2-fast",
      providers: [{ provider: "openai", providerModelId: "gpt-5.2", contextWindowTokens: 400000 }],
    },
    {
      slug: "openai/gpt-5.2-pro",
      providers: [
        { provider: "openai", providerModelId: "gpt-5.2-pro", contextWindowTokens: 400000 },
      ],
    },
    {
      slug: "openai/gpt-5.3-codex",
      providers: [
        { provider: "azure", providerModelId: "gpt-5.3-codex", contextWindowTokens: 400000 },
        { provider: "openai", providerModelId: "gpt-5.3-codex", contextWindowTokens: 400000 },
      ],
    },
    {
      slug: "openai/gpt-5.3-codex-fast",
      providers: [
        { provider: "openai", providerModelId: "gpt-5.3-codex", contextWindowTokens: 400000 },
      ],
    },
    {
      slug: "openai/gpt-5.4",
      providers: [
        { provider: "azure", providerModelId: "gpt-5.4", contextWindowTokens: 1000000 },
        { provider: "openai", providerModelId: "gpt-5.4", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-5.4-fast",
      providers: [{ provider: "openai", providerModelId: "gpt-5.4", contextWindowTokens: 1050000 }],
    },
    {
      slug: "openai/gpt-5.4-mini",
      providers: [
        { provider: "azure", providerModelId: "gpt-5.4-mini", contextWindowTokens: 400000 },
        { provider: "openai", providerModelId: "gpt-5.4-mini", contextWindowTokens: 400000 },
      ],
    },
    {
      slug: "openai/gpt-5.4-mini-fast",
      providers: [
        { provider: "openai", providerModelId: "gpt-5.4-mini", contextWindowTokens: 400000 },
      ],
    },
    {
      slug: "openai/gpt-5.4-nano",
      providers: [
        { provider: "azure", providerModelId: "gpt-5.4-nano", contextWindowTokens: 400000 },
        { provider: "openai", providerModelId: "gpt-5.4-nano", contextWindowTokens: 400000 },
      ],
    },
    {
      slug: "openai/gpt-5.4-pro",
      providers: [
        { provider: "azure", providerModelId: "gpt-5.4-pro", contextWindowTokens: 1000000 },
        { provider: "openai", providerModelId: "gpt-5.4-pro", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-5.5",
      providers: [
        { provider: "azure", providerModelId: "gpt-5.5", contextWindowTokens: 272000 },
        { provider: "bedrock", providerModelId: "openai.gpt-5.5", contextWindowTokens: 272000 },
        { provider: "openai", providerModelId: "gpt-5.5", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "openai/gpt-5.5-fast",
      providers: [{ provider: "openai", providerModelId: "gpt-5.5", contextWindowTokens: 1000000 }],
    },
    {
      slug: "openai/gpt-5.5-pro",
      providers: [
        { provider: "openai", providerModelId: "gpt-5.5-pro", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "openai/gpt-5.6-luna",
      providers: [
        { provider: "azure", providerModelId: "gpt-5.6-luna", contextWindowTokens: 1050000 },
        {
          provider: "bedrock",
          providerModelId: "global.openai.gpt-5.6-luna",
          contextWindowTokens: 1050000,
        },
        { provider: "openai", providerModelId: "gpt-5.6-luna", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-5.6-luna-fast",
      providers: [
        { provider: "openai", providerModelId: "gpt-5.6-luna", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-5.6-sol",
      providers: [
        { provider: "azure", providerModelId: "gpt-5.6-sol", contextWindowTokens: 1050000 },
        {
          provider: "bedrock",
          providerModelId: "global.openai.gpt-5.6-sol",
          contextWindowTokens: 1050000,
        },
        { provider: "openai", providerModelId: "gpt-5.6-sol", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-5.6-sol-fast",
      providers: [
        { provider: "openai", providerModelId: "gpt-5.6-sol", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-5.6-terra",
      providers: [
        { provider: "azure", providerModelId: "gpt-5.6-terra", contextWindowTokens: 1050000 },
        {
          provider: "bedrock",
          providerModelId: "global.openai.gpt-5.6-terra",
          contextWindowTokens: 1050000,
        },
        { provider: "openai", providerModelId: "gpt-5.6-terra", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-5.6-terra-fast",
      providers: [
        { provider: "openai", providerModelId: "gpt-5.6-terra", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-6-astra",
      providers: [
        { provider: "azure", providerModelId: "gpt-6-astra", contextWindowTokens: 1050000 },
        {
          provider: "bedrock",
          providerModelId: "global.openai.gpt-6-astra",
          contextWindowTokens: 1050000,
        },
        { provider: "openai", providerModelId: "gpt-6-astra", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-6-astra-fast",
      providers: [
        { provider: "openai", providerModelId: "gpt-6-astra", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-6-luna",
      providers: [
        { provider: "azure", providerModelId: "gpt-6-luna", contextWindowTokens: 1050000 },
        {
          provider: "bedrock",
          providerModelId: "global.openai.gpt-6-luna",
          contextWindowTokens: 1050000,
        },
        { provider: "openai", providerModelId: "gpt-6-luna", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-6-luna-decisions",
      providers: [
        { provider: "openai", providerModelId: "gpt-6-luna", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-6-luna-fast",
      providers: [
        { provider: "openai", providerModelId: "gpt-6-luna", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-6-sol",
      providers: [
        { provider: "azure", providerModelId: "gpt-6-sol", contextWindowTokens: 1050000 },
        {
          provider: "bedrock",
          providerModelId: "global.openai.gpt-6-sol",
          contextWindowTokens: 1050000,
        },
        { provider: "openai", providerModelId: "gpt-6-sol", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-6-sol-fast",
      providers: [
        { provider: "openai", providerModelId: "gpt-6-sol", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-6.1-sol",
      providers: [
        { provider: "azure", providerModelId: "gpt-6.1-sol", contextWindowTokens: 1050000 },
        {
          provider: "bedrock",
          providerModelId: "global.openai.gpt-6.1-sol",
          contextWindowTokens: 1050000,
        },
        { provider: "openai", providerModelId: "gpt-6.1-sol", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-6.1-sol-fast",
      providers: [
        { provider: "openai", providerModelId: "gpt-6.1-sol", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-6.1-terra",
      providers: [
        { provider: "azure", providerModelId: "gpt-6.1-terra", contextWindowTokens: 1050000 },
        {
          provider: "bedrock",
          providerModelId: "global.openai.gpt-6.1-terra",
          contextWindowTokens: 1050000,
        },
        { provider: "openai", providerModelId: "gpt-6.1-terra", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-6.1-terra-fast",
      providers: [
        { provider: "openai", providerModelId: "gpt-6.1-terra", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-6.2-astra",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "global.openai.gpt-6.2-astra",
          contextWindowTokens: 1050000,
        },
        { provider: "openai", providerModelId: "gpt-6.2-astra", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-6.2-astra-fast",
      providers: [
        { provider: "openai", providerModelId: "gpt-6.2-astra", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-6.2-sol",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "global.openai.gpt-6.2-sol",
          contextWindowTokens: 1050000,
        },
        { provider: "openai", providerModelId: "gpt-6.2-sol", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-6.2-sol-fast",
      providers: [
        { provider: "openai", providerModelId: "gpt-6.2-sol", contextWindowTokens: 1050000 },
      ],
    },
    {
      slug: "openai/gpt-oss-120b",
      providers: [
        {
          provider: "baseten",
          providerModelId: "openai/gpt-oss-120b",
          contextWindowTokens: 131072,
        },
        {
          provider: "bedrock",
          providerModelId: "openai.gpt-oss-120b-1:0",
          contextWindowTokens: 128000,
        },
        { provider: "cerebras", providerModelId: "gpt-oss-120b", contextWindowTokens: 131072 },
        { provider: "groq", providerModelId: "openai/gpt-oss-120b", contextWindowTokens: 131072 },
        { provider: "nebius", providerModelId: "openai/gpt-oss-120b", contextWindowTokens: 131000 },
        {
          provider: "parasail",
          providerModelId: "parasail-gpt-oss-120b",
          contextWindowTokens: 131072,
        },
        {
          provider: "togetherai",
          providerModelId: "openai/gpt-oss-120b",
          contextWindowTokens: 128000,
        },
      ],
    },
    {
      slug: "openai/gpt-oss-20b",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "openai.gpt-oss-20b-1:0",
          contextWindowTokens: 128000,
        },
        {
          provider: "deepinfra",
          providerModelId: "openai/gpt-oss-20b",
          contextWindowTokens: 131072,
        },
        { provider: "groq", providerModelId: "openai/gpt-oss-20b", contextWindowTokens: 131072 },
        {
          provider: "parasail",
          providerModelId: "openai/gpt-oss-20b",
          contextWindowTokens: 131072,
        },
      ],
    },
    {
      slug: "openai/gpt-oss-safeguard-120b",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "openai.gpt-oss-safeguard-120b",
          contextWindowTokens: 128000,
        },
      ],
    },
    {
      slug: "openai/gpt-oss-safeguard-20b",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "openai.gpt-oss-safeguard-20b",
          contextWindowTokens: 128000,
        },
        {
          provider: "groq",
          providerModelId: "openai/gpt-oss-safeguard-20b",
          contextWindowTokens: 131072,
        },
      ],
    },
    {
      slug: "openai/gpt-realtime-2.1",
      providers: [
        { provider: "openai", providerModelId: "gpt-realtime-2.1", contextWindowTokens: 128000 },
      ],
    },
    {
      slug: "openai/o1",
      providers: [{ provider: "azure", providerModelId: "o1", contextWindowTokens: 200000 }],
    },
    {
      slug: "openai/o3",
      providers: [{ provider: "openai", providerModelId: "o3", contextWindowTokens: 200000 }],
    },
    {
      slug: "openai/o3-fast",
      providers: [{ provider: "openai", providerModelId: "o3", contextWindowTokens: 200000 }],
    },
    {
      slug: "openai/o3-mini",
      providers: [{ provider: "azure", providerModelId: "o3-mini", contextWindowTokens: 200000 }],
    },
    {
      slug: "openai/o3-pro",
      providers: [
        { provider: "openai", providerModelId: "o3-pro-2025-06-10", contextWindowTokens: 200000 },
      ],
    },
    {
      slug: "openai/o4-mini",
      providers: [{ provider: "azure", providerModelId: "o4-mini", contextWindowTokens: 200000 }],
    },
    {
      slug: "paperinstruments/ultramarine-1-flash",
      providers: [
        {
          provider: "fireworks",
          providerModelId: "accounts/fireworks/models/ultramarine-1-flash-us",
          contextWindowTokens: 1048576,
        },
      ],
    },
    {
      slug: "parallel/parallel-decisions-fast",
      providers: [{ provider: "parallel", providerModelId: "fast", contextWindowTokens: 32000 }],
    },
    {
      slug: "particle/particle-1",
      providers: [
        { provider: "particle", providerModelId: "particle-1", contextWindowTokens: 1048576 },
      ],
    },
    {
      slug: "perplexity/pplx-decider-flash-v1.2",
      providers: [
        {
          provider: "perplexity",
          providerModelId: "pplx-decider-flash-v1.2",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "perplexity/pplx-decider-flash-v1.3",
      providers: [
        {
          provider: "perplexity",
          providerModelId: "pplx-decider-flash-v1.3",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "perplexity/pplx-decider-v1.2",
      providers: [
        {
          provider: "perplexity",
          providerModelId: "pplx-decider-v1.2",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "perplexity/pplx-decider-v1.3",
      providers: [
        {
          provider: "perplexity",
          providerModelId: "pplx-decider-v1.3",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "perplexity/pplx-embed-v1-0.6b",
      providers: [
        {
          provider: "perplexity",
          providerModelId: "pplx-embed-v1-0.6b",
          contextWindowTokens: 32000,
        },
      ],
    },
    {
      slug: "perplexity/pplx-embed-v1-4b",
      providers: [
        { provider: "perplexity", providerModelId: "pplx-embed-v1-4b", contextWindowTokens: 32000 },
      ],
    },
    {
      slug: "perplexity/sonar",
      providers: [
        {
          provider: "perplexity",
          providerModelId: "perplexity/sonar",
          contextWindowTokens: 127000,
        },
      ],
    },
    {
      slug: "prodia/flux-fast-schnell",
      providers: [
        {
          provider: "prodia",
          providerModelId: "inference.flux-fast.schnell.txt2img.v2",
          contextWindowTokens: 512,
        },
      ],
    },
    {
      slug: "quiverai/arrow-2",
      providers: [
        { provider: "quiverai", providerModelId: "arrow-2", contextWindowTokens: 131072 },
      ],
    },
    {
      slug: "quiverai/arrow-2-telos",
      providers: [
        { provider: "quiverai", providerModelId: "arrow-2-telos", contextWindowTokens: 131072 },
      ],
    },
    {
      slug: "recursive/flint-v1.0",
      providers: [
        {
          provider: "recursive",
          providerModelId: "RecursiveSI/flint",
          contextWindowTokens: 262144,
        },
      ],
    },
    {
      slug: "reflection/beam",
      providers: [
        {
          provider: "baseten",
          providerModelId: "reflection/Beam-1.0",
          contextWindowTokens: 1048576,
        },
        { provider: "nebius", providerModelId: "reflection/beam", contextWindowTokens: 1048576 },
        {
          provider: "reflection",
          providerModelId: "Beam-1.0-501B-A23B",
          contextWindowTokens: 1048576,
        },
        {
          provider: "togetherai",
          providerModelId: "reflection/Beam-1.0-501B-A23B",
          contextWindowTokens: 1048576,
        },
      ],
    },
    {
      slug: "reflection/beam-free",
      providers: [
        {
          provider: "reflection",
          providerModelId: "Beam-1.0-501B-A23B",
          contextWindowTokens: 1048576,
        },
      ],
    },
    {
      slug: "sakana/fugu-max",
      providers: [
        { provider: "sakana", providerModelId: "fugu-max-v1.0", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "sakana/fugu-ultra",
      providers: [
        { provider: "sakana", providerModelId: "fugu-ultra", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "sakana/fugu-ultra-v2",
      providers: [
        { provider: "sakana", providerModelId: "fugu-ultra-v2.0", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "sakana/namazu",
      providers: [
        { provider: "sakana", providerModelId: "sakana-namazu", contextWindowTokens: 256000 },
      ],
    },
    {
      slug: "scaledown/scaledown-extract-1",
      providers: [
        { provider: "scaledown", providerModelId: "extract-1", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "scaledown/scaledown-summarize-1",
      providers: [
        { provider: "scaledown", providerModelId: "summarize-1", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "spacexai/grok-4.20-multi-agent",
      providers: [
        {
          provider: "xai",
          providerModelId: "grok-4.20-multi-agent-0309",
          contextWindowTokens: 2000000,
        },
      ],
    },
    {
      slug: "spacexai/grok-4.20-multi-agent-beta",
      providers: [
        {
          provider: "xai",
          providerModelId: "grok-4.20-multi-agent-beta-0309",
          contextWindowTokens: 2000000,
        },
      ],
    },
    {
      slug: "spacexai/grok-4.20-non-reasoning",
      providers: [
        {
          provider: "vertex",
          providerModelId: "xai/grok-4.20-non-reasoning",
          contextWindowTokens: 2000000,
        },
        {
          provider: "xai",
          providerModelId: "grok-4.20-0309-non-reasoning",
          contextWindowTokens: 2000000,
        },
      ],
    },
    {
      slug: "spacexai/grok-4.20-non-reasoning-beta",
      providers: [
        {
          provider: "xai",
          providerModelId: "grok-4.20-beta-0309-non-reasoning",
          contextWindowTokens: 2000000,
        },
      ],
    },
    {
      slug: "spacexai/grok-4.20-reasoning",
      providers: [
        {
          provider: "vertex",
          providerModelId: "xai/grok-4.20-reasoning",
          contextWindowTokens: 2000000,
        },
        {
          provider: "xai",
          providerModelId: "grok-4.20-0309-reasoning",
          contextWindowTokens: 2000000,
        },
      ],
    },
    {
      slug: "spacexai/grok-4.20-reasoning-beta",
      providers: [
        {
          provider: "xai",
          providerModelId: "grok-4.20-beta-0309-reasoning",
          contextWindowTokens: 2000000,
        },
      ],
    },
    {
      slug: "spacexai/grok-4.3",
      providers: [
        { provider: "vertex", providerModelId: "xai/grok-4.3", contextWindowTokens: 1000000 },
        { provider: "xai", providerModelId: "grok-4.3", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "spacexai/grok-4.5",
      providers: [{ provider: "xai", providerModelId: "grok-4.5", contextWindowTokens: 500000 }],
    },
    {
      slug: "spacexai/grok-4.6",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "global.xai.grok-4.6",
          contextWindowTokens: 500000,
        },
        { provider: "xai", providerModelId: "grok-4.6", contextWindowTokens: 500000 },
      ],
    },
    {
      slug: "spacexai/grok-4.7",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "global.xai.grok-4.7",
          contextWindowTokens: 524288,
        },
        { provider: "vertex", providerModelId: "xai/grok-4.7", contextWindowTokens: 524288 },
        { provider: "xai", providerModelId: "grok-4.7", contextWindowTokens: 500000 },
      ],
    },
    {
      slug: "spacexai/grok-build-0.1",
      providers: [
        { provider: "xai", providerModelId: "grok-build-0.1", contextWindowTokens: 256000 },
      ],
    },
    {
      slug: "stealth/glyph-cluster",
      providers: [
        {
          provider: "stealth",
          providerModelId: "stealth/glyph-cluster",
          contextWindowTokens: 256000,
        },
      ],
    },
    {
      slug: "stepfun/step-3.7-flash",
      providers: [
        { provider: "stepfun", providerModelId: "step-3.7-flash", contextWindowTokens: 256000 },
      ],
    },
    {
      slug: "stepfun/step-5-preview",
      providers: [
        { provider: "stepfun", providerModelId: "step-5-preview", contextWindowTokens: 1000000 },
        { provider: "tencent", providerModelId: "step-5-preview", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "tencent/hy-mt2-lite",
      providers: [
        { provider: "tencent", providerModelId: "hy-mt2-lite", contextWindowTokens: 8000 },
      ],
    },
    {
      slug: "tencent/hy-mt2-plus",
      providers: [
        { provider: "tencent", providerModelId: "hy-mt2-plus", contextWindowTokens: 8000 },
      ],
    },
    {
      slug: "tencent/hy-mt2-pro",
      providers: [
        { provider: "tencent", providerModelId: "hy-mt2-pro", contextWindowTokens: 8000 },
      ],
    },
    {
      slug: "tencent/hy3",
      providers: [
        { provider: "gmicloud", providerModelId: "tencent/Hy3", contextWindowTokens: 262144 },
        { provider: "novita", providerModelId: "tencent/hy3", contextWindowTokens: 262144 },
        { provider: "tencent", providerModelId: "hy3", contextWindowTokens: 256000 },
      ],
    },
    {
      slug: "tencent/hy4",
      providers: [{ provider: "tencent", providerModelId: "hy4", contextWindowTokens: 1024000 }],
    },
    {
      slug: "tencent/hy4-flash",
      providers: [
        { provider: "tencent", providerModelId: "hy4-flash", contextWindowTokens: 1024000 },
      ],
    },
    {
      slug: "tencent/hy4-preview",
      providers: [
        { provider: "tencent", providerModelId: "hy4-preview", contextWindowTokens: 1024000 },
      ],
    },
    {
      slug: "thinkingmachines/inkling",
      providers: [
        {
          provider: "modal",
          providerModelId: "vercelaigateway--ep-inkling-nvfp4-server.us-west.modal.direct",
          contextWindowTokens: 262144,
        },
        {
          provider: "thinkingmachines",
          providerModelId: "thinkingmachines/Inkling:peft:262144:sampling-nvfp4",
          contextWindowTokens: 256000,
        },
        {
          provider: "togetherai",
          providerModelId: "thinkingmachines/inkling",
          contextWindowTokens: 256000,
        },
      ],
    },
    {
      slug: "thinkingmachines/inkling-2-small",
      providers: [
        {
          provider: "deepinfra",
          providerModelId: "thinkingmachines/Inkling-2-Small",
          contextWindowTokens: 262144,
        },
        {
          provider: "modal",
          providerModelId: "vercelaigateway--ep-inkling-2-small-server.us-west.modal.direct",
          contextWindowTokens: 1048576,
        },
        {
          provider: "nebius",
          providerModelId: "thinkingmachines/Inkling-2-Small",
          contextWindowTokens: 1048576,
        },
        {
          provider: "togetherai",
          providerModelId: "thinkingmachines/Inkling-2-Small",
          contextWindowTokens: 1048576,
        },
      ],
    },
    {
      slug: "thinkingmachines/inkling-small",
      providers: [
        {
          provider: "deepinfra",
          providerModelId: "thinkingmachines/Inkling-Small",
          contextWindowTokens: 1000000,
        },
        {
          provider: "thinkingmachines",
          providerModelId: "thinkingmachines/Inkling-Small:peft:262144:sampling-nvfp4",
          contextWindowTokens: 64000,
        },
      ],
    },
    {
      slug: "typesafe-ai/jev",
      providers: [
        {
          provider: "digitalocean",
          providerModelId: "typesafe-jev-1.13.0",
          contextWindowTokens: 32000,
        },
      ],
    },
    {
      slug: "typesafe-ai/jev-1.13.0",
      providers: [
        { provider: "typesafe-ai", providerModelId: "jev-1.13.0", contextWindowTokens: 32000 },
      ],
    },
    {
      slug: "typesafe-ai/jev-1.14.0",
      providers: [
        { provider: "typesafe-ai", providerModelId: "jev-1.14.0", contextWindowTokens: 32000 },
      ],
    },
    {
      slug: "voyage/rerank-2.5",
      providers: [
        { provider: "voyage", providerModelId: "rerank-2.5", contextWindowTokens: 32000 },
      ],
    },
    {
      slug: "voyage/rerank-2.5-lite",
      providers: [
        { provider: "voyage", providerModelId: "rerank-2.5-lite", contextWindowTokens: 32000 },
      ],
    },
    {
      slug: "voyage/rerank-3",
      providers: [{ provider: "voyage", providerModelId: "rerank-3", contextWindowTokens: 32000 }],
    },
    {
      slug: "voyage/rerank-3-lite",
      providers: [
        { provider: "voyage", providerModelId: "rerank-3-lite", contextWindowTokens: 32000 },
      ],
    },
    {
      slug: "voyage/voyage-4",
      providers: [{ provider: "voyage", providerModelId: "voyage-4", contextWindowTokens: 32000 }],
    },
    {
      slug: "voyage/voyage-4-large",
      providers: [
        { provider: "voyage", providerModelId: "voyage-4-large", contextWindowTokens: 32000 },
      ],
    },
    {
      slug: "voyage/voyage-4-lite",
      providers: [
        { provider: "voyage", providerModelId: "voyage-4-lite", contextWindowTokens: 32000 },
      ],
    },
    {
      slug: "xai/grok-4.20-multi-agent",
      providers: [
        {
          provider: "xai",
          providerModelId: "grok-4.20-multi-agent-0309",
          contextWindowTokens: 2000000,
        },
      ],
    },
    {
      slug: "xai/grok-4.20-multi-agent-beta",
      providers: [
        {
          provider: "xai",
          providerModelId: "grok-4.20-multi-agent-beta-0309",
          contextWindowTokens: 2000000,
        },
      ],
    },
    {
      slug: "xai/grok-4.20-non-reasoning",
      providers: [
        {
          provider: "vertex",
          providerModelId: "xai/grok-4.20-non-reasoning",
          contextWindowTokens: 2000000,
        },
        {
          provider: "xai",
          providerModelId: "grok-4.20-0309-non-reasoning",
          contextWindowTokens: 2000000,
        },
      ],
    },
    {
      slug: "xai/grok-4.20-non-reasoning-beta",
      providers: [
        {
          provider: "xai",
          providerModelId: "grok-4.20-beta-0309-non-reasoning",
          contextWindowTokens: 2000000,
        },
      ],
    },
    {
      slug: "xai/grok-4.20-reasoning",
      providers: [
        {
          provider: "vertex",
          providerModelId: "xai/grok-4.20-reasoning",
          contextWindowTokens: 2000000,
        },
        {
          provider: "xai",
          providerModelId: "grok-4.20-0309-reasoning",
          contextWindowTokens: 2000000,
        },
      ],
    },
    {
      slug: "xai/grok-4.20-reasoning-beta",
      providers: [
        {
          provider: "xai",
          providerModelId: "grok-4.20-beta-0309-reasoning",
          contextWindowTokens: 2000000,
        },
      ],
    },
    {
      slug: "xai/grok-4.3",
      providers: [
        { provider: "vertex", providerModelId: "xai/grok-4.3", contextWindowTokens: 1000000 },
        { provider: "xai", providerModelId: "grok-4.3", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "xai/grok-4.5",
      providers: [{ provider: "xai", providerModelId: "grok-4.5", contextWindowTokens: 500000 }],
    },
    {
      slug: "xai/grok-4.6",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "global.xai.grok-4.6",
          contextWindowTokens: 500000,
        },
        { provider: "xai", providerModelId: "grok-4.6", contextWindowTokens: 500000 },
      ],
    },
    {
      slug: "xai/grok-4.7",
      providers: [
        {
          provider: "bedrock",
          providerModelId: "global.xai.grok-4.7",
          contextWindowTokens: 524288,
        },
        { provider: "vertex", providerModelId: "xai/grok-4.7", contextWindowTokens: 524288 },
        { provider: "xai", providerModelId: "grok-4.7", contextWindowTokens: 500000 },
      ],
    },
    {
      slug: "xai/grok-build-0.1",
      providers: [
        { provider: "xai", providerModelId: "grok-build-0.1", contextWindowTokens: 256000 },
      ],
    },
    {
      slug: "xiaomi/mimo-v2.6-flash",
      providers: [
        { provider: "boundless", providerModelId: "mimo-v2.6-flash", contextWindowTokens: 1048576 },
        {
          provider: "deepinfra",
          providerModelId: "XiaomiMiMo/MiMo-V2.6-Flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "gmicloud",
          providerModelId: "XiaomiMiMo/MiMo-V2.6-Flash",
          contextWindowTokens: 1050000,
        },
        {
          provider: "inference-net",
          providerModelId: "xiaomi/mimo-v2.6-flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "novita",
          providerModelId: "xiaomimimo/mimo-v2.6-flash",
          contextWindowTokens: 1048576,
        },
        { provider: "tencent", providerModelId: "mimo-v2.6-flash", contextWindowTokens: 1000000 },
        { provider: "xiaomi", providerModelId: "mimo-v2.6-flash", contextWindowTokens: 1048576 },
      ],
    },
    {
      slug: "xiaomi/mimo-v2.6-pro",
      providers: [
        { provider: "boundless", providerModelId: "mimo-v2.6-pro", contextWindowTokens: 1048576 },
        {
          provider: "deepinfra",
          providerModelId: "XiaomiMiMo/MiMo-V2.6-Pro",
          contextWindowTokens: 1048576,
        },
        {
          provider: "gmicloud",
          providerModelId: "XiaomiMiMo/MiMo-V2.6-Pro",
          contextWindowTokens: 1050000,
        },
        {
          provider: "novita",
          providerModelId: "xiaomimimo/mimo-v2.6-pro",
          contextWindowTokens: 1048576,
        },
        { provider: "tencent", providerModelId: "mimo-v2.6-pro", contextWindowTokens: 1000000 },
        { provider: "xiaomi", providerModelId: "mimo-v2.6-pro", contextWindowTokens: 1048576 },
      ],
    },
    {
      slug: "xiaomi/mimo-v2.6-pro-ultraspeed",
      providers: [
        {
          provider: "xiaomi",
          providerModelId: "mimo-v2.6-pro-ultraspeed",
          contextWindowTokens: 1048576,
        },
      ],
    },
    {
      slug: "zai/glm-4.5",
      providers: [{ provider: "zai", providerModelId: "glm-4.5", contextWindowTokens: 128000 }],
    },
    {
      slug: "zai/glm-4.5-air",
      providers: [{ provider: "zai", providerModelId: "glm-4.5-air", contextWindowTokens: 128000 }],
    },
    {
      slug: "zai/glm-4.5v",
      providers: [
        { provider: "novita", providerModelId: "zai-org/glm-4.5v", contextWindowTokens: 65536 },
        { provider: "zai", providerModelId: "glm-4.5v", contextWindowTokens: 66000 },
      ],
    },
    {
      slug: "zai/glm-4.6",
      providers: [
        { provider: "deepinfra", providerModelId: "zai-org/GLM-4.6", contextWindowTokens: 202752 },
        { provider: "novita", providerModelId: "zai-org/glm-4.6", contextWindowTokens: 204800 },
        { provider: "zai", providerModelId: "glm-4.6", contextWindowTokens: 200000 },
      ],
    },
    {
      slug: "zai/glm-4.7",
      providers: [
        { provider: "bedrock", providerModelId: "zai.glm-4.7", contextWindowTokens: 200000 },
        { provider: "deepinfra", providerModelId: "zai-org/GLM-4.7", contextWindowTokens: 202752 },
        { provider: "novita", providerModelId: "zai-org/glm-4.7", contextWindowTokens: 204800 },
        { provider: "zai", providerModelId: "glm-4.7", contextWindowTokens: 200000 },
      ],
    },
    {
      slug: "zai/glm-4.7-flash",
      providers: [
        { provider: "bedrock", providerModelId: "zai.glm-4.7-flash", contextWindowTokens: 200000 },
        { provider: "zai", providerModelId: "glm-4.7-flash", contextWindowTokens: 200000 },
      ],
    },
    {
      slug: "zai/glm-4.7-flashx",
      providers: [
        { provider: "zai", providerModelId: "GLM-4.7-FlashX", contextWindowTokens: 200000 },
      ],
    },
    {
      slug: "zai/glm-5",
      providers: [
        { provider: "bedrock", providerModelId: "zai.glm-5", contextWindowTokens: 202800 },
        { provider: "novita", providerModelId: "zai-org/glm-5", contextWindowTokens: 202800 },
        { provider: "zai", providerModelId: "glm-5", contextWindowTokens: 202800 },
      ],
    },
    {
      slug: "zai/glm-5-turbo",
      providers: [{ provider: "zai", providerModelId: "glm-5-turbo", contextWindowTokens: 202800 }],
    },
    {
      slug: "zai/glm-5.1",
      providers: [
        { provider: "novita", providerModelId: "zai-org/glm-5.1", contextWindowTokens: 204800 },
        { provider: "zai", providerModelId: "glm-5.1", contextWindowTokens: 202800 },
      ],
    },
    {
      slug: "zai/glm-5.2",
      providers: [
        { provider: "alibaba", providerModelId: "glm-5.2", contextWindowTokens: 1000000 },
        { provider: "baseten", providerModelId: "zai-org/GLM-5.2", contextWindowTokens: 1000000 },
        { provider: "deepinfra", providerModelId: "zai-org/GLM-5.2", contextWindowTokens: 1000000 },
        { provider: "digitalocean", providerModelId: "glm-5.2", contextWindowTokens: 262144 },
        { provider: "friendli", providerModelId: "zai-org/GLM-5.2", contextWindowTokens: 1000000 },
        {
          provider: "gmicloud",
          providerModelId: "zai-org/GLM-5.2-FP8",
          contextWindowTokens: 1048576,
        },
        { provider: "inceptron", providerModelId: "zai-org/GLM-5.2", contextWindowTokens: 1000000 },
        { provider: "nebius", providerModelId: "zai-org/GLM-5.2", contextWindowTokens: 1024000 },
        { provider: "novita", providerModelId: "zai-org/glm-5.2", contextWindowTokens: 1000000 },
        { provider: "parasail", providerModelId: "zai-org/GLM-5.2", contextWindowTokens: 262144 },
        {
          provider: "runware",
          providerModelId: "zai:glm@5.2-vercel",
          contextWindowTokens: 1000000,
        },
        {
          provider: "streamlake",
          providerModelId: "ep-l9wr6k-1784102823433037573",
          contextWindowTokens: 1000000,
        },
        { provider: "tencent", providerModelId: "glm-5.2", contextWindowTokens: 1000000 },
        { provider: "togetherai", providerModelId: "zai-org/GLM-5.2", contextWindowTokens: 256000 },
        { provider: "wafer", providerModelId: "GLM-5.2", contextWindowTokens: 1000000 },
        { provider: "zai", providerModelId: "GLM-5.2", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "zai/glm-5.2-fast",
      providers: [
        {
          provider: "alibaba",
          providerModelId: "glm-5.2-fast-preview",
          contextWindowTokens: 1000000,
        },
        {
          provider: "baseten",
          providerModelId: "zai-org/GLM-5.2-Fast",
          contextWindowTokens: 1000000,
        },
      ],
    },
    {
      slug: "zai/glm-5.3",
      providers: [
        { provider: "alibaba", providerModelId: "glm-5.3", contextWindowTokens: 1000000 },
        { provider: "baseten", providerModelId: "zai-org/GLM-5.3", contextWindowTokens: 1000000 },
        {
          provider: "bedrock",
          providerModelId: "global.zai.glm-5.3",
          contextWindowTokens: 1000000,
        },
        { provider: "boundless", providerModelId: "glm-5.3", contextWindowTokens: 1048576 },
        { provider: "crusoe", providerModelId: "zai-org/GLM-5.3", contextWindowTokens: 1048576 },
        { provider: "deepinfra", providerModelId: "zai-org/GLM-5.3", contextWindowTokens: 1048576 },
        { provider: "digitalocean", providerModelId: "glm-5.3", contextWindowTokens: 1048576 },
        {
          provider: "fireworks",
          providerModelId: "accounts/fireworks/models/glm-5p3",
          contextWindowTokens: 1000000,
        },
        { provider: "friendli", providerModelId: "zai-org/GLM-5.3", contextWindowTokens: 1000000 },
        { provider: "gmicloud", providerModelId: "zai-org/GLM-5.3", contextWindowTokens: 1048576 },
        { provider: "inceptron", providerModelId: "zai-org/GLM-5.3", contextWindowTokens: 1048576 },
        { provider: "inference-net", providerModelId: "glm-5.3", contextWindowTokens: 1000000 },
        {
          provider: "modal",
          providerModelId: "vercelaigateway--ep-glm-5-3-server.us-west.modal.direct",
          contextWindowTokens: 1000000,
        },
        { provider: "morph", providerModelId: "morph-glm53-744b", contextWindowTokens: 1048576 },
        { provider: "novita", providerModelId: "zai-org/glm-5.3-p", contextWindowTokens: 1000000 },
        { provider: "parasail", providerModelId: "parasail-glm-53", contextWindowTokens: 1000000 },
        { provider: "relace", providerModelId: "z-ai/glm-5.3", contextWindowTokens: 1048576 },
        { provider: "runinfra", providerModelId: "glm-5-3", contextWindowTokens: 1048576 },
        {
          provider: "runware",
          providerModelId: "zai:glm@5.3-vercel",
          contextWindowTokens: 1048576,
        },
        {
          provider: "sail-research",
          providerModelId: "zai-org/GLM-5.3",
          contextWindowTokens: 1048576,
        },
        { provider: "streamlake", providerModelId: "GLM-5.3", contextWindowTokens: 1024000 },
        {
          provider: "subconscious",
          providerModelId: "subconscious/glm-5.3-marathon",
          contextWindowTokens: 1000000,
        },
        { provider: "telnyx", providerModelId: "zai-org/GLM-5.3", contextWindowTokens: 1048576 },
        { provider: "tencent", providerModelId: "glm-5.3", contextWindowTokens: 1000000 },
        {
          provider: "togetherai",
          providerModelId: "zai-org/GLM-5.3",
          contextWindowTokens: 1000000,
        },
        { provider: "wafer", providerModelId: "GLM-5.3", contextWindowTokens: 1048576 },
        { provider: "zai", providerModelId: "glm-5.3", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "zai/glm-5.3-fast",
      providers: [
        { provider: "alibaba", providerModelId: "glm-5.3-prime", contextWindowTokens: 1000000 },
        {
          provider: "baseten",
          providerModelId: "zai-org/GLM-5.3-Fast",
          contextWindowTokens: 1048576,
        },
      ],
    },
    {
      slug: "zai/glm-5.3-flash",
      providers: [
        {
          provider: "baseten",
          providerModelId: "zai-org/GLM-5.3-Flash",
          contextWindowTokens: 1000000,
        },
        { provider: "boundless", providerModelId: "glm-5.3-flash", contextWindowTokens: 1048576 },
        {
          provider: "deepinfra",
          providerModelId: "zai-org/GLM-5.3-Flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "digitalocean",
          providerModelId: "glm-5.3-flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "fireworks",
          providerModelId: "accounts/fireworks/models/glm-5p3-flash",
          contextWindowTokens: 1000000,
        },
        {
          provider: "friendli",
          providerModelId: "zai-org/GLM-5.3-Flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "gmicloud",
          providerModelId: "zai-org/GLM-5.3-Flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "inference-net",
          providerModelId: "glm-5.3-flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "modal",
          providerModelId: "vercelaigateway--ep-glm-5-3-flash-server.us-west.modal.direct",
          contextWindowTokens: 1000000,
        },
        { provider: "morph", providerModelId: "morph-glm53flash", contextWindowTokens: 1048576 },
        {
          provider: "nebius",
          providerModelId: "zai-org/GLM-5.3-Flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "novita",
          providerModelId: "zai-org/glm-5.3-flash",
          contextWindowTokens: 1000000,
        },
        {
          provider: "parasail",
          providerModelId: "parasail-glm-53-flash",
          contextWindowTokens: 1048576,
        },
        { provider: "pareto", providerModelId: "z-ai/glm-5.3-flash", contextWindowTokens: 1000000 },
        { provider: "particle", providerModelId: "glm-5.3-flash", contextWindowTokens: 1000000 },
        { provider: "relace", providerModelId: "z-ai/glm-5.3-flash", contextWindowTokens: 1048576 },
        {
          provider: "runinfra",
          providerModelId: "zai-org/GLM-5.3-Flash",
          contextWindowTokens: 1048576,
        },
        {
          provider: "runware",
          providerModelId: "zai:glm@5.3-flash-vercel",
          contextWindowTokens: 131072,
        },
        {
          provider: "sail-research",
          providerModelId: "zai-org/GLM-5.3-Flash",
          contextWindowTokens: 1048576,
        },
        { provider: "streamlake", providerModelId: "GLM-5.3-Flash", contextWindowTokens: 1024000 },
        {
          provider: "telnyx",
          providerModelId: "zai-org/GLM-5.3-Flash",
          contextWindowTokens: 1048576,
        },
        { provider: "tencent", providerModelId: "glm-5.3-flash", contextWindowTokens: 1000000 },
        {
          provider: "togetherai",
          providerModelId: "zai-org/GLM-5.3-Flash",
          contextWindowTokens: 1000000,
        },
        { provider: "wafer", providerModelId: "GLM-5.3-Flash", contextWindowTokens: 1000000 },
        { provider: "zai", providerModelId: "glm-5.3-flash", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "zai/glm-5.3-flashx",
      providers: [
        { provider: "zai", providerModelId: "glm-5.3-flashx", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "zai/glm-5.3-flashx-legal",
      providers: [
        { provider: "zai", providerModelId: "glm-5.3-flashx-legal", contextWindowTokens: 1000000 },
      ],
    },
    {
      slug: "zai/glm-5v-turbo",
      providers: [
        { provider: "zai", providerModelId: "glm-5v-turbo", contextWindowTokens: 200000 },
      ],
    },
  ],
  providerAliases: { blackForestLabs: "bfl" },
};
