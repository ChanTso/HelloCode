import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

export class WorkspaceBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBoundaryError";
  }
}

export class WorkspacePaths {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(root: string): Promise<WorkspacePaths> {
    const canonicalRoot = await realpath(path.resolve(root));
    const rootStat = await stat(canonicalRoot);
    if (!rootStat.isDirectory()) {
      throw new WorkspaceBoundaryError(`Workspace is not a directory: ${root}`);
    }
    return new WorkspacePaths(canonicalRoot);
  }

  async resolveExisting(inputPath: string): Promise<string> {
    const candidate = this.#resolveLexically(inputPath);
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch (error) {
      if (isMissingPathError(error)) {
        throw new WorkspaceBoundaryError(`Path does not exist: ${inputPath}`);
      }
      throw error;
    }
    this.#assertInside(canonical, inputPath);
    return canonical;
  }

  async resolveWrite(inputPath: string): Promise<string> {
    const candidate = this.#resolveLexically(inputPath);

    try {
      const targetStat = await lstat(candidate);
      if (targetStat.isSymbolicLink()) {
        throw new WorkspaceBoundaryError(
          `Refusing to write through a symbolic link: ${inputPath}`,
        );
      }
      const canonical = await realpath(candidate);
      this.#assertInside(canonical, inputPath);
      return canonical;
    } catch (error) {
      if (error instanceof WorkspaceBoundaryError) throw error;
      if (!isMissingPathError(error)) throw error;
    }

    let ancestor = path.dirname(candidate);
    while (true) {
      try {
        const canonicalAncestor = await realpath(ancestor);
        this.#assertInside(canonicalAncestor, inputPath);
        const canonicalCandidate = path.resolve(
          canonicalAncestor,
          path.relative(ancestor, candidate),
        );
        this.#assertInside(canonicalCandidate, inputPath);
        return canonicalCandidate;
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          throw new WorkspaceBoundaryError(
            `Cannot resolve a parent directory for: ${inputPath}`,
          );
        }
        ancestor = parent;
      }
    }
  }

  display(absolutePath: string): string {
    const relative = path.relative(this.root, absolutePath);
    return relative === "" ? "." : relative;
  }

  #resolveLexically(inputPath: string): string {
    if (inputPath.trim() === "") {
      throw new WorkspaceBoundaryError("Path must not be empty.");
    }
    const candidate = path.resolve(this.root, inputPath);
    this.#assertInside(candidate, inputPath);
    return candidate;
  }

  #assertInside(candidate: string, original: string): void {
    const relative = path.relative(this.root, candidate);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new WorkspaceBoundaryError(
        `Path is outside the workspace: ${original}`,
      );
    }
  }
}

export function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/").filter((segment) => segment !== "");
  const basename = path.posix.basename(normalized);
  const gitIndex = segments.lastIndexOf(".git");
  return (
    basename.startsWith(".env") ||
    basename === ".npmrc" ||
    basename === ".pypirc" ||
    basename === "credential" ||
    basename === "credentials" ||
    basename.startsWith("credentials.") ||
    basename.endsWith(".pem") ||
    basename.endsWith(".key") ||
    basename === ".netrc" ||
    ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"].includes(basename) ||
    basename.endsWith(".p12") ||
    basename.endsWith(".pfx") ||
    segments.includes(".ssh") ||
    (gitIndex !== -1 &&
      (gitIndex === segments.length - 1 || segments[gitIndex + 1] === "config"))
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
