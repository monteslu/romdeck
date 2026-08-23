# Active Bezels in Romdeck

Romdeck treats an Active Bezel as an optional installed enhancement, never as
part of the ROM. Open **Active Bezels** from the main menu to install a local
`.ab` package. Open a game's **Active Bezel** menu to inspect its automatic
match, associate a package explicitly, change its declared settings, or disable
enhancements for that game.

The entire flow is gamepad accessible. Romdeck owns package storage,
association, and preferences; the guest cannot draw over or intercept this UI.

Installed packages live under:

```text
<user-data>/active-bezels/<package-id>/<version>/<archive-sha256>.ab
```

State is recorded in `<user-data>/active-bezels.json`. The artifact identity
includes the package ID, semantic version, and archive SHA-256, so replacing a
file in place cannot silently change an installed artifact. Preferences are
keyed by game identity plus package ID and are passed to retroemu when the
session starts.

Romdeck validates the ZIP, manifest, renderer, entry path, and entry presence
before installation. It rejects traversal paths. Automatic selection requires
an exact canonical ROM SHA-256 or a declared compatible signature. A forced
association is always visibly reported as forced.

On launch Romdeck passes:

```text
--active-bezel <installed artifact>
--active-bezel-config <typed JSON>
--active-bezel-force       # only for an explicit association
```

If the package fails to initialize or traps later, retroemu falls back to the
ordinary game picture. The control channel exposes status, live setting
changes, reload, and a trusted disable command.

Package authors should use retroemu's `abtool` and
`docs/ACTIVE_BEZELS.md`; Romdeck intentionally contains no compiler or guest
SDK.
