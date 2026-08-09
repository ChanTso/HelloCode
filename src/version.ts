import { createRequire } from "node:module";

interface PackageMetadata {
  version?: unknown;
}

const metadata = createRequire(import.meta.url)(
  "../package.json",
) as PackageMetadata;

if (typeof metadata.version !== "string" || metadata.version.length === 0) {
  throw new Error("HelloCode package version is missing.");
}

export const VERSION = metadata.version;
