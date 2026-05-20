const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');

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

function getLocalIP() {
  const provided = process.env.HOST_IP;
  if (provided) return provided;
  try {
    const { execSync } = require('child_process');
    const gw = execSync("ip route get 1 2>/dev/null | awk '{print $7;exit}'").toString().trim();
    const octets = gw.split('.');
    if (octets.length === 4 && octets[0] !== '172') return gw;
  } catch {}
  return 'localhost';
}

const LOCAL_IP = getLocalIP();

function getConnectionInfo() {
  return {
    primary: DOMAIN,
    fallback: LOCAL_IP,
    port: MC_PORT,
    bluemapUrl: `http://${DOMAIN}:${BLUEMAP_PORT}`,
    bluemapFallback: `http://${LOCAL_IP}:${BLUEMAP_PORT}`,
  };
}

function compose(args) {
  const cmd = `docker compose --project-directory ${PROJECT_DIR} ${args}`;
  console.log(`[compose] ${cmd}`);
  return new Promise((resolve) => {
    exec(cmd, { timeout: 180000, maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      if (stdout.trim()) console.log(`[compose:out] ${stdout.trim().slice(0, 500)}`);
      if (stderr.trim()) console.log(`[compose:err] ${stderr.trim().slice(0, 500)}`);
      if (err) console.log(`[compose:exit] error: ${err.message}`);
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function run(cmd, quiet) {
  if (!quiet) console.log(`[run] ${cmd}`);
  return new Promise((resolve) => {
    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      if (!quiet && err && stderr) console.log(`[run:err] ${(stderr||'').trim().slice(0, 300)}`);
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function getStatus(quiet) {
  if (!quiet) console.log('[status] checking...');
  const [mc, visitor, bluemap] = await Promise.all([
    run(`docker compose --project-directory ${PROJECT_DIR} ps mc --format '{{.Status}}' 2>/dev/null`, quiet),
    run(`docker compose --project-directory ${PROJECT_DIR} ps visitor --format '{{.Status}}' 2>/dev/null`, quiet),
    run(`docker compose --project-directory ${PROJECT_DIR} ps bluemap --format '{{.Status}}' 2>/dev/null`, quiet),
  ]);
  const parse = (out) => {
    if (!out.trim()) return 'stopped';
    if (out.includes('Up')) return 'running';
    if (out.includes('starting') || out.includes('health')) return 'starting';
    return 'stopped';
  };
  const s = { mc: parse(mc.stdout), visitor: parse(visitor.stdout), bluemap: parse(bluemap.stdout) };
  if (!quiet) console.log(`[status] mc=${s.mc} visitor=${s.visitor} bluemap=${s.bluemap}`);
  return s;
}

async function getStats(quiet) {
  const { stdout } = await run(`docker stats --no-stream --format '{{.Name}}:{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}' 2>/dev/null`, quiet);
  const stats = {};
  for (const line of stdout.split('\n').filter(Boolean)) {
    const [name, rest] = line.split(':');
    if (rest && (name.includes('mc') || name.includes('visitor') || name.includes('bluemap'))) {
      const [cpu, mem, memPct, net] = rest.split('|');
      const key = name.includes('mc-') ? 'mc' : name.includes('visitor-') ? 'visitor' : name.includes('bluemap-') ? 'bluemap' : null;
      if (key) stats[key] = { cpu, mem, memPct, net };
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
    let existing = {};
    try { if (fs.existsSync(file)) existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const merged = { ...existing, visited: { ...(existing.visited || {}), ...settings.stateData } };
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
          const payload = buf.slice(12, 4 + len - 2).toString('utf8');
          client.destroy();
          resolve(payload || '(empty)');
        }
      }
    });
    client.on('error', () => { resolve('RCON connection failed'); });
    client.on('close', () => { resolve('RCON closed'); });
    setTimeout(() => { client.destroy(); resolve('RCON timeout'); }, 5000);
    client.write(createRconPacket(0, 3, RCON_PASS));
    setTimeout(() => { client.write(createRconPacket(0, 2, cmd)); }, 100);
  });
}

function createRconPacket(id, type, body) {
  const buf = Buffer.alloc(14 + body.length + 1);
  let off = 0;
  buf.writeInt32LE(10 + body.length, off); off += 4;
  buf.writeInt32LE(id, off); off += 4;
  buf.writeInt32LE(type, off); off += 4;
  buf.write(body, off, body.length, 'utf8'); off += body.length;
  buf.writeInt8(0, off); off += 1;
  buf.writeInt8(0, off);
  return buf;
}

function log(io, msg, level) { io.emit('log', { msg, level }); }

async function buildImage(io) {
  console.log('[build] building bot image...');
  log(io, 'Building bot Docker image...', 'info');
  const r = await compose('build visitor');
  console.log(`[build] ${r.ok ? 'SUCCESS' : 'FAILED'}`);
  if (!r.ok) console.log(`[build:err] ${(r.stderr || r.stdout).slice(-500)}`);
  log(io, r.ok ? 'Build complete' : 'Build FAILED: ' + (r.stderr || r.stdout).slice(-300), r.ok ? 'done' : 'error');
  return r.ok;
}

async function doPrune(io) {
  log(io, 'Prune: checking running containers...', 'info');
  io.emit('prune-step', { step: 1, total: 4, msg: 'Checking containers...' });
  const status = await getStatus();
  const running = Object.entries(status).filter(([,s]) => s === 'running');

  if (running.length > 0) {
    io.emit('prune-step', { step: 2, total: 4, msg: 'Stopping ' + running.map(([k]) => k).join(', ') + '...' });
    log(io, 'Stopping containers: ' + running.map(([k]) => k).join(', '), 'info');
    try { await compose('stop ' + running.map(([k]) => k).join(' ')); } catch {}
  }

  io.emit('prune-step', { step: 3, total: 4, msg: 'Removing containers...' });
  log(io, 'Removing containers...', 'info');
  try { await compose('down ' + Object.keys(status).join(' ') + ' 2>/dev/null'); } catch {}

  io.emit('prune-step', { step: 4, total: 4, msg: 'Rebuilding bot image...' });
  await buildImage(io);

  io.emit('prune-step', { step: 5, total: 5, msg: 'Starting all services...' });
  log(io, 'Starting fresh containers...', 'info');
  const r = await compose('up -d mc visitor bluemap');

  io.emit('prune-done', { ok: r.ok });
  log(io, r.ok ? 'Prune complete — all services restarted' : 'Prune failed: ' + (r.stderr || '').slice(-200), r.ok ? 'done' : 'error');
}

async function doAction(io, cmd) {
  console.log(`[action] ${cmd}`);
  if (cmd.startsWith('cmd:')) {
    const mcCmd = cmd.slice(4);
    log(io, '$ ' + mcCmd, 'info');
    const result = await rcon(mcCmd);
    io.emit('cmd-result', result);
    log(io, result.slice(0, 300), 'm');
    return;
  }

  log(io, '> ' + cmd, 'info');
  let r;
  switch (cmd) {
    case 'start-all':
      console.log('[action] starting all services...');
      r = await compose('up -d mc visitor bluemap');
      console.log(`[action] start-all: ${r.ok ? 'OK' : 'FAILED'} ${(r.stderr || '').slice(0, 200)}`);
      log(io, r.ok ? 'All services started' : 'Failed: ' + (r.stderr || '').slice(-200), r.ok ? 'done' : 'error');
      break;
    case 'stop-all':
      console.log('[action] stopping all services...');
      r = await compose('stop mc visitor bluemap');
      log(io, 'All services stopped', 'done');
      break;
    case 'prune': await doPrune(io); return;
    case 'start-mc': r = await compose('up -d --no-deps mc'); log(io, 'MC server starting...', 'info'); break;
    case 'stop-mc': r = await compose('stop mc'); log(io, 'MC server stopped', 'done'); break;
    case 'start-visitor': await buildImage(io); r = await compose('up -d --no-deps visitor'); log(io, 'Visitor starting...', 'info'); break;
    case 'stop-visitor': r = await compose('stop visitor'); log(io, 'Visitor stopped', 'done'); break;
    case 'start-bluemap': r = await compose('up -d --no-deps bluemap'); log(io, 'BlueMap started', 'done'); break;
    case 'stop-bluemap': r = await compose('stop bluemap'); log(io, 'BlueMap stopped', 'done'); break;
    case 'build': await buildImage(io); break;
    default: log(io, 'Unknown: ' + cmd, 'warn');
  }
  await pushAll(io);
}

async function pushAll(io, quiet) {
  const [status, progress, stats] = await Promise.all([getStatus(quiet), Promise.resolve(getProgress()), getStats(quiet)]);
  io.emit('status', { ...status, progress, stats, conn: getConnectionInfo() });
  if (!quiet) console.log('[push] status sent to clients');
}

function setupServer(p) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const server = http.createServer(app);
  return { app, server, io: new Server(server, { maxHttpBufferSize: 1e7 }) };
}

function mountRoutes(app, io) {
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/env', (req, res) => res.json(readEnv()));

  app.get('/api/states', (req, res) => {
    const states = {};
    try {
      if (fs.existsSync(stateDir)) {
        for (const f of fs.readdirSync(stateDir).filter(x => x.endsWith('.json'))) {
          try { states[f] = JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8')); }
          catch { states[f] = { error: 'invalid JSON' }; }
        }
      }
    } catch {}
    res.json(states);
  });

  app.post('/api/wizard', async (req, res) => {
    try { writeEnv(req.body); log(io, 'Configuration saved', 'done'); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post('/api/action', async (req, res) => { res.json({ ok: true }); doAction(io, req.body.cmd); });

  app.get('/map/*', (req, res) => res.redirect(`http://${DOMAIN}:${BLUEMAP_PORT}`));
}

async function main() {
  const s1 = setupServer(PORT);
  const s2 = setupServer(PORT2);

  mountRoutes(s1.app, s1.io);
  mountRoutes(s2.app, s2.io);

  [s1.io, s2.io].forEach(io => {
    io.on('connection', socket => {
      console.log('[socket] client connected');
      log(io, 'Connected', 'info');
      pushAll(io);
      socket.on('action', cmd => doAction(io, cmd));
    });
  });

  console.log('[timer] starting periodic status checks (every 4s, quiet)');
  setInterval(async () => {
    await pushAll(s1.io, true);
    await pushAll(s2.io, true);
  }, 4000);

  console.log('[timer] starting compose log streaming (every 5s)');
  setInterval(async () => {
    try {
      const mc = await run(`docker compose --project-directory ${PROJECT_DIR} logs mc --tail 5 --since 5s 2>/dev/null`, true);
      if (mc.stdout.trim()) for (const line of mc.stdout.trim().split('\n')) mclog(s1.io, line.slice(0, 500), 'm');
    } catch {}
    try {
      const bm = await run(`docker compose --project-directory ${PROJECT_DIR} logs bluemap --tail 5 --since 5s 2>/dev/null`, true);
      if (bm.stdout.trim()) for (const line of bm.stdout.trim().split('\n')) bmlog(s1.io, line.slice(0, 500), 'm');
    } catch {}
  }, 5000);

  s1.server.listen(PORT, () => console.log(`Panel: http://0.0.0.0:${PORT} (IP: ${LOCAL_IP})`));
  s2.server.listen(PORT2, () => console.log(`Panel: http://0.0.0.0:${PORT2} (IP: ${LOCAL_IP})`));
}

main().catch(console.error);
