export type PermissionMode = "default" | "plan" | "bypass";
export type PermissionKind = "read" | "write" | "shell";

export interface PermissionRequest {
  detail: string;
  kind: PermissionKind;
  sensitive?: boolean;
  tool: string;
}

export type ApprovalPrompt = (
  request: PermissionRequest,
  signal?: AbortSignal,
) => Promise<boolean>;

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

export class PermissionGate {
  readonly #ask: ApprovalPrompt | undefined;
  readonly #mode: PermissionMode;

  constructor(mode: PermissionMode, ask?: ApprovalPrompt) {
    this.#mode = mode;
    this.#ask = ask;
  }

  async authorize(
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.#mode === "bypass") return;

    if (this.#mode === "plan" && request.kind !== "read") {
      throw new PermissionDeniedError(
        `${request.tool} is disabled in plan mode.`,
      );
    }

    const needsApproval =
      request.kind === "shell" || request.sensitive === true;
    if (!needsApproval) return;

    if (this.#ask === undefined || !(await this.#ask(request, signal))) {
      throw new PermissionDeniedError(
        `Permission denied for ${request.tool}: ${request.detail}`,
      );
    }
  }
}
