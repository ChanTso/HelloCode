import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspacePaths } from "../src/paths.js";
import { buildSystemPrompt } from "../src/prompt.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("buildSystemPrompt", () => {
  it("makes plan mode visible to the model", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "hellocode-prompt-"),
    );
    temporaryDirectories.push(directory);
    const paths = await WorkspacePaths.create(directory);

    const prompt = await buildSystemPrompt(paths, true);

    expect(prompt).toContain("Plan mode is active");
    expect(prompt).toContain("do not call edit_file");
  });

  it("reads only a bounded prefix of project instructions", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "hellocode-prompt-"),
    );
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, "AGENTS.md"), "x".repeat(200_000));
    const paths = await WorkspacePaths.create(directory);

    const prompt = await buildSystemPrompt(paths);

    expect(prompt).toContain("[AGENTS.md truncated by HelloCode]");
    expect(prompt.length).toBeLessThan(30_000);
  });

  it("does not load project instructions through a symlink", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "hellocode-prompt-"),
    );
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, ".env"), "TOP_SECRET=value\n");
    await symlink(".env", path.join(directory, "AGENTS.md"));
    const paths = await WorkspacePaths.create(directory);

    const prompt = await buildSystemPrompt(paths);

    expect(prompt).not.toContain("TOP_SECRET");
    expect(prompt).not.toContain("Project instructions from AGENTS.md");
  });
});
