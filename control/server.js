const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const PROJECT_HOST_DIR = process.env.PROJECT_HOST_DIR || '/home/docker/world-visitor-bot';
const PROJECT_DIR = process.env.PROJECT_DIR || '/app/project';
const PORT = parseInt(process.env.PORT || '80');
const PORT2 = parseInt(process.env.PORT2 || '3000');
const DOMAIN = process.env.DOMAIN || 'bigheados.com';
const BLUEMAP_PORT = process.env.BLUEMAP_PORT || '8100';
const MC_PORT = '25565';
const RCON_HOST = 'mc';
const RCON_PORT = 25575;
const RCON_PASS = 'visitor';

const envPath = path.join(PROJECT_DIR, '.env');
const stateDir = path.join(PROJECT_DIR, 'state');

function compose(args) {
  return new Promise((resolve) => {
    exec(`docker compose --project-directory ${PROJECT_HOST_DIR} ${args}`, { timeout: 180000, maxBuffer: 1024*1024*10 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function run(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function getStatus() {
  const [mc, visitor, bluemap] = await Promise.all([
    run(`docker inspect mc --format='{{.State.Status}}' 2>/dev/null`),
    run(`docker inspect visitor --format='{{.State.Status}}' 2>/dev/null`),
    run(`docker inspect bluemap --format='{{.State.Status}}' 2>/dev/null`),
  ]);
  return {
    mc: mc.stdout.trim() || 'stopped',
    visitor: visitor.stdout.trim() || 'stopped',
    bluemap: bluemap.stdout.trim() || 'stopped',
  };
}

async function getStats() {
  const { stdout } = await run(`docker stats mc visitor bluemap --no-stream --format '{{.Name}}:{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}' 2>/dev/null`);
  const stats = {};
  for (const line of stdout.split('\n').filter(Boolean)) {
    const [name, rest] = line.split(':');
    if (rest) {
      const [cpu, mem, memPct, net] = rest.split('|');
      stats[name] = { cpu, mem, memPct, net };
    }
  }
  return stats;
}

function getProgress() {
  try {
    if (!fs.existsSync(stateDir)) return { regions: 0, total: 0, rx: 0, rz: 0, pct: 0 };
    const files = fs.readdirSync(stateDir).filter(f => f.startsWith('visited') && f.endsWith('.json'));
    let totalRegions = 0, visitedRegions = 0, rx = 0, rz = 0;
    for (const f of files) {
      const data = JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8'));
      if (data.visited) {
        const keys = Object.keys(data.visited);
        visitedRegions += keys.length;
        if (keys.length > 0) {
          const [a, b] = keys[keys.length - 1].split(',');
          rx = parseInt(a) || 0; rz = parseInt(b) || 0;
        }
      }
      totalRegions += (data.total || 0);
    }
    return { regions: visitedRegions, total: totalRegions || 1, rx, rz, pct: totalRegions ? Math.round(visitedRegions / totalRegions * 100) : 0 };
  } catch { return { regions: 0, total: 0, rx: 0, rz: 0, pct: 0 }; }
}

function readEnv() {
  const cfg = {};
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) cfg[m[1]] = m[2];
    }
  } catch {}
  return cfg;
}

function writeEnv(settings) {
  const lines = [
    '# Overworld Visitor configuration',
    `MC_HOST=mc`, `MC_PORT=25565`,
    `MC_USERNAME=${settings.MC_USERNAME || 'Bot'}`,
    `MC_AUTH=offline`,
    `RENDER_DISTANCE=${settings.RENDER_DISTANCE || '28'}`,
    `FLY_Y=${settings.FLY_Y || '200'}`,
    `GRID_STEP=${settings.GRID_STEP || '160'}`,
    `BOT_COUNT=${settings.BOT_COUNT || '1'}`,
    `WORLD_PATH=${settings.WORLD_PATH || './mc-data/world'}`,
    `WP_DELAY=2000`, `REGION_DELAY=2000`,
    `CHUNK_LOAD_TIMEOUT=60000`,
    `MC_MEMORY=${settings.MC_MEMORY || '12G'}`,
    `BOT_MEMORY=${settings.BOT_MEMORY || '2G'}`,
    `BLUEMAP_HOST=bluemap`, `BLUEMAP_PORT=8100`, `BLUEMAP_MAP=overworld`,
    `FOLLOW_PLAYER=${settings.FOLLOW_PLAYER || ''}`,
    '',
  ];
  fs.writeFileSync(envPath, lines.join('\n'));
  if (settings.stateData) {
    const file = path.join(stateDir, 'visited.json');
    const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const merged = { ...existing, visited: { ...existing.visited, ...settings.stateData } };
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(merged, null, 2));
  }
}

async function rcon(cmd) {
  return new Promise((resolve) => {
    const client = new net.Socket();
    let buf = Buffer.alloc(0), authDone = false;
    client.connect(RCON_PORT, RCON_HOST, () => {});
    client.on('data', (data) => {
      buf = Buffer.concat([buf, data]);
      if (!authDone) { authDone = true; buf = Buffer.alloc(0); return; }
      if (buf.length >= 14) {
        const len = buf.readInt32LE(0);
        if (buf.length >= 4 + len) {
          const id = buf.readInt32LE(4);
          const type = buf.readInt32LE(8);
          const payload = buf.slice(12, 4 + len - 2).toString('utf8');
          client.destroy();
          resolve(payload || '(empty)');
        }
      }
    });
    client.on('error', () => { resolve('RCON connection failed'); });
    client.on('close', () => { resolve('RCON closed'); });
    setTimeout(() => { client.destroy(); resolve('RCON timeout'); }, 5000);
    const authPkt = createRconPacket(0, 3, RCON_PASS);
    const cmdPkt = createRconPacket(0, 2, cmd);
    client.write(authPkt);
    setTimeout(() => { client.write(cmdPkt); }, 100);
  });
}

function createRconPacket(id, type, body) {
  const buf = Buffer.alloc(14 + body.length + 1);
  let offset = 0;
  buf.writeInt32LE(10 + body.length, offset); offset += 4;
  buf.writeInt32LE(id, offset); offset += 4;
  buf.writeInt32LE(type, offset); offset += 4;
  buf.write(body, offset, body.length, 'utf8'); offset += body.length;
  buf.writeInt8(0, offset); offset += 1;
  buf.writeInt8(0, offset);
  return buf;
}

function log(io, msg, level) { io.emit('log', { msg, level }); }
function mclog(io, msg, level) { io.emit('mclog', { msg, level }); }
function bmlog(io, msg, level) { io.emit('bmlog', { msg, level }); }

async function buildImage(io) {
  log(io, 'Building bot image...', 'info');
  const r = await compose('build visitor');
  log(io, r.ok ? 'Build complete' : 'Build FAILED: ' + (r.stderr || r.stdout).slice(-300), r.ok ? 'done' : 'error');
  return r.ok;
}

async function doAction(io, cmd) {
  if (cmd.startsWith('cmd:')) {
    const mcCmd = cmd.slice(4);
    log(io, '$ ' + mcCmd, 'info');
    const result = await rcon(mcCmd);
    io.emit('cmd-result', result);
    log(io, result, 'm');
    return;
  }

  log(io, '[cmd] ' + cmd, 'info');
  let r;
  switch (cmd) {
    case 'start-all': r = await compose('up -d mc visitor bluemap'); log(io, r.ok ? 'All started' : 'Failed: ' + (r.stderr || '').slice(-200), r.ok ? 'done' : 'error'); break;
    case 'stop-all': r = await compose('stop mc visitor bluemap'); log(io, 'All stopped', 'done'); break;
    case 'prune':
      log(io, 'Stopping containers...', 'info');
      await compose('down mc visitor bluemap 2>/dev/null');
      await buildImage(io);
      r = await compose('up -d mc visitor bluemap');
      log(io, r.ok ? 'Prune complete' : 'Failed', r.ok ? 'done' : 'error');
      break;
    case 'start-mc': r = await compose('up -d --no-deps mc'); log(io, 'MC starting...', 'info'); break;
    case 'stop-mc': r = await compose('stop mc'); log(io, 'MC stopped', 'done'); break;
    case 'start-visitor': await buildImage(io); r = await compose('up -d --no-deps visitor'); log(io, 'Visitor starting...', 'info'); break;
    case 'stop-visitor': r = await compose('stop visitor'); log(io, 'Visitor stopped', 'done'); break;
    case 'start-bluemap': r = await compose('up -d --no-deps bluemap'); log(io, 'BlueMap started', 'done'); break;
    case 'stop-bluemap': r = await compose('stop bluemap'); log(io, 'BlueMap stopped', 'done'); break;
    case 'build': await buildImage(io); break;
    default: log(io, 'Unknown: ' + cmd, 'warn');
  }
  await pushAll(io);
}

async function pushAll(io) {
  const [status, progress, stats] = await Promise.all([getStatus(), Promise.resolve(getProgress()), getStats()]);
  io.emit('status', {
    ...status, progress, stats,
    conn: { host: DOMAIN, port: MC_PORT, bluemapUrl: `http://${DOMAIN}:${BLUEMAP_PORT}` }
  });
}

function setupServer(p) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const server = http.createServer(app);
  return { app, server, io: new Server(server, { maxHttpBufferSize: 1e7 }) };
}

async function main() {
  const s1 = setupServer(PORT);
  const s2 = setupServer(PORT2);

  s1.app.use(express.static(path.join(__dirname, 'public')));
  s2.app.use(express.static(path.join(__dirname, 'public')));

  s1.app.get('/api/env', (req, res) => res.json(readEnv()));

  s1.app.get('/api/states', (req, res) => {
    const states = {};
    try {
      if (fs.existsSync(stateDir)) {
        for (const f of fs.readdirSync(stateDir).filter(x => x.endsWith('.json'))) {
          states[f] = JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8'));
        }
      }
    } catch {}
    res.json(states);
  });

  s1.app.post('/api/wizard', async (req, res) => {
    try { writeEnv(req.body); log(s1.io, 'Settings saved', 'done'); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  s1.app.post('/api/action', async (req, res) => { res.json({ ok: true }); doAction(s1.io, req.body.cmd); });
  s1.app.get('/map/*', (req, res) => res.redirect(`http://${DOMAIN}:${BLUEMAP_PORT}`));

  [s1.io, s2.io].forEach(io => {
    io.on('connection', socket => {
      log(io, 'Connected', 'info');
      pushAll(io);
      socket.on('action', cmd => doAction(io, cmd));
    });
  });

  // Stream MC server logs to mclog channel
  setInterval(async () => {
    await pushAll(s1.io);
    await pushAll(s2.io);
    try {
      const { stdout } = await run(`docker logs mc --tail 3 --since 10s 2>/dev/null`);
      if (stdout.trim()) for (const line of stdout.trim().split('\n')) mclog(s1.io, line, 'm');
    } catch {}
    try {
      const { stdout } = await run(`docker logs bluemap --tail 3 --since 10s 2>/dev/null`);
      if (stdout.trim()) for (const line of stdout.trim().split('\n')) bmlog(s1.io, line, 'm');
    } catch {}
  }, 4000);

  s1.server.listen(PORT, () => console.log('Panel: http://0.0.0.0:' + PORT));
  s2.server.listen(PORT2, () => console.log('Panel: http://0.0.0.0:' + PORT2));
}

main().catch(console.error);
