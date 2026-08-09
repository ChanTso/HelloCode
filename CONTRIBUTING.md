# Contributing

Thanks for helping improve HelloCode. The project favors focused changes that keep the core loop and dependency surface small.

For a bug, include the operating system, Node.js version, command or prompt that triggered it, expected behavior, and sanitized output. For a larger feature, open an issue first so its product value and effect on the trust model can be discussed before implementation.

## Local setup

```sh
git clone https://github.com/ChanTso/HelloCode.git
cd HelloCode
npm ci
npm run check
npm run build
```

The normal test suite is offline and must not require an API key. Add focused tests for behavior changes, especially around tool-result pairing, paths, permissions, cancellation, output limits, and session compatibility.

Before opening a pull request, run:

```sh
npm run check
npm run build
npm pack --dry-run
```

Keep commits scoped and explain the user-visible reason for the change. Pull requests should describe what changed, why it belongs in the minimal product, any security or compatibility impact, and the checks used to validate it.
