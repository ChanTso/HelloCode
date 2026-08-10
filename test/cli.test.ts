import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli.js";
import type { ModelRequest, ModelTurn } from "../src/model.js";
import { VERSION } from "../src/version.js";

const openAiConstructions = vi.hoisted(
  () => [] as Array<Record<string, unknown>>,
);
const anthropicConstructions = vi.hoisted(
  () => [] as Array<Record<string, unknown>>,
);

vi.mock("../src/anthropic.js", () => ({
  DEFAULT_ANTHROPIC_MODEL: "offline-anthropic-model",
  formatAnthropicError: () => undefined,
  AnthropicModel: class {
    constructor(options: Record<string, unknown>) {
      anthropicConstructions.push(structuredClone(options));
    }

    async createMessage(request: ModelRequest): Promise<ModelTurn> {
      request.onText?.("offline response");
      return {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "offline response" }],
        },
        stopReason: "complete",
        usage: { input: 1, cacheWrite: 0, cacheRead: 0, output: 1 },
      };
    }
  },
}));

vi.mock("../src/responses.js", () => ({
  DEFAULT_OPENAI_MODEL: "offline-openai-model",
  formatOpenAIError: () => undefined,
  OpenAIResponsesModel: class {
    constructor(options: Record<string, unknown>) {
      openAiConstructions.push(structuredClone(options));
    }

    async createMessage(request: ModelRequest): Promise<ModelTurn> {
      request.onText?.("offline response");
      return {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "offline response" }],
        },
        stopReason: "complete",
        usage: { input: 1, cacheWrite: 0, cacheRead: 0, output: 1 },
      };
    }
  },
}));

const managedEnvironment = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "HELLOCODE_API_KEY",
  "HELLOCODE_BASE_URL",
  "HELLOCODE_HOME",
  "HELLOCODE_MODEL",
  "HELLOCODE_PROVIDER",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;
const originalEnvironment = Object.fromEntries(
  managedEnvironment.map((name) => [name, process.env[name]]),
);

beforeEach(() => {
  for (const name of managedEnvironment) delete process.env[name];
  anthropicConstructions.length = 0;
  openAiConstructions.length = 0;
});

afterEach(() => {
  for (const name of managedEnvironment) {
    const value = originalEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe.sequential("CLI", () => {
  it("prints help without requiring an API key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const io = captureIo();

    const code = await main(["--help"], io);

    expect(code).toBe(0);
    expect(io.stdout()).toContain("Usage:");
    expect(io.stdout()).toContain("--provider");
    expect(io.stdout()).toContain("--base-url");
    expect(io.stdout()).toContain("--dangerously-skip-permissions");
    expect(io.stdout()).toContain("HELLOCODE_API_KEY");
    expect(io.stderr()).toBe("");
  });

  it("prints the package version", async () => {
    const io = captureIo();

    const code = await main(["--version"], io);

    expect(code).toBe(0);
    expect(io.stdout()).toBe(`HelloCode ${VERSION}\n`);
  });

  it("fails clearly when the API key is missing", async () => {
    delete process.env.HELLOCODE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.HELLOCODE_PROVIDER;
    const io = captureIo();

    const code = await main(["--print", "say hello"], io);

    expect(code).toBe(2);
    expect(io.stderr()).toContain("ANTHROPIC_API_KEY is not set");
  });

  it("uses the provider-specific OpenAI key fallback", async () => {
    const io = captureIo();

    const code = await main(
      ["--print", "--provider", "openai", "say hello"],
      io,
    );

    expect(code).toBe(2);
    expect(io.stderr()).toContain("OPENAI_API_KEY is not set");
  });

  it("prefers CLI routing options and the generic API key", async () => {
    const genericKey = "generic-key-that-must-stay-private";
    const providerKey = "provider-key-that-must-stay-private";
    const environmentUrl = "https://environment.example.test/private";
    process.env.HELLOCODE_API_KEY = genericKey;
    process.env.OPENAI_API_KEY = providerKey;
    process.env.HELLOCODE_PROVIDER = "anthropic";
    process.env.HELLOCODE_MODEL = "environment-model";
    process.env.HELLOCODE_BASE_URL = environmentUrl;
    process.env.OPENAI_BASE_URL = "https://provider.example.test/v1";
    const io = captureIo();

    const code = await main(
      [
        "--print",
        "--no-save",
        "--provider",
        "openai",
        "--model",
        "cli-model",
        "--base-url",
        "http://127.0.0.1:8317/v1/",
        "say hello",
      ],
      io,
    );

    expect(code).toBe(0);
    expect(openAiConstructions).toEqual([
      {
        apiKey: genericKey,
        baseUrl: "http://127.0.0.1:8317/v1",
        model: "cli-model",
      },
    ]);
    expect(io.stdout()).toContain("offline response");
    expect(`${io.stdout()}${io.stderr()}`).not.toContain(genericKey);
    expect(`${io.stdout()}${io.stderr()}`).not.toContain(providerKey);
    expect(`${io.stdout()}${io.stderr()}`).not.toContain(environmentUrl);
  });

  it("uses OpenAI environment defaults when CLI overrides are absent", async () => {
    const providerKey = "openai-fallback-key";
    process.env.HELLOCODE_PROVIDER = "openai";
    process.env.HELLOCODE_MODEL = "environment-model";
    process.env.HELLOCODE_BASE_URL = "https://proxy.example.test/v1/";
    process.env.OPENAI_API_KEY = providerKey;
    const io = captureIo();

    const code = await main(["--print", "--no-save", "say hello"], io);

    expect(code).toBe(0);
    expect(openAiConstructions).toEqual([
      {
        apiKey: providerKey,
        baseUrl: "https://proxy.example.test/v1",
        model: "environment-model",
      },
    ]);
    expect(`${io.stdout()}${io.stderr()}`).not.toContain(providerKey);
  });

  it("honors the selected provider's standard base URL fallback", async () => {
    process.env.ANTHROPIC_API_KEY = "anthropic-fallback-key";
    process.env.ANTHROPIC_BASE_URL = "https://anthropic-proxy.example/v1/";
    const io = captureIo();

    const code = await main(["--print", "--no-save", "say hello"], io);

    expect(code).toBe(0);
    expect(anthropicConstructions).toEqual([
      {
        apiKey: "anthropic-fallback-key",
        baseUrl: "https://anthropic-proxy.example/v1",
        model: "offline-anthropic-model",
      },
    ]);
  });

  it.each([
    ["anthropic", "ANTHROPIC_API_KEY", "OPENAI_BASE_URL"],
    ["openai", "OPENAI_API_KEY", "ANTHROPIC_BASE_URL"],
  ] as const)(
    "does not borrow another provider's base URL for %s",
    async (provider, keyName, unrelatedBaseName) => {
      process.env[keyName] = "provider-key";
      process.env[unrelatedBaseName] = "file:///private/wrong-provider";
      const io = captureIo();

      const code = await main(
        ["--print", "--no-save", "--provider", provider, "say hello"],
        io,
      );

      expect(code).toBe(0);
      const constructions =
        provider === "anthropic" ? anthropicConstructions : openAiConstructions;
      expect(constructions).toHaveLength(1);
      expect(constructions[0]).not.toHaveProperty("baseUrl");
      expect(`${io.stdout()}${io.stderr()}`).not.toContain(
        "file:///private/wrong-provider",
      );
    },
  );

  it.each([
    ["anthropic", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
    ["openai", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  ] as const)(
    "does not borrow another provider's key for %s",
    async (provider, unrelatedKey, expectedKey) => {
      const unrelatedSecret = "wrong-provider-secret";
      process.env[unrelatedKey] = unrelatedSecret;
      const io = captureIo();

      const code = await main(
        ["--print", "--provider", provider, "say hello"],
        io,
      );

      expect(code).toBe(2);
      expect(io.stderr()).toContain(`${expectedKey} is not set`);
      expect(io.stderr()).not.toContain(unrelatedSecret);
      expect(openAiConstructions).toHaveLength(0);
    },
  );

  it("rejects unknown providers during configuration", async () => {
    const io = captureIo();

    const code = await main(
      ["--print", "--provider", "mystery", "say hello"],
      io,
    );

    expect(code).toBe(2);
    expect(io.stderr()).toContain("Provider must be anthropic or openai");
  });

  it("rejects insecure remote API roots without echoing them", async () => {
    process.env.HELLOCODE_API_KEY = "test-key";
    const io = captureIo();
    const privateUrl = "http://api.example.test/v1";

    const code = await main(
      [
        "--print",
        "--provider",
        "openai",
        "--base-url",
        privateUrl,
        "say hello",
      ],
      io,
    );

    expect(code).toBe(2);
    expect(io.stderr()).toContain("must use HTTPS unless it targets loopback");
    expect(io.stderr()).not.toContain(privateUrl);
    expect(io.stderr()).not.toContain("test-key");
  });

  it("rejects credentials, query strings, and fragments in API roots", async () => {
    process.env.HELLOCODE_API_KEY = "test-key";
    const io = captureIo();
    const privateUrl = "https://user:pass@example.test/v1?token=x#private";

    const code = await main(
      ["--print", "--base-url", privateUrl, "say hello"],
      io,
    );

    expect(code).toBe(2);
    expect(io.stderr()).toContain(
      "must not contain credentials, a query, or a fragment",
    );
    expect(io.stderr()).not.toContain(privateUrl);
    expect(io.stderr()).not.toContain("test-key");
  });

  it.each(["https://example.test/v1?", "https://example.test/v1#"])(
    "rejects an empty query or fragment delimiter in %s",
    async (privateUrl) => {
      process.env.HELLOCODE_API_KEY = "test-key";
      const io = captureIo();

      const code = await main(
        ["--print", "--base-url", privateUrl, "say hello"],
        io,
      );

      expect(code).toBe(2);
      expect(io.stderr()).toContain(
        "must not contain credentials, a query, or a fragment",
      );
      expect(io.stderr()).not.toContain(privateUrl);
      expect(io.stderr()).not.toContain("test-key");
    },
  );

  it("rejects an invalid API root from the environment without echoing it", async () => {
    const privateUrl = "file:///private/provider-config";
    const privateKey = "private-environment-key";
    process.env.HELLOCODE_BASE_URL = privateUrl;
    process.env.HELLOCODE_API_KEY = privateKey;
    const io = captureIo();

    const code = await main(["--print", "say hello"], io);

    expect(code).toBe(2);
    expect(io.stderr()).toContain("must use HTTP or HTTPS");
    expect(io.stderr()).not.toContain(privateUrl);
    expect(io.stderr()).not.toContain(privateKey);
  });

  it("persists only a hashed endpoint identity at the session boundary", async () => {
    const stateDirectory = await mkdtemp(
      path.join(os.tmpdir(), "hellocode-cli-state-"),
    );
    const privateUrl = "https://proxy.example.test/private/v1";
    const privateKey = "session-boundary-secret";
    process.env.HELLOCODE_HOME = stateDirectory;
    process.env.HELLOCODE_API_KEY = privateKey;
    const io = captureIo();

    try {
      const code = await main(
        [
          "--print",
          "--provider",
          "openai",
          "--model",
          "session-model",
          "--base-url",
          privateUrl,
          "say hello",
        ],
        io,
      );
      const sessionFile = await findSessionFile(stateDirectory);
      const serialized = await readFile(sessionFile, "utf8");
      const document = JSON.parse(serialized) as {
        backend: Record<string, unknown>;
      };

      expect(code).toBe(0);
      expect(document.backend).toEqual({
        provider: "openai",
        model: "session-model",
        endpoint: expect.stringMatching(/^[a-f0-9]{16}$/u),
      });
      expect(serialized).not.toContain(privateUrl);
      expect(serialized).not.toContain(privateKey);
      expect(`${io.stdout()}${io.stderr()}`).not.toContain(privateUrl);
      expect(`${io.stdout()}${io.stderr()}`).not.toContain(privateKey);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("rejects conflicting permission modes before execution", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    const io = captureIo();

    const code = await main(
      ["--print", "--plan", "--dangerously-skip-permissions", "test"],
      io,
    );

    expect(code).toBe(2);
    expect(io.stderr()).toContain("cannot be combined");
  });

  it("rejects an empty model ID during configuration", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    const io = captureIo();

    const code = await main(["--print", "--model", "", "test"], io);

    expect(code).toBe(2);
    expect(io.stderr()).toContain("Model ID must not be empty");
  });
});

async function findSessionFile(stateDirectory: string): Promise<string> {
  const sessions = path.join(stateDirectory, "sessions");
  const workspaceDirectories = await readdir(sessions);
  const workspaceDirectory = workspaceDirectories[0];
  if (workspaceDirectory === undefined) {
    throw new Error("No workspace session directory.");
  }
  const directory = path.join(sessions, workspaceDirectory);
  const files = await readdir(directory);
  const session = files.find((name) => name.endsWith(".json"));
  if (session === undefined) throw new Error("No session file.");
  return path.join(directory, session);
}

function captureIo() {
  const output = new PassThrough();
  const error = new PassThrough();
  let stdout = "";
  let stderr = "";
  output.setEncoding("utf8");
  error.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    stdout += chunk;
  });
  error.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return {
    input: Readable.from([]),
    output,
    error,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}
