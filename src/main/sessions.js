// GameSessionManager — every game runs in its own child process (retroemu with
// an SDL window). A crashing or hung core can never take down the library.
// This is romdeck's founding architectural decision.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import path from 'node:path';

const require = createRequire(import.meta.url);

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
  constructor() {
    super();
    this.sessions = new Map();
    this.nextId = 1;
  }

  list() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      romPath: s.romPath,
      name: s.name,
      startedAt: s.startedAt,
    }));
  }

  launch(rom, { fullscreen = false } = {}) {
    const id = this.nextId++;
    const cli = resolveRetroemuCli();
    const { cmd, env } = resolveNode();
    const args = [cli, rom.path, '--video', 'sdl'];
    if (fullscreen) args.push('--fullscreen');

    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const session = {
      id,
      child,
      romPath: rom.path,
      name: rom.name,
      startedAt: Date.now(),
      log: [],
    };
    this.sessions.set(id, session);

    const tail = (buf) => {
      const lines = buf.toString().split('\n').filter(Boolean);
      session.log.push(...lines);
      if (session.log.length > 50) session.log.splice(0, session.log.length - 50);
    };
    child.stdout.on('data', tail);
    child.stderr.on('data', tail);

    child.on('error', (err) => {
      this.sessions.delete(id);
      this.emit('update', {
        type: 'error', id, name: rom.name, romPath: rom.path,
        message: err.message,
      });
    });

    child.on('exit', (code, signal) => {
      this.sessions.delete(id);
      const crashed = code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL';
      this.emit('update', {
        type: crashed ? 'crashed' : 'closed',
        id,
        name: rom.name,
        romPath: rom.path,
        code,
        signal,
        logTail: crashed ? session.log.slice(-8) : undefined,
      });
    });

    this.emit('update', { type: 'started', id, name: rom.name, romPath: rom.path });
    return { id };
  }

  stop(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.child.kill('SIGTERM');
    return true;
  }

  stopAll() {
    for (const session of this.sessions.values()) session.child.kill('SIGTERM');
  }
}
