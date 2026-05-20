const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_HOST_DIR = process.env.PROJECT_HOST_DIR || '/home/docker/world-visitor-bot';
const PROJECT_DIR = process.env.PROJECT_DIR || '/app/project';
const PORT = parseInt(process.env.PORT || '80');
const PORT2 = parseInt(process.env.PORT2 || '3000');
const DOMAIN = process.env.DOMAIN || 'bigheados.com';
const BLUEMAP_PORT = process.env.BLUEMAP_PORT || '8100';

const envPath = path.join(PROJECT_DIR, '.env');

function compose(args) {
  return new Promise((resolve) => {
    const cmd = `docker compose --project-directory ${PROJECT_HOST_DIR} ${args}`;
    exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', cmd });
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
  const { stdout } = await run(
    `docker stats mc visitor bluemap --no-stream --format '{{.Name}}:{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}' 2>/dev/null`
  );
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
    const stateDir = path.join(PROJECT_DIR, 'state');
    if (!fs.existsSync(stateDir)) return { regions: 0, total: 0, rx: 0, rz: 0, pct: 0 };
    const files = fs.readdirSync(stateDir).filter(f => f.startsWith('visited') && f.endsWith('.json'));
    let totalRegions = 0, visitedRegions = 0, rx = 0, rz = 0;
    for (const f of files) {
      const data = JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8'));
      if (data.visited) {
        const keys = Object.keys(data.visited);
        visitedRegions += keys.length;
        if (keys.length > 0) {
          const last = keys[keys.length - 1];
          const parts = last.split(',');
          rx = parseInt(parts[0]) || 0; rz = parseInt(parts[1]) || 0;
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
    for (const line of fs.readFileSync(envPath,'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) cfg[m[1]] = m[2];
    }
  } catch {}
  return cfg;
}

function writeEnv(settings) {
  fs.writeFileSync(envPath, [
    '# Overworld Visitor configuration',
    `MC_HOST=${settings.MC_HOST || 'mc'}`,
    `MC_PORT=${settings.MC_PORT || '25565'}`,
    `MC_USERNAME=${settings.MC_USERNAME || 'Bot'}`,
    `MC_AUTH=${settings.MC_AUTH || 'offline'}`,
    `RENDER_DISTANCE=${settings.RENDER_DISTANCE || '28'}`,
    `FLY_Y=${settings.FLY_Y || '200'}`,
    `GRID_STEP=${settings.GRID_STEP || '160'}`,
    `BOT_COUNT=${settings.BOT_COUNT || '1'}`,
    `WORLD_PATH=${settings.WORLD_PATH || './mc-data/world'}`,
    `WP_DELAY=${settings.WP_DELAY || '2000'}`,
    `REGION_DELAY=${settings.REGION_DELAY || '2000'}`,
    `CHUNK_LOAD_TIMEOUT=${settings.CHUNK_LOAD_TIMEOUT || '60000'}`,
    `BLUEMAP_HOST=${settings.BLUEMAP_HOST || 'bluemap'}`,
    `BLUEMAP_PORT=${settings.BLUEMAP_PORT || '8100'}`,
    `BLUEMAP_MAP=${settings.BLUEMAP_MAP || 'overworld'}`,
    `FOLLOW_PLAYER=${settings.FOLLOW_PLAYER || ''}`,
    ''
  ].join('\n'));
}

function log(io, msg, level) { io.emit('log', { msg, level, time: new Date().toISOString() }); }
function mclog(io, msg, level) { io.emit('mclog', { msg, level, time: new Date().toISOString() }); }

async function buildImage(io) {
  log(io, 'Building bot image...', 'info');
  const r = await compose('build visitor');
  log(io, r.ok ? 'Build complete' : 'Build FAILED: '+(r.stderr||r.stdout), r.ok?'done':'error');
  return r.ok;
}

async function doAction(io, cmd) {
  log(io, '[action] '+cmd, 'info');
  let r;
  switch (cmd) {
    case 'start-all': r = await compose('up -d mc visitor bluemap'); log(io, r.ok?'All started':'Start failed: '+(r.stderr||''), r.ok?'done':'error'); break;
    case 'stop-all': r = await compose('stop mc visitor bluemap'); log(io, 'All stopped', 'done'); break;
    case 'prune':
      log(io, 'Pruning containers...', 'info');
      await compose('down mc visitor bluemap 2>/dev/null');
      await buildImage(io);
      r = await compose('up -d mc visitor bluemap');
      log(io, r.ok?'Prune complete':'Prune failed: '+(r.stderr||''), r.ok?'done':'error');
      break;
    case 'start-mc': r = await compose('up -d --no-deps mc'); log(io, 'MC starting...', 'info'); break;
    case 'stop-mc': r = await compose('stop mc'); log(io, 'MC stopped', 'done'); break;
    case 'start-visitor': await buildImage(io); r = await compose('up -d --no-deps visitor'); log(io, r.ok?'Visitor started':'Visitor start failed', r.ok?'done':'error'); break;
    case 'stop-visitor': r = await compose('stop visitor'); log(io, 'Visitor stopped', 'done'); break;
    case 'start-bluemap': r = await compose('up -d --no-deps bluemap'); log(io, 'BlueMap started', 'done'); break;
    case 'stop-bluemap': r = await compose('stop bluemap'); log(io, 'BlueMap stopped', 'done'); break;
    case 'build': await buildImage(io); break;
    default: log(io, 'Unknown: '+cmd, 'warn');
  }
  const status = await getStatus();
  const progress = getProgress();
  const stats = await getStats();
  io.emit('status', { ...status, progress, stats, domain: DOMAIN, bluemapPort: BLUEMAP_PORT });
}

function setupServer(port) {
  const app = express();
  app.use(express.json());
  const server = http.createServer(app);
  return { app, server, io: new Server(server) };
}

async function main() {
  const s1 = setupServer(PORT);
  const s2 = setupServer(PORT2);

  s1.app.use(express.static(path.join(__dirname, 'public')));
  s2.app.use(express.static(path.join(__dirname, 'public')));

  s1.app.get('/api/env', (req, res) => res.json(readEnv()));
  s1.app.post('/api/wizard', async (req, res) => {
    try { writeEnv(req.body); log(s1.io, 'Configuration saved', 'done'); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });
  s1.app.post('/api/action', async (req, res) => { res.json({ ok: true }); doAction(s1.io, req.body.cmd); });
  s1.app.get('/map/*', (req, res) => res.redirect(`http://${DOMAIN}:${BLUEMAP_PORT}`));

  async function pushData(io) {
    const [status, progress, stats] = await Promise.all([getStatus(), Promise.resolve(getProgress()), getStats()]);
    io.emit('status', { ...status, progress, stats, domain: DOMAIN, bluemapPort: BLUEMAP_PORT });
  }

  [s1.io, s2.io].forEach(io => {
    io.on('connection', socket => {
      log(io, 'Connected', 'info');
      pushData(io);
      socket.on('action', cmd => doAction(io, cmd));
    });
  });

  setInterval(() => { pushData(s1.io); pushData(s2.io); }, 4000);

  s1.server.listen(PORT, () => console.log('Control: http://0.0.0.0:'+PORT));
  s2.server.listen(PORT2, () => console.log('Control: http://0.0.0.0:'+PORT2));
}

main().catch(console.error);
