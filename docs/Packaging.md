# Packaging

```bash
npm run pack           # unpacked directory — fastest way to test a real build
npm run dist:linux     # AppImage + .deb
npm run dist:mac       # dmg + zip
npm run dist:win       # NSIS installer + zip
```

Artifacts land in `dist/`. Verified on Linux: the AppImage boots, launches a
real game and passes `--smoke`, `--autoplay`, `--cartcheck`, `--padonly` and
`--realtheme` standalone.

---

## Four things that will bite you

Each of these produced a build that *looked* fine and failed at runtime.

### 1. Electron must be a devDependency

electron-builder refuses to package an app that lists `electron` in
`dependencies` — it only bundles production deps, and Electron is the runtime,
not app content.

That killed the old `npx romdeck` story, which needed it the other way round.
`bin/romdeck.js` now resolves Electron at runtime and prints an explanation
instead of `Cannot find module 'electron'` when it isn't there.

### 2. The player cannot run from inside app.asar

romdeck's founding decision is that every game runs in a **separate Node
process** (see [Architecture.md](Architecture.md)). Node has no idea what an
asar archive is — only Electron's patched `fs` can read one. So a packaged
build with retroemu inside `app.asar` boots perfectly and then fails on every
launch with `MODULE_NOT_FOUND`.

`resolveRetroemuCli()` rewrites `app.asar/` → `app.asar.unpacked/` for exactly
this reason, and `node_modules/**` is in `asarUnpack`.

Unpacking everything sounds wasteful and isn't: romdeck's own code is under
1 MB, and the ~400 MB of dependencies are almost entirely WASM cores and
native addons that the Node child loads directly and that must be unpacked
regardless.

### 3. Do not let electron-builder rebuild the native modules

`npmRebuild` and `nodeGypRebuild` are both `false`, deliberately.

retroemu's native modules (`@kmamal/sdl`, `native-gles`, `webgl-node`,
`node-datachannel`) load in the **player**, which is a plain Node process —
never Electron. Rebuilding them against Electron's ABI is both unnecessary and
impossible from here, since they resolve `node-addon-api` from their own tree.
Left on, the build dies in `node-gyp`.

`gamepad-node` is the one native module that *does* load in Electron main. It
is N-API, so its prebuilt binary is ABI-stable and needs no rebuild either.

### 4. Exclude build artifacts, not licences

An unfiltered build is **3.2 GB**. Two dependencies ship their build trees:
`wasmcart/ports` (2.1 GB of example games) and `retroemu/build` (632 MB of
compilation output). Neither is needed at runtime. Excluding those plus the
usual test/example directories gets it to **437 MB** unpacked, **162 MB** as an
AppImage.

Licence files are kept on purpose. romdeck is GPL-3.0 and ships MIT, zlib and
CC-BY-SA dependencies; stripping their licences to save a few hundred KB would
be a real violation, not an optimisation.

---

## Signing and notarization

**Not done — it needs credentials only the project owner has.**

- **macOS** requires an Apple Developer ID certificate, and notarization needs
  an Apple ID with an app-specific password (`APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). The hardened-runtime
  entitlements are already written — see `build/entitlements.mac.plist`, where
  each exception is justified. WASM cores need `allow-jit`, and the spawned
  player needs `disable-library-validation`; without those the signed build
  runs and then fails to load a single core.
- **Windows** needs an Authenticode certificate to avoid a SmartScreen warning.
- **Linux** needs neither.

Unsigned builds work; they just warn on first launch.

## Auto-update

Not wired. `electron-updater` needs a published release feed, so it should
follow the first real release rather than precede it.

## If the build warns about missing dependencies

A build that prints

```
cannot find path for dependency
  hsync@undefined, node-datachannel@undefined, romdev-core-fake08@undefined
```

is telling the truth: those packages are declared in `retroemu/package.json`
but not installed, so they would be **absent from the packaged app**. What
that costs:

| Missing | Breaks |
|---|---|
| `hsync` + `node-datachannel` | **Remote play** — signalling and the WebRTC transport |
| `romdev-core-fake08` | **PICO-8** carts (`.p8`, `.p8.png`) |

This is HANDOFF gotcha #3 ("retroemu needs optional native deps installed or
things fail in confusing ways") surfacing at package time. Fix it in retroemu,
not romdeck:

```bash
cd ../retroemu && npm install hsync node-datachannel romdev-core-fake08
```

Then rebuild and confirm the warning is gone — the packaged tree should
contain all three under
`resources/app.asar.unpacked/node_modules/`.

**Remote play still has no automated self-check** (`--joincheck` needs a live
host), so verify it by hand before a release.
