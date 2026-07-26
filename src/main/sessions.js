// GameSessionManager — every game runs in its own child process (retroemu with
// an SDL window). A crashing or hung core can never take down the library.
// This is romdeck's founding architectural decision.
//
// M1: sessions speak retroemu's --control IPC channel (JSON-RPC over node IPC):
// pause/resume, save/load state blobs, screenshot, fast-forward, fullscreen,
// rewind, quit — plus 'ready' and exit-'autosave' events. Autosaves persist via
// the StateStore, and launches can resume from them.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import path from 'node:path';

const require = createRequire(import.meta.url);
const RPC_TIMEOUT_MS = 15000;

function resolveRetroemuCli() {
  const pkg = require.resolve('retroemu/package.json');
  return path.join(path.dirname(pkg), 'bin', 'cli.js');
}

// Prefer the system `node` from PATH (what npx users have by definition);
// fall back to running Electron's binary in Node mode.
let nodeCmd = null;
function resolveNode() {
  if (nodeCmd) return nodeCmd;
  const probe = spawnSync('node', ['--version'], { timeout: 3000 });
  if (!probe.error && probe.status === 0) {
    nodeCmd = { cmd: 'node', env: {} };
  } else {
    nodeCmd = { cmd: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return nodeCmd;
}

export class GameSessionManager extends EventEmitter {
  constructor({ stateStore, saveDir, mappings } = {}) {
    super();
    this.sessions = new Map();
    this.nextId = 1;
    this.stateStore = stateStore ?? null;
    this.saveDir = saveDir ?? null; // shared SRAM/battery-save dir
    this.mappings = mappings ?? null; // MappingStore
  }

  /** Push the current controller config to every live session. */
  broadcastInputMap(ctxFor = () => ({})) {
    if (!this.mappings) return;
    for (const [id, session] of this.sessions) {
      const map = this.mappings.playerConfig(ctxFor(session));
      this.rpc(id, 'setInputMap', { map }).catch(() => { /* session may be closing */ });
    }
  }

  list() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      romPath: s.romPath,
      name: s.name,
      startedAt: s.startedAt,
      ready: s.ready,
      paused: s.paused,
      speed: s.speed,
    }));
  }

  get(id) {
    return this.sessions.get(id);
  }

  findByRom(romPath) {
    for (const s of this.sessions.values()) if (s.romPath === romPath) return s;
    return null;
  }

  launch(rom, { fullscreen = false, resume = true, stateName = null } = {}) {
    const id = this.nextId++;
    const cli = resolveRetroemuCli();
    const { cmd, env } = resolveNode();
    const args = [cli, rom.path, '--video', 'sdl', '--control'];
    if (fullscreen) args.push('--fullscreen');
    if (this.saveDir) args.push('--save-dir', this.saveDir);
    if (this.mappings) {
      const map = this.mappings.playerConfig({
        platform: rom.short ?? null,
        gameKey: this.stateStore?.gameKey(rom) ?? null,
      });
      if (Object.keys(map.devices).length || map.portOrder.length) {
        args.push('--input-map', JSON.stringify(map));
      }
    }

    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    const session = {
      id,
      child,
      rom,
      romPath: rom.path,
      name: rom.name,
      startedAt: Date.now(),
      log: [],
      ready: false,
      paused: false,
      speed: 1,
      core: null,
      nextRpcId: 1,
      pending: new Map(),
    };
    this.sessions.set(id, session);

    const tail = (buf) => {
      const lines = buf.toString().split('\n').filter(Boolean);
      session.log.push(...lines);
      if (session.log.length > 50) session.log.splice(0, session.log.length - 50);
    };
    child.stdout.on('data', tail);
    child.stderr.on('data', tail);

    child.on('message', (msg) => this._onMessage(session, msg));

    child.on('error', (err) => {
      this._rejectAll(session, err);
      this.sessions.delete(id);
      this.emit('update', {
        type: 'error', id, name: rom.name, romPath: rom.path,
        message: err.message,
      });
    });

    child.on('exit', (code, signal) => {
      this._rejectAll(session, new Error('session exited'));
      this.sessions.delete(id);
      const crashed = code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL';
      this.emit('update', {
        type: crashed ? 'crashed' : 'closed',
        id,
        name: rom.name,
        romPath: rom.path,
        code,
        signal,
        hasAuto: this.stateStore ? this.stateStore.hasAuto(rom) : false,
        logTail: crashed ? session.log.slice(-8) : undefined,
      });
    });

    session.resumeRequested = resume;
    session.stateName = stateName;
    this.emit('update', { type: 'started', id, name: rom.name, romPath: rom.path });
    return { id };
  }

  _onMessage(session, msg) {
    if (!msg || typeof msg !== 'object') return;

    // RPC response
    if (msg.id !== undefined) {
      const p = session.pending.get(msg.id);
      if (p) {
        session.pending.delete(msg.id);
        clearTimeout(p.timer);
        msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
      }
      return;
    }

    // Events
    if (msg.event === 'ready') {
      session.ready = true;
      session.core = msg.core;
      this.emit('update', {
        type: 'ready', id: session.id, name: session.name, romPath: session.romPath,
        core: msg.core, stateSupported: msg.stateSupported,
      });
      // Load a specific stored state, or resume from autosave
      const wantedState = session.stateName ?? (session.resumeRequested ? 'auto' : null);
      if (wantedState && this.stateStore && msg.stateSupported) {
        const auto = this.stateStore.load(session.rom, wantedState);
        if (auto) {
          this.rpc(session.id, 'loadState', { stateB64: auto.stateB64 })
            .then(() => this.emit('update', {
              type: 'resumed', id: session.id, name: session.name, romPath: session.romPath,
              savedAt: auto.info.savedAt,
            }))
            .catch((err) => this.emit('update', {
              type: 'resume-failed', id: session.id, name: session.name,
              romPath: session.romPath, message: err.message,
            }));
        }
      }
      return;
    }

    if (msg.event === 'autosave') {
      if (this.stateStore && msg.stateB64) {
        try {
          this.stateStore.save(session.rom, 'auto', {
            stateB64: msg.stateB64,
            screenshotPngB64: msg.screenshotPngB64,
            frameCount: msg.frameCount,
            core: session.core,
          });
        } catch (err) {
          session.log.push(`autosave persist failed: ${err.message}`);
        }
      }
    }
  }

  _rejectAll(session, err) {
    for (const { reject, timer } of session.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    session.pending.clear();
  }

  rpc(id, method, params = {}) {
    const session = this.sessions.get(id);
    if (!session) return Promise.reject(new Error('no such session'));
    const rpcId = session.nextRpcId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(rpcId);
        reject(new Error(`${method} timed out`));
      }, RPC_TIMEOUT_MS);
      session.pending.set(rpcId, { resolve, reject, timer });
      try {
        session.child.send({ id: rpcId, method, params });
      } catch (err) {
        clearTimeout(timer);
        session.pending.delete(rpcId);
        reject(err);
      }
    }).then((result) => {
      if (method === 'pause') session.paused = true;
      if (method === 'resume') session.paused = false;
      if (method === 'setSpeed') session.speed = result.speed ?? 1;
      return result;
    });
  }

  async stop(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    // Graceful: quit via the channel (triggers autosave push); SIGTERM fallback.
    try {
      await this.rpc(id, 'quit');
    } catch {
      session.child.kill('SIGTERM');
    }
    // Escalate if it lingers
    setTimeout(() => {
      if (this.sessions.has(id)) session.child.kill('SIGKILL');
    }, 5000);
    return true;
  }

  stopAll() {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }
}
