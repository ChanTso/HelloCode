import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isSensitivePath, WorkspacePaths } from "../src/paths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("WorkspacePaths", () => {
  it("allows existing files and new files inside the workspace", async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, "inside.txt"), "ok");
    const paths = await WorkspacePaths.create(root);

    await expect(paths.resolveExisting("inside.txt")).resolves.toBe(
      path.join(paths.root, "inside.txt"),
    );
    await expect(paths.resolveWrite("new/deep/file.txt")).resolves.toBe(
      path.join(paths.root, "new/deep/file.txt"),
    );
  });

  it("rejects traversal, absolute outside paths, and same-prefix siblings", async () => {
    const { base, root } = await fixture();
    const sibling = path.join(base, "repo-other");
    await mkdir(sibling);
    await writeFile(path.join(sibling, "secret.txt"), "secret");
    const paths = await WorkspacePaths.create(root);

    await expect(
      paths.resolveExisting("../repo-other/secret.txt"),
    ).rejects.toThrow("outside the workspace");
    await expect(
      paths.resolveExisting(path.join(sibling, "secret.txt")),
    ).rejects.toThrow("outside the workspace");
    await expect(paths.resolveWrite("../repo-other/new.txt")).rejects.toThrow(
      "outside the workspace",
    );
  });

  it("rejects symlinks that escape the workspace for reads and writes", async () => {
    const { base, root } = await fixture();
    const outside = path.join(base, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(root, "escape"));
    const paths = await WorkspacePaths.create(root);

    await expect(paths.resolveExisting("escape/secret.txt")).rejects.toThrow(
      "outside the workspace",
    );
    await expect(paths.resolveWrite("escape/new.txt")).rejects.toThrow(
      "outside the workspace",
    );
  });

  it("recognizes sensitive relative paths without requiring a leading slash", () => {
    expect(isSensitivePath(".ssh")).toBe(true);
    expect(isSensitivePath(".ssh/id_ed25519")).toBe(true);
    expect(isSensitivePath(".envrc")).toBe(true);
    expect(isSensitivePath(".git/config")).toBe(true);
    expect(isSensitivePath("config/client.p12")).toBe(true);
    expect(isSensitivePath("credentials")).toBe(true);
    expect(isSensitivePath("src/id_user.ts")).toBe(false);
    expect(isSensitivePath("src/index.ts")).toBe(false);
  });
});

async function fixture(): Promise<{ base: string; root: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "hellocode-paths-"));
  temporaryDirectories.push(base);
  const root = path.join(base, "repo");
  await mkdir(root);
  return { base, root };
}
