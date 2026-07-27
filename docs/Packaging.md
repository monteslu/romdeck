# Distribution

romdeck is a Node package. There is no installer to build, no code-signing
step, and no bundled runtime.

```bash
npx romdeck                 # run it
npm i -g romdeck && romdeck # or install it
```

That is the whole distribution story. The rest of this document explains why
it is allowed to be that short, and what the constraints are that keep it that
way.

## What actually ships

| Piece | Size | How it gets there |
|---|---|---|
| romdeck itself | 2.4 MB tarball, 5.0 MB unpacked | 92 files: JS, four bundled fonts, the default themes |
| dependency tree | ~50 MB installed | npm, current platform only |
| retroemu + cores | ~185 MB installed | npm, WASM, platform-independent |

Nothing above is an executable that romdeck built, signed, or carries. The
native code in the tree is three N-API `.node` addons, and every one arrives
as a prebuilt from its own publisher on npm.

## The rule this is downstream of

**No bundled executables.** Native code reaches a user's machine one of two
ways: as WASM built from source, or as an N-API prebuilt published by the
package that owns it. romdeck never ships a binary it compiled.

That rule is why there is no installer. An installer exists to carry a runtime
and a pile of platform binaries to a machine that has neither. npm already
does that, per-platform, with a resolver, a lockfile, and a cache. Wrapping it
in a second distribution mechanism adds a build matrix, three signing
identities, an update feed, and roughly 160 MB of browser, in exchange for
nothing romdeck needs.

## How per-platform binaries work without a build matrix

This is the mechanism the whole approach rests on, and it is npm's, not ours.

A package like `@napi-rs/canvas` declares every platform build as an
**optionalDependency**:

```
@napi-rs/canvas-linux-x64-gnu, @napi-rs/canvas-darwin-arm64,
@napi-rs/canvas-win32-x64-msvc, @napi-rs/canvas-linux-arm64-musl, …
```

Each of those packages sets `os` and `cpu` in its own manifest. npm installs
the one that matches and silently skips the other ten. On this machine that
is one 32 MB directory instead of eleven.

The consequence worth internalising: **adding a platform is not a romdeck
release.** When `@kmamal/sdl` or `@napi-rs/canvas` publishes a new prebuilt,
users on that platform get it from `npm install`. A romdeck that shipped its
own installers would need a CI runner, a build, and a release per platform to
deliver the same thing.

romdeck's three native dependencies all work this way:

| Package | Role | Distribution |
|---|---|---|
| `@kmamal/sdl` | window, input, audio | prebuilt per platform |
| `@napi-rs/canvas` | skia rasteriser for the UI | prebuilt per platform |
| `gamepad-node` | controller hotplug | N-API prebuilt, ABI-stable |

`webgl-node` (GL present) is optional at runtime: if the context cannot be
acquired, the presenter falls back to the CPU blit and the app runs unchanged.
See [Architecture.md](Architecture.md).

## A packaged build, if one is ever wanted

Some users will not want to think about Node. The answer is still not an
Electron installer.

- **A Node SEA** (single executable applications, stable since Node 22) can
  produce one file per platform from the same source, with no runtime bundled
  beyond Node itself.
- **A per-platform npm package** with romdeck as a dependency and a launcher,
  installed once, is closer to what a handheld image wants anyway.

Both are additive. Neither changes the source layout, and neither is on the
critical path, so neither has been built.

## Publishing: unblocked

Both historical blockers are cleared.

1. `dependencies.retroemu` was `file:../retroemu`, which cannot ship, because
   the published `0.4.8` predated the `--control` session contract.
   **`retroemu@0.5.0` fixed that** — the dependency is a real semver range and
   every session flag romdeck passes (`--control`, `--input-map`, `--cheats`,
   `--ff-speed`, `--no-rewind`) is in the published player.
2. `0.5.0` could not load a zipped ROM larger than roughly 80 KB: yauzl's
   inflate pipeline stalled part-way through the entry on Node 24 and the
   promise never settled, so the player exited 13 and the session never became
   ready — a launch that simply went quiet. **`retroemu@0.5.1` fixed that** and
   is published; romdeck requires `^0.5.1`.

There is nothing left blocking a publish.

## Verification

There is no build to verify, so the release gate is the check matrix, run
against the source tree that will be published:

```bash
node src/ui/main.js --smoke      --pathcheck   --padonly
node src/ui/main.js --viewcheck  --autoplay    --devcheck
node src/ui/main.js --cartcheck  --snapcheck  --joincheck
node src/ui/main.js --realtheme <theme>
node scripts/theme-conformance.mjs /tmp/es-themes
npx romdeck --smoke              # the entry point users actually hit
```

One gap to know about:

- **`npm pack` is the real payload test.** `files` in package.json decides
  what ships; `npm pack --dry-run --json` reports exactly what a user gets.
  A file that only exists in your working tree will not be there.

## Dependency gotcha that survives from the old build

retroemu declares `hsync`, `node-datachannel` and `romdev-core-fake08` but
they are easy to end up without. When they are missing:

| Missing | Breaks |
|---|---|
| `hsync` + `node-datachannel` | **Remote play** — signalling and the WebRTC transport |
| `romdev-core-fake08` | **PICO-8** carts (`.p8`, `.p8.png`) |

Both failures are silent until someone tries the feature. Fix it in retroemu:

```bash
cd ../retroemu && npm install hsync node-datachannel romdev-core-fake08
```

The old packaged build surfaced this as a `cannot find path for dependency`
warning at package time. Without a package step, nothing surfaces it, so
`--devcheck` asserts the three are resolvable.

## Signing and notarization

Not applicable. There is no romdeck-built binary to sign. Prebuilt addons are
signed, or not, by their publishers, and npm verifies package integrity
against the lockfile.

If a SEA is ever produced, macOS would need a Developer ID plus notarization
and Windows an Authenticode certificate. That is a decision for whoever
decides to produce one.
