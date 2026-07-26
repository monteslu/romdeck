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
          { label: 'Get box art', hint: 'scrape the library', action: () => this.doScrapeAll() },
          { label: 'Identify ROMs', hint: 'CRC match against No-Intro', action: () => this.doIdentify() },
          { label: 'Homebrew', action: () => this.openFeedMenu() },
          { label: 'Join a game', hint: 'remote play', action: () => this.openJoinMenu() },
          { label: 'Developer mode', hint: 'live memory viewer', action: () => this.openDevMenu() },
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
      const items = resolved.map((s) => ({
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
      items.push({ label: 'Emulator cores', hint: 'check for updates', action: () => this.openCoresMenu() });
      this.menus.open_({
        title: 'Settings',
        subtitle: rom ? `${rom.name} only` : 'all games',
        items,
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
        },
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
