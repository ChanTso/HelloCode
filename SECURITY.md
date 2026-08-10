# Security policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose credentials, execute commands unexpectedly, or cross a workspace boundary. Use GitHub's **Security → Report a vulnerability** flow for this repository. Include the affected version, operating system, reproduction steps, and the impact you observed.

You should receive an acknowledgement within seven days. A fix and disclosure timeline will depend on severity and whether the issue affects an upstream dependency.

## Trust model

HelloCode separates three kinds of action:

- File tools are restricted to the canonical workspace. Reads resolve the target's real path; writes also validate the nearest existing parent and reject writes through symlinks.
- Sensitive file access and shell commands require approval in the default interactive mode. Print mode denies actions that would need a prompt.
- `--dangerously-skip-permissions` bypasses approval. It is intended only for an environment you already isolate and trust.

The permission gate is not an operating-system sandbox. Once approved, `run_command` uses the current user account and can read or modify data outside the workspace. Shell syntax is intentionally not classified with a denylist because quoting, expansion, interpreters, and subprocesses make string-based policy an unreliable boundary.

File boundaries protect normal tool use against traversal and static symlink escapes. They are not a race-free isolation primitive against another process running as the same operating-system user and concurrently replacing workspace paths. Use an OS sandbox or disposable environment when the repository or model is not trusted.

## Credentials and local data

HelloCode removes these known provider variables from command environments, using case-insensitive name matching:

- `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL`
- `OPENAI_API_KEY` and `OPENAI_BASE_URL`
- `HELLOCODE_API_KEY` and `HELLOCODE_BASE_URL`
- `CLIPROXY_API_KEY` and `CLIPROXY_BASE_URL`

Other credentials already present in the user's environment, credential helpers, home directory, process table, or running services may still be reachable by an approved command. API keys are accepted through environment variables rather than command-line arguments, but environment variables are not a general secret sandbox.

The default sensitive-file check covers common names such as `.env*`, `.npmrc`, private-key files, SSH directories, and credential files. It is a prompt trigger, not a complete secret scanner.

Session history is local and may contain prompts, source code, tool output, signed or encrypted reasoning replay, and complete model content blocks. POSIX session directories use mode `0700` and documents use `0600`. The session schema stores an endpoint fingerprint rather than serializing the raw URL or API key from configuration. Transcript content is not redacted, so credentials pasted into prompts or echoed by tools can still be persisted. Use `--no-save` when local persistence is inappropriate and secure backups of your home directory separately.

## Model providers and gateways

The selected model endpoint receives the system prompt, conversation history, relevant source, and tool results. A custom gateway is therefore inside the trust boundary. Review its authentication, logging, retention, and routing policy before sending private code.

OpenAI Responses requests set `store: false` and replay model state locally. Compatible gateways may interpret or ignore that field according to their own implementation. `--no-save` affects only HelloCode's local session file; it does not control provider-side retention.

HelloCode validates custom API roots, requires HTTPS except for loopback development endpoints, and rejects embedded credentials, query strings, and fragments. It does not silently retry a request through another provider.

## Supported versions

Security fixes are applied to the latest released version. Until the project reaches 1.0, minor releases may include necessary security-related behavior changes.
