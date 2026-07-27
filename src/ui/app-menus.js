// Every feature, reachable from a menu.
//
// This is M7's menu content with the DOM removed. The rule that mattered then
// still holds: no feature may exist only in a pointer-driven surface. Under
// Electron that meant modals had to join the focus ring; here it means OS
// dialogs are gone entirely and the file browser takes their place.
//
// Mixed into App via installMenus() so app.js stays about the shell.
import { SETTINGS, BUTTONS } from './services.js';

export function installMenus(App) {
  Object.assign(App.prototype, {
    // ── main menu ────────────────────────────────────────────────────
    openMainMenu() {
      const playing = this.svc.sessions.list().length;
      this.menus.open_({
        title: 'romdeck',
        subtitle: `${this.stage.allRoms.length} games · ${playing} playing`,
        items: [
          {
            label: 'Search',
            hint: this.stage.query || 'find a game',
            action: () => {
              this.menus.closeAll();
              this.keyboard.open({
                layout: 'text',
                title: 'Search your library',
                value: this.stage.query,
                onInput: (v) => { this.stage.search(v); },
                onCommit: () => this.invalidate(),
              });
            },
          },
          { label: 'Settings', hint: 'picture, resume, rewind', action: () => this.openSettingsMenu() },
          { label: 'Controllers', hint: 'remap, ports, deadzone', action: () => this.openControllersMenu() },
          { label: 'Themes', hint: 'switch or download', action: () => this.openThemesMenu() },
          { label: 'BIOS files', action: () => this.openBiosMenu() },
          { label: 'Collections', hint: 'favorites, last played, all games', action: () => this.openCollectionsMenu() },
          { label: 'Custom collections', hint: 'your own sets of games', action: () => this.openCustomCollectionsMenu() },
          { label: 'Get box art', hint: 'scrape the library', action: () => this.doScrapeAll() },
          { label: 'Identify ROMs', hint: 'CRC match against No-Intro', action: () => this.doIdentify() },
          { label: 'Homebrew', action: () => this.openFeedMenu() },
          { label: 'Join a game', hint: 'remote play', action: () => this.openJoinMenu() },
          { label: 'Developer mode', hint: 'live memory viewer', action: () => this.openDevMenu() },
          {
            label: 'RetroAchievements',
            hint: this.svc.ra.canSubmit() ? `signed in as ${this.svc.ra.creds().username}`
              : this.svc.ra.configured() ? 'sign in to submit unlocks' : 'not configured',
            action: () => this.openAchievementsMenu(),
          },
          { label: 'Choose ROMs folder', action: () => this.openRomsFolderPicker() },
          {
            label: this.window?.fullscreen ? 'Leave fullscreen' : 'Fullscreen',
            action: () => { this.menus.closeAll(); this.toggleFullscreen(); },
          },
          { label: 'Quit romdeck', action: () => this.quit(0) },
        ],
      });
    },

    // ── per-game menu ────────────────────────────────────────────────
    openGameMenu(rom) {
      if (!rom) return;
      const live = this.svc.sessions.findByRom(rom.path);
      const caps = live?._caps ?? null;
      const can = (k) => (caps ? caps[k] !== false : true);
      const items = [];

      if (live) {
        if (can('pause')) {
          items.push({
            label: live.paused ? 'Resume' : 'Pause',
            action: async () => {
              this.menus.closeAll();
              await this.svc.sessions.rpc(live.id, live.paused ? 'resume' : 'pause').catch(() => {});
              this.invalidate();
            },
          });
        }
        if (can('saveState')) {
          items.push({
            label: 'Save state',
            action: async () => {
              this.menus.closeAll();
              const name = `save-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
              try {
                const res = await this.svc.sessions.rpc(live.id, 'saveState', {});
                this.svc.stateStore.save(rom, name, { ...res, core: live.core });
                this.toast('State saved', name);
              } catch (err) { this.toast('Save failed', err.message, { error: true }); }
            },
          });
        }
        items.push({
          label: 'Screenshot',
          action: async () => {
            this.menus.closeAll();
            try {
              const res = await this.svc.sessions.rpc(live.id, 'screenshot', {});
              const file = this.svc.saveScreenshot(rom, res.pngB64);
              this.toast('Screenshot', file);
            } catch (err) { this.toast('Screenshot failed', err.message, { error: true }); }
          },
        });
        items.push({
          label: 'Invite to play',
          hint: 'remote play',
          action: async () => {
            this.menus.closeAll();
            try {
              const res = await this.svc.sessions.rpc(live.id, 'remoteHost', {});
              this.toast('Share this code', res.code, { ms: 15000 });
            } catch (err) { this.toast('Remote play', err.message, { error: true }); }
          },
        });
        items.push({ label: 'Stop', action: () => { this.menus.closeAll(); this.svc.sessions.stop(live.id); } });
      } else {
        items.push({ label: 'Play', action: () => { this.menus.closeAll(); this.doLaunch(rom); } });
        items.push({ label: 'Play from start', action: () => { this.menus.closeAll(); this.doLaunch(rom, { resume: false }); } });
      }

      if (can('saveState')) items.push({ label: 'Save states…', action: () => this.openStatesMenu(rom) });
      if (can('cheats')) items.push({ label: 'Cheats', action: () => this.openCheatsMenu(rom) });
      const fav = rom.meta?.favorite;
      items.push({
        label: fav ? 'Remove from favorites' : 'Add to favorites',
        action: async () => {
          this.menus.closeAll();
          this.svc.gamelists.update(rom, rom.short, { favorite: fav ? null : 'true' });
          await this.refresh();
        },
      });
      if (this.svc.collections.list().length) {
        items.push({
          label: 'Collections…',
          hint: 'add to or remove from a set',
          action: () => this.openGameCollectionsMenu(rom),
        });
      }
      if (!rom.art) {
        items.push({
          label: 'Get box art',
          action: async () => {
            this.menus.closeAll();
            const status = await this.svc.artwork.scrape(rom);
            if (status === 'ok') { this.toast('Box art found', rom.name); await this.refresh(); }
            else this.toast('No art match', 'Not found in libretro-thumbnails');
          },
        });
      }
      items.push({ label: 'Game settings', hint: 'just this game', action: () => this.openSettingsMenu(rom) });

      const bits = [rom.system];
      if (rom.verified) bits.push('✓ verified');
      if (rom.meta?.playcount) bits.push(`played ${rom.meta.playcount}×`);
      this.menus.open_({ title: rom.name, subtitle: bits.join(' · '), items });
    },

    openStatesMenu(rom) {
      const list = this.svc.stateStore.list(rom);
      const live = this.svc.sessions.findByRom(rom.path);
      const items = list.length ? list.map((st) => ({
        label: st.name === 'auto' ? 'Resume point' : st.name,
        hint: st.savedAt ? new Date(st.savedAt).toLocaleString() : '',
        action: async () => {
          this.menus.closeAll();
          if (live) {
            const stored = this.svc.stateStore.load(rom, st.name);
            try {
              await this.svc.sessions.rpc(live.id, 'loadState', { stateB64: stored.stateB64 });
              this.toast('State loaded', st.name);
            } catch (err) { this.toast('Load failed', err.message, { error: true }); }
          } else {
            this.doLaunch(rom, { resume: false, stateName: st.name });
          }
        },
      })) : [{ label: 'No save states yet', disabled: true }];
      this.menus.open_({ title: 'Save states', subtitle: rom.name, items });
    },

    // ── settings, with provenance ────────────────────────────────────
    openSettingsMenu(rom = null) {
      const ctx = rom ? { platform: rom.short, gameKey: this.svc.gameKey(rom) } : {};
      const scope = rom ? `game:${this.svc.gameKey(rom)}` : 'global';
      const resolved = this.svc.settings.resolveAll(ctx);
      const items = resolved
        // Picture and Shader get their own menu below: one is a CPU filter,
        // the other a GPU preset, and to a player they are ONE question.
        // Showing both as bare enums here would be two controls that silently
        // override each other.
        .filter((s) => s.key !== 'videoFilter' && s.key !== 'shader')
        .map((s) => ({
        label: s.label,
        // Provenance stays visible — the direct answer to RetroArch's
        // config-scope trap, and the reason resolve() returns a source at all.
        hint: s.source === 'default' ? 'default' : `from ${s.source}`,
        options: s.type === 'bool'
          ? [{ value: false, label: 'Off' }, { value: true, label: 'On' }]
          : (s.options ?? []).map((o) => ({ value: o.value, label: o.label })),
        value: s.value,
        onChange: (v) => {
          this.svc.settings.set(s.key, v, scope);
          this.invalidate();
        },
      }));
      // Picture first: it is the setting people actually come here to change.
      const pic = this.pictureSummary(ctx);
      items.unshift({
        label: 'Picture',
        hint: pic.hint,
        action: () => this.openPictureMenu(rom),
      });
      items.push({ label: 'Emulator cores', hint: 'check for updates', action: () => this.openCoresMenu() });
      this.menus.open_({
        title: 'Settings',
        subtitle: rom ? `${rom.name} only` : 'all games',
        items,
      });
    },

    /** What the Picture row reads, and where the value came from. */
    pictureSummary(ctx) {
      const sh = this.svc.settings.resolve('shader', ctx);
      const vf = this.svc.settings.resolve('videoFilter', ctx);
      const active = sh.value ? sh : vf;
      const label = sh.value
        ? (this.svc.shaders.list().find((x) => x.value === sh.value)?.label ?? sh.value)
        : (this.svc.pictureFilters().find((x) => x.value === vf.value)?.label ?? vf.value);
      const from = active.source === 'default' ? 'default' : `from ${active.source}`;
      return { hint: `${label} · ${from}`, active };
    },

    /**
     * ONE question: what should the game look like?
     *
     * CPU filters and GPU shader presets are different subsystems that cannot
     * both apply — retroemu enforces that, and RetroArch does the same — so
     * choosing either clears the other. Presenting them as two independent
     * controls would let a user set both and quietly get only one.
     *
     * SCOPE IS EXPLICIT. RetroArch's loudest UX complaint is that a setting
     * saves into a scope you did not pick; here the menu says which scope it
     * is writing, and every row shows where its current value came from.
     */
    openPictureMenu(rom = null) {
      const ctx = rom ? { platform: rom.short, gameKey: this.svc.gameKey(rom) } : {};
      const scope = rom ? `game:${this.svc.gameKey(rom)}` : 'global';
      const cur = {
        shader: this.svc.settings.resolve('shader', ctx),
        filter: this.svc.settings.resolve('videoFilter', ctx),
      };
      const choose = (kind, value) => {
        // Mutually exclusive: setting one clears the other in THIS scope.
        if (kind === 'shader') {
          this.svc.settings.set('shader', value, scope);
          this.svc.settings.set('videoFilter', undefined, scope);
        } else {
          this.svc.settings.set('videoFilter', value, scope);
          this.svc.settings.set('shader', undefined, scope);
        }
        this.menus.closeAll();
        this.toast('Picture', `${value ?? 'clean'} — ${rom ? rom.name : 'all games'}`);
      };

      const mark = (on) => (on ? '● ' : '  ');
      const items = [];

      for (const f of this.svc.pictureFilters()) {
        items.push({
          label: mark(!cur.shader.value && cur.filter.value === f.value) + f.label,
          hint: 'CPU effect',
          action: () => choose('filter', f.value),
        });
      }

      const featured = this.svc.shaders.featured();
      if (featured.length) {
        items.push({ label: '— Shaders (GPU) —', disabled: true });
        for (const sPreset of featured) {
          items.push({
            label: mark(cur.shader.value === sPreset.value) + sPreset.label,
            hint: 'shader',
            action: () => choose('shader', sPreset.value),
          });
        }
        items.push({
          label: 'All shaders…',
          hint: `${this.svc.shaders.list().length} installed`,
          action: () => this.openAllShadersMenu(rom),
        });
      } else if (this.svc.shaders.installed()) {
        items.push({ label: 'No .glslp presets found', disabled: true });
      } else {
        items.push({
          label: 'Shaders not installed',
          hint: `drop presets in ${this.svc.shaders.installDir() ?? 'the shaders folder'}`,
          disabled: true,
        });
      }

      // The other scope is one hop away rather than hidden in another screen.
      if (rom) {
        items.push({
          label: `Set for all ${rom.system} games instead…`,
          action: () => this.openPictureScopeMenu(rom),
        });
      }

      this.menus.open_({
        title: 'Picture',
        subtitle: rom ? `${rom.name} only` : 'all games',
        items,
      });
    },

    /** The platform scope — "every Game Boy game", RetroArch's core preset. */
    openPictureScopeMenu(rom) {
      const ctx = { platform: rom.short };
      const scope = `platform:${rom.short}`;
      const cur = {
        shader: this.svc.settings.resolve('shader', ctx),
        filter: this.svc.settings.resolve('videoFilter', ctx),
      };
      const choose = (kind, value) => {
        if (kind === 'shader') {
          this.svc.settings.set('shader', value, scope);
          this.svc.settings.set('videoFilter', undefined, scope);
        } else {
          this.svc.settings.set('videoFilter', value, scope);
          this.svc.settings.set('shader', undefined, scope);
        }
        this.menus.closeAll();
        this.toast('Picture', `${value ?? 'clean'} — all ${rom.system} games`);
      };
      const mark = (on) => (on ? '● ' : '  ');
      const items = this.svc.pictureFilters().map((f) => ({
        label: mark(!cur.shader.value && cur.filter.value === f.value) + f.label,
        hint: 'CPU effect',
        action: () => choose('filter', f.value),
      }));
      for (const sPreset of this.svc.shaders.featured()) {
        items.push({
          label: mark(cur.shader.value === sPreset.value) + sPreset.label,
          hint: 'shader',
          action: () => choose('shader', sPreset.value),
        });
      }
      this.menus.open_({
        title: 'Picture',
        subtitle: `all ${rom.system} games`,
        items,
      });
    },

    /** The full corpus, for when the featured list is not enough. */
    openAllShadersMenu(rom = null) {
      const ctx = rom ? { platform: rom.short, gameKey: this.svc.gameKey(rom) } : {};
      const scope = rom ? `game:${this.svc.gameKey(rom)}` : 'global';
      const cur = this.svc.settings.resolve('shader', ctx).value;
      const items = this.svc.shaders.list().map((sPreset) => ({
        label: (cur === sPreset.value ? '● ' : '  ') + sPreset.label,
        action: () => {
          this.svc.settings.set('shader', sPreset.value, scope);
          this.svc.settings.set('videoFilter', undefined, scope);
          this.menus.closeAll();
          this.toast('Picture', `${sPreset.label} — ${rom ? rom.name : 'all games'}`);
        },
      }));
      this.menus.open_({
        title: 'All shaders',
        subtitle: rom ? `${rom.name} only` : 'all games',
        items: items.length ? items : [{ label: 'None installed', disabled: true }],
      });
    },

    async openCoresMenu() {
      this.toast('Cores', 'checking npm…');
      const res = await this.svc.coreUpdates.check();
      this.menus.open_({
        title: 'Emulator cores',
        subtitle: res.updatesAvailable
          ? `${res.updatesAvailable} update(s) available`
          : 'all current — cores version independently of romdeck',
        items: res.cores.length
          ? res.cores.map((c) => ({
            label: c.name.replace('romdev-core-', ''),
            hint: c.status === 'update' ? `v${c.version} → v${c.latest}` : `v${c.version} ${c.status}`,
            disabled: true,
          }))
          : [{ label: 'No cores found', disabled: true }],
      });
    },

    // ── controllers ──────────────────────────────────────────────────
    openControllersMenu() {
      const devices = this.padNav?.devices() ?? [];
      const items = devices.length ? devices.flatMap((dev) => [
        { label: dev.id, hint: `${dev.buttons} buttons`, disabled: true },
        {
          label: '  Remap buttons',
          action: () => this.openRemapMenu(dev),
        },
        {
          label: '  Player port',
          options: [0, 1, 2, 3].map((p) => ({ value: p, label: `Player ${p + 1}` })),
          value: Math.max(0, this.svc.mappings.portOrder.indexOf(dev.key)),
          onChange: (p) => {
            this.svc.mappings.assignPort(dev.key, p);
            this.svc.sessions.broadcastInputMap();
          },
        },
        {
          label: '  Deadzone',
          options: [0.1, 0.2, 0.35, 0.5, 0.65].map((d) => ({ value: d, label: d.toFixed(2) })),
          value: this.svc.mappings.deadzoneFor(dev.key),
          onChange: (d) => {
            this.svc.mappings.setDeadzone(dev.key, d);
            this.svc.sessions.broadcastInputMap();
          },
        },
        {
          label: '  Reset to defaults',
          action: () => {
            this.svc.mappings.clearLayer(dev.key, 'global');
            this.svc.sessions.broadcastInputMap();
            this.toast('Controllers', `${dev.id} reset`);
          },
        },
        {
          label: '  Import profile',
          action: () => {
            this.menus.closeAll();
            this.browser.open({
              mode: 'file',
              filter: /\.json$/i,
              title: 'Choose a controller profile',
              onPick: (file) => {
                try {
                  this.svc.importProfile(dev.key, file);
                  this.toast('Profile imported', dev.id);
                } catch (err) { this.toast('Import failed', err.message, { error: true }); }
              },
            });
          },
        },
      ]) : [{ label: 'No controllers detected', hint: 'plug one in', disabled: true }];
      this.menus.open_({ title: 'Controllers', subtitle: 'configure a pad with the pad', items });
    },

    /**
     * Press-to-bind.
     *
     * While listening, the pad is BINDING, not navigating — otherwise pressing
     * the button you want to bind moves the ring instead.
     */
    openRemapMenu(dev) {
      const items = BUTTONS.map((btn) => ({
        label: btn.name,
        hint: 'press to bind',
        action: () => {
          this.menus.closeAll();
          this._listenForBind(dev, btn);
        },
      }));
      this.menus.open_({ title: `Remap ${dev.id}`, subtitle: 'select a button, then press yours', items });
    },

    _listenForBind(dev, btn) {
      this.focus.enabled = false;
      this.toast('Press a button', `for ${btn.name}`, { ms: 6000 });
      const done = (source) => {
        this.focus.enabled = true;
        this.onRaw = null;
        this.svc.mappings.bind(dev.key, btn.id, source, { layer: 'global' });
        this.svc.sessions.broadcastInputMap();
        this.toast('Bound', `${btn.name} → ${source.type} ${source.index}`);
      };
      this.onRaw = (snapshot) => {
        const pad = snapshot.pads.find((p) => p.key === dev.key);
        if (!pad) return;
        const b = pad.buttons.findIndex(Boolean);
        if (b >= 0) { done({ type: 'button', index: b }); return; }
        const a = pad.axes.findIndex((v) => Math.abs(v) > 0.7);
        if (a >= 0) done({ type: 'axis', index: a, dir: pad.axes[a] < 0 ? -1 : 1 });
      };
      this.svc.mappings.noteDevice(dev.key, dev.id);
    },

    // ── themes ───────────────────────────────────────────────────────
    /** Toggle one game's membership in each custom collection. */
    openGameCollectionsMenu(rom) {
      const romsDir = this.svc.romsDir();
      const items = this.svc.collections.list().map((name) => {
        const inIt = this.svc.collections.has(name, rom.path, romsDir);
        return {
          label: `${inIt ? '[x]' : '[ ]'} ${name}`,
          action: () => {
            this.svc.collections.toggle(name, rom.path, romsDir);
            this.stage.setLibrary(this.svc.library().roms);
            this.menus.closeAll();
            this.openGameCollectionsMenu(rom);
          },
        };
      });
      this.menus.open_({ title: 'Collections', subtitle: rom.name, items });
    },

    /**
     * Create, edit and delete custom collections.
     *
     * "Edit" turns on the membership tick marks in every gamelist -- ES-DE's
     * model (GamelistBase.cpp:900), and the only thing <collectionIndicators>
     * ever marks. It is a mode rather than a screen, so browsing normally is
     * how you add games to it.
     */
    openCustomCollectionsMenu() {
      const names = this.svc.collections.list();
      const editing = this.stage.editingCollection;
      const items = [{
        label: 'New collection…',
        hint: 'name it, then add games from any list',
        action: () => {
          this.menus.closeAll();
          this.keyboard.open({
            title: 'Collection name',
            value: '',
            onCommit: (name) => {
              const clean = String(name).trim();
              if (!clean) return;
              if (!this.svc.collections.create(clean)) {
                this.toast('Already exists', clean);
                return;
              }
              this.stage.editingCollection = clean;
              this.stage.setLibrary(this.svc.library().roms);
              this.toast('Editing ' + clean, 'open a game to add it');
            },
          });
        },
      }];

      for (const name of names) {
        const isEditing = editing === name;
        items.push({
          label: `${isEditing ? '● ' : '   '}${name}`,
          hint: isEditing ? 'editing — tick marks show members' : `${this.svc.collections.read(name, this.svc.romsDir()).length} games`,
          action: () => {
            this.stage.editingCollection = isEditing ? null : name;
            this.stage.setLibrary(this.svc.library().roms);
            this.menus.closeAll();
            this.openCustomCollectionsMenu();
          },
        });
        items.push({
          label: `      Delete ${name}`,
          action: () => {
            this.svc.collections.remove(name);
            if (editing === name) this.stage.editingCollection = null;
            this.stage.setLibrary(this.svc.library().roms);
            this.menus.closeAll();
            this.openCustomCollectionsMenu();
          },
        });
      }
      this.menus.open_({
        title: 'Custom collections',
        subtitle: 'stored in ES-DE format, shared with it',
        items,
      });
    },

    /**
     * Auto-collections: extra "systems" assembled from the whole library.
     *
     * ES-DE ships three (CollectionSystemsManager.cpp:51) and themes carry
     * artwork for each keyed on the folder name, so the short names here are
     * not ours to choose. Off by default -- a library with three extra
     * systems in the carousel is a surprise nobody asked for.
     */
    openCollectionsMenu() {
      const AUTO = [
        ['auto-allgames', 'All games', 'every game, one list'],
        ['auto-lastplayed', 'Last played', 'most recent 50'],
        ['auto-favorites', 'Favorites', 'games you starred'],
      ];
      const enabled = this.svc.prefs.get('collections') ?? [];
      const items = AUTO.map(([short, label, hint]) => ({
        label: `${enabled.includes(short) ? '[x]' : '[ ]'} ${label}`,
        hint,
        action: () => {
          const now = this.svc.prefs.get('collections') ?? [];
          const next = now.includes(short)
            ? now.filter((x) => x !== short)
            : [...now, short];
          this.svc.prefs.set('collections', next);
          this.stage.setLibrary(this.svc.library().roms);
          this.menus.closeAll();
          this.openCollectionsMenu();          // reopen so the marks refresh
        },
      }));
      this.menus.open_({
        title: 'Collections',
        subtitle: 'extra systems assembled from the whole library',
        items,
      });
    },

    openThemesMenu() {
      const installed = this.svc.themes.list();
      const catalog = this.svc.themes.catalog().filter((c) => !c.installed);
      const current = this.svc.themePrefs().theme;
      const items = [];

      for (const t of installed) {
        items.push({
          label: (t.name === current ? '● ' : '   ') + t.displayName,
          hint: `${t.variants.length} variants · ${t.colorSchemes.length} colours`,
          action: async () => {
            this.menus.closeAll();
            this.svc.prefs.set('theme', t.name);
            this.svc.prefs.set('themeVariant', null);
            this.svc.prefs.set('themeColorScheme', null);
            await this.setTheme(t.name, {});
            this.toast('Theme', t.displayName);
          },
        });
      }
      for (const c of catalog) {
        items.push({
          // Licence and size shown BEFORE anything downloads.
          label: `↓ ${c.displayName}${c.recommended ? ' ★' : ''}`,
          hint: `${c.license} · ${c.size}`,
          action: async () => {
            this.menus.closeAll();
            this.toast('Downloading', c.displayName, { ms: 60000 });
            try {
              await this.svc.themes.install(c.name, (line) => { this._progress = line; });
              this.toast('Theme installed', c.displayName);
            } catch (err) { this.toast('Download failed', err.message, { error: true }); }
          },
        });
      }
      this.menus.open_({ title: 'Themes', subtitle: 'ES-DE format · downloaded, not bundled', items });
    },

    // ── the rest ─────────────────────────────────────────────────────
    openBiosMenu() {
      const rows = this.svc.bios.check(this.svc.romsDir());
      this.menus.open_({
        title: 'BIOS files',
        subtitle: `${rows.filter((r) => r.status === 'ok').length} of ${rows.length} present`,
        items: rows.map((r) => ({
          label: `${r.status === 'ok' ? '✓' : r.status === 'bad-hash' ? '!' : '·'} ${r.file}`,
          hint: `${r.system}${r.required && r.status !== 'ok' ? ' · required' : ''}`,
          disabled: true,
        })),
      });
    },

    async openFeedMenu() {
      this.toast('Homebrew', 'loading feed…');
      const entries = await this.svc.feed.list({ refresh: true });
      const dir = this.svc.romsDir();
      this.menus.open_({
        title: 'Homebrew',
        subtitle: 'ROM, wasmcart and jsgame carts',
        items: entries.length ? entries.map((e) => {
          const installed = dir ? !!this.svc.feed.installedPath(e, dir) : false;
          return {
            label: `${installed ? '✓ ' : ''}${e.title}`,
            hint: `${e.kind} · ${e.license}`,
            action: async () => {
              this.menus.closeAll();
              if (!dir) { this.toast('Homebrew', 'choose a ROMs folder first', { error: true }); return; }
              try {
                await this.svc.feed.install(e, dir);
                this.toast('Added to library', e.title);
                await this.refresh();
              } catch (err) { this.toast('Install failed', err.message, { error: true }); }
            },
          };
        }) : [{ label: 'Feed unavailable', disabled: true }],
      });
    },

    openJoinMenu() {
      const recent = this.svc.prefs.get('recentCodes') ?? [];
      this.menus.open_({
        title: 'Join a game',
        subtitle: 'no ROM needed — their machine runs it',
        items: [
          {
            label: 'Enter a share code',
            action: () => {
              this.menus.closeAll();
              this.keyboard.open({
                layout: 'base24',
                title: 'Enter the share code your host gave you',
                onCommit: (code) => this.doJoin(code),
              });
            },
          },
          ...recent.map((c) => ({ label: c, hint: 'rejoin', action: () => { this.menus.closeAll(); this.doJoin(c); } })),
        ],
      });
    },

    /**
     * RetroAchievements sign-in.
     *
     * Two credentials, and conflating them is the trap: the WEB API KEY (from
     * the settings page) reads profiles and achievement lists, but dorequest —
     * the endpoint that accepts an unlock — will not take it. That needs a
     * session TOKEN from r=login2. romdeck tries the API key first because it
     * costs the user nothing, and only asks for a password if RA refuses it.
     *
     * The password is used for exactly one request and never stored; the token
     * it returns is what gets persisted.
     */
    openAchievementsMenu() {
      const ra = this.svc.ra;
      const { username, apiKey } = ra.creds();
      const items = [];

      items.push({
        label: 'Username',
        hint: username ?? 'not set',
        action: () => {
          this.menus.closeAll();
          this.keyboard.open({
            title: 'RetroAchievements username',
            value: username ?? '',
            onCommit: (v) => {
              this.svc.prefs.set('ra', { ...ra.creds(), username: v.trim() });
              this.openAchievementsMenu();
            },
          });
        },
      });

      items.push({
        label: 'Web API key',
        hint: apiKey ? 'set' : 'from your RA settings page',
        action: () => {
          this.menus.closeAll();
          this.keyboard.open({
            title: 'Web API key (RA settings page)',
            value: '',
            onCommit: (v) => {
              this.svc.prefs.set('ra', { ...ra.creds(), apiKey: v.trim() });
              this.openAchievementsMenu();
            },
          });
        },
      });

      items.push({
        label: ra.canSubmit() ? 'Signed in — unlocks will submit' : 'Sign in to submit unlocks',
        hint: ra.canSubmit() ? 'tap to sign in again' : 'needed for dorequest',
        action: async () => {
          this.menus.closeAll();
          if (!ra.creds().username) { this.toast('RetroAchievements', 'set a username first', { error: true }); return; }
          this.toast('RetroAchievements', 'signing in…', { ms: 8000 });
          let res = await ra.login();
          if (res.status === 'ok') { this.toast('Signed in', `${res.user} — ${res.score} points`); return; }
          // RA would not take the API key as a token; ask for the password,
          // which is used once and never written to disk.
          this.keyboard.open({
            title: 'RetroAchievements password (used once, never stored)',
            value: '',
            mask: true,
            onCommit: async (pw) => {
              const r2 = await ra.login({ password: pw });
              this.toast(r2.status === 'ok' ? 'Signed in' : 'Sign-in failed',
                r2.status === 'ok' ? `${r2.user} — ${r2.score} points` : (r2.message ?? ''),
                { error: r2.status !== 'ok' });
            },
          });
        },
      });

      this.menus.open_({
        title: 'RetroAchievements',
        subtitle: ra.canSubmit()
          ? 'unlocks are submitted as you play'
          : 'listing works with an API key; submitting needs a sign-in',
        items,
      });
    },

    async openDevMenu() {
      const live = this.svc.sessions.list()[0];
      if (!live) {
        this.menus.open_({
          title: 'Developer mode',
          items: [{ label: 'Start a game first', disabled: true }],
        });
        return;
      }
      let info;
      try { info = await this.svc.sessions.rpc(live.id, 'memoryInfo'); }
      catch (err) {
        this.menus.open_({ title: 'Developer mode', items: [{ label: err.message, disabled: true }] });
        return;
      }
      this.menus.open_({
        title: 'Developer mode',
        subtitle: `${live.name} — memory is live while it runs`,
        items: info.regions.map((r) => ({
          label: r.name,
          hint: `${r.size.toLocaleString()} bytes`,
          action: async () => {
            const res = await this.svc.sessions.rpc(live.id, 'readMemory', { region: r.id, offset: 0, length: 64 });
            const bytes = Buffer.from(res.dataB64, 'base64');
            this.toast(r.name, bytes.subarray(0, 16).toString('hex').replace(/(..)/g, '$1 '), { ms: 8000 });
          },
        })),
      });
    },

    openRomsFolderPicker() {
      this.menus.closeAll();
      this.browser.open({
        mode: 'directory',
        start: this.svc.romsDir(),
        title: 'Choose your ROMs folder',
        onPick: async (dir) => {
          this.svc.setRomsDir(dir);
          await this.refresh();
          this.toast('ROMs folder', dir);
          this.offerSystemDirs(dir);
        },
      });
    },

    /**
     * Offer to create the per-system folders, once a ROMs folder is chosen.
     *
     * romdeck reads the FOLDER to decide a game's system, so this layout is
     * what makes a library sort itself — and a user who has never seen ES-DE
     * has no way to guess it. ES-DE offers the same thing at setup.
     *
     * An OFFER, never automatic: this writes to the user's own files, and a
     * folder picked by mistake must not leave 30 empty directories behind.
     * Skipped entirely when the folder already looks like a library, so people
     * who arrived with one are not nagged.
     */
    offerSystemDirs(dir) {
      const missing = this.svc.missingSystemDirs(dir);
      // Nothing to add, or the folder is ALREADY organised (some system dirs
      // exist) — either way the user does not need this. Only a folder with no
      // system layout at all gets the offer.
      if (!missing.length || missing.length < this.svc.systemDirCount()) return;
      this.menus.open_({
        title: 'Set up system folders?',
        subtitle: `${missing.length} folders under ${dir}`,
        items: [
          {
            label: `Create them (${missing.map((s) => s.short).slice(0, 4).join(', ')}…)`,
            hint: 'each gets a note saying which games belong in it',
            action: async () => {
              const made = this.svc.createSystemDirs(dir);
              this.menus.close();
              await this.refresh();
              this.toast('System folders', `created ${made.length}`);
            },
          },
          { label: 'No thanks', hint: 'romdeck still finds loose ROMs by extension', action: () => this.menus.close() },
        ],
      });
    },

    openCheatsMenu(rom) {
      const key = this.svc.gameKey(rom);
      const codes = this.svc.cheats.list(key);
      const items = codes.map((c, i) => ({
        label: `${c.enabled ? '✓' : '·'} ${c.desc}`,
        hint: c.code,
        action: () => {
          this.svc.cheats.toggle(key, i, !c.enabled);
          this.svc.pushCheats(rom);
          this.menus.close();
          this.openCheatsMenu(rom);
        },
      }));
      items.push({
        label: '+ Add a code',
        action: () => {
          this.menus.closeAll();
          this.keyboard.open({
            layout: 'code',
            title: `Cheat code for ${rom.name}`,
            onCommit: (code) => {
              if (!code) return;
              try {
                this.svc.cheats.add(key, { desc: code, code });
                this.svc.pushCheats(rom);
                this.toast('Cheat added', code);
              } catch (err) { this.toast('Cheat', err.message, { error: true }); }
            },
          });
        },
      });
      items.push({
        label: 'Import .cht file',
        action: () => {
          this.menus.closeAll();
          this.browser.open({
            mode: 'file',
            filter: /\.cht$/i,
            title: 'Choose a RetroArch cheat file',
            onPick: (file) => {
              try {
                const out = this.svc.importCht(rom, file);
                this.toast('Cheats imported', `${out.added} codes`);
              } catch (err) { this.toast('Import failed', err.message, { error: true }); }
            },
          });
        },
      });
      this.menus.open_({ title: 'Cheats', subtitle: rom.name, items });
    },

    // ── operations ───────────────────────────────────────────────────
    doLaunch(rom, opts = {}) {
      const res = this.svc.launch(rom, opts);
      if (res.error) this.toast('Launch failed', res.error, { error: true });
      else this.toast('Now playing', rom.name);
      return res;
    },

    doJoin(code) {
      const res = this.svc.sessions.joinRemote(code, {});
      if (res.error) { this.toast('Join failed', res.error, { error: true }); return res; }
      const recent = (this.svc.prefs.get('recentCodes') ?? []).filter((c) => c !== res.code);
      recent.unshift(res.code);
      this.svc.prefs.set('recentCodes', recent.slice(0, 6));
      this.toast('Connecting…', res.code);
      return res;
    },

    async doIdentify() {
      this.menus.closeAll();
      this.toast('Identifying', 'downloading databases…', { ms: 30000 });
      const res = await this.svc.identifyAll((p) => {
        if (p.phase === 'hash' && p.done % 100 === 0) {
          this.toast('Identifying', `${p.done}/${p.total} (${p.matched} matched)`, { ms: 2000 });
        }
      });
      await this.refresh();
      this.toast('Identification', `${res.matched} of ${res.total} verified`);
    },

    async doScrapeAll() {
      this.menus.closeAll();
      this.toast('Box art', 'fetching…', { ms: 30000 });
      const res = await this.svc.scrapeAll(() => {});
      await this.refresh();
      this.toast('Box art', `${res.ok} of ${res.total} found`);
    },
  });
}
