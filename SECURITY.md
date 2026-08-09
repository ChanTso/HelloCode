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

## Credentials and local data

HelloCode removes `ANTHROPIC_API_KEY` from command environments. Other credentials already present in the user's environment, credential helpers, home directory, or running services may still be reachable by an approved command.

The default sensitive-file check covers common names such as `.env*`, `.npmrc`, private-key files, SSH directories, and credential files. It is a prompt trigger, not a complete secret scanner.

Session history is local and may contain prompts, source code, tool output, and complete model content blocks. POSIX session directories use mode `0700` and documents use `0600`. Use `--no-save` when local persistence is inappropriate and secure backups of your home directory separately.

## Supported versions

Security fixes are applied to the latest released version. Until the project reaches 1.0, minor releases may include necessary security-related behavior changes.
