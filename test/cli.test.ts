import { PassThrough, Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { VERSION } from "../src/version.js";

const originalApiKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalApiKey;
});

describe.sequential("CLI", () => {
  it("prints help without requiring an API key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const io = captureIo();

    const code = await main(["--help"], io);

    expect(code).toBe(0);
    expect(io.stdout()).toContain("Usage:");
    expect(io.stdout()).toContain("--dangerously-skip-permissions");
    expect(io.stderr()).toBe("");
  });

  it("prints the package version", async () => {
    const io = captureIo();

    const code = await main(["--version"], io);

    expect(code).toBe(0);
    expect(io.stdout()).toBe(`HelloCode ${VERSION}\n`);
  });

  it("fails clearly when the API key is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const io = captureIo();

    const code = await main(["--print", "say hello"], io);

    expect(code).toBe(2);
    expect(io.stderr()).toContain("ANTHROPIC_API_KEY is not set");
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
