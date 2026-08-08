# Contributing

## Getting set up

```bash
npm install
npm run verify
```

`verify` runs lint, build and tests with coverage thresholds. It needs a `git` binary; nothing else.

## What good looks like here

- **Tests prove behaviour, not coverage.** A test that would not have caught a real defect is not worth the maintenance. The suite already caught three genuine bugs; that is the bar.
- **Comments explain why, never what.** The code says what it does. A comment earns its place by recording a decision, a constraint or a trap.
- **Errors say what to do next.** `no config file found (looked in …). Run "ddrop init" to create one.` beats `ENOENT`.
- **Nothing secret reaches a log.** The logger redacts by field name and value pattern, but do not rely on it: think before you log.
- **No dependencies without a strong reason.** The runtime holds credentials. Every dependency is supply-chain surface. The whole project currently has zero runtime dependencies outside its own packages, and that is worth defending.

## Changing the protocol

`@fyrlabs/dead-drop/protocol` is a wire contract between machines that may run different versions. Any change to the envelope, the frame layout or the error codes is a compatibility question first and a code question second. Bump `PROTOCOL_VERSION` and say how mixed-version peers behave.

## Changing the transport SDK

`@fyrlabs/dead-drop-transport-sdk` is compiled against by packages outside this repository. Additive changes only, unless there is a version bump and a migration note. If you add a capability, the conformance suite must gate its tests on it so existing adapters keep passing.

## Commits

Angular convention: `type(scope): subject`, imperative and lower-case. The body explains what and why, not how.

Anything that deviates from the direction in `docs/vision.md` gets an ADR in `docs/adr/` explaining what was rejected and why.

## Adding a transport

Do not add it here. Publish it as `<scope>/deaddrop-transport-<name>` and follow `docs/writing-a-transport.md`. Transports living outside this repository is the design working, not a gap in it.
