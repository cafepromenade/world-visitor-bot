const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_DIR = process.env.PROJECT_DIR || '/app/project';
const PORT = parseInt(process.env.PORT || '80');
const PORT2 = parseInt(process.env.PORT2 || '3000');
const DOMAIN = process.env.DOMAIN || 'bigheados.com';
const BLUEMAP_PORT = process.env.BLUEMAP_PORT || '8100';
const MC_PORT = '25565';
const envPath = path.join(PROJECT_DIR, '.env');
const stateDir = path.join(PROJECT_DIR, 'state');
const ALL_VISITOR_SERVICES = ['visitor', 'visitor1', 'visitor2', 'visitor3'];
const ALL_MANAGED_SERVICES = ['mc', ...ALL_VISITOR_SERVICES, 'bluemap'];

let etaData = { regionsStarted: 0, firstRegionAt: null, lastRegionAt: null, wpTotal: 0, wpDone: 0, wpStart: null };
let seenMcLogs = [];
let seenBmLogs = [];
let seenVisitorLogs = [];

function getLocalIP() {
  const provided = process.env.HOST_IP;
  if (provided) return provided;
  try {
    const { execSync } = require('child_process');
    const gw = execSync("ip route get 1 2>/dev/null | awk '{print $7;exit}'").toString().trim();
    if (gw && !gw.startsWith('172.')) return gw;
  } catch {}
  return 'localhost';
}
const LOCAL_IP = getLocalIP();

function getConnectionInfo() {
  return { primary: DOMAIN, fallback: LOCAL_IP, port: MC_PORT };
}

function getBotCount() {
  const parsed = parseInt(readEnv().BOT_COUNT || process.env.BOT_COUNT || '1', 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(4, parsed));
}

function visitorServices(count = getBotCount()) {
  return ALL_VISITOR_SERVICES.slice(0, count);
}

function botStackServices(count = getBotCount()) {
  return ['mc', ...visitorServices(count), 'bluemap'];
}

function composeProfile(count = getBotCount()) {
  return count > 1 ? '--profile multi ' : '';
}

function parseComposeStatus(out) {
  const status = out.trim().toLowerCase();
  if (!status) return 'stopped';
  if (status.includes('health: starting') || status.includes('starting')) return 'starting';
  if (status.includes('up')) return 'running';
  return 'stopped';
}

function aggregateComposeStatus(out) {
  const statuses = out.split('\n').filter(Boolean).map(parseComposeStatus);
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('starting')) return 'starting';
  return 'stopped';
}

function compose(args) {
  const cmd = `docker compose --project-directory ${PROJECT_DIR} ${args}`;
  console.log(`[compose] ${cmd}`);
  return new Promise(resolve => {
    exec(cmd, { timeout: 180000, maxBuffer: 1024*1024*10 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout||'', stderr: stderr||'' });
    });
  });
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function run(cmd, quiet) {
  if (!quiet) console.log(`[run] ${cmd}`);
  return new Promise(resolve => {
    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout||'', stderr: stderr||'' });
    });
  });
}

async function getStatus(quiet) {
  const [mc, vis, bm] = await Promise.all([
    run(`docker compose --project-directory ${PROJECT_DIR} ps mc --format '{{.Status}}' 2>/dev/null`, quiet),
    run(`docker compose --project-directory ${PROJECT_DIR} ps ${ALL_VISITOR_SERVICES.join(' ')} --format '{{.Status}}' 2>/dev/null`, quiet),
    run(`docker compose --project-directory ${PROJECT_DIR} ps bluemap --format '{{.Status}}' 2>/dev/null`, quiet),
  ]);
  return { mc: parseComposeStatus(mc.stdout), visitor: aggregateComposeStatus(vis.stdout), bluemap: parseComposeStatus(bm.stdout) };
}

async function getStats(quiet) {
  const { stdout } = await run(`docker stats --no-stream --format '{{.Name}}:{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}' 2>/dev/null`, quiet);
  const s = {};
  for (const line of stdout.split('\n').filter(Boolean)) {
    const [n, r] = line.split(':');
    const service = (n.match(/-([^-]+)-\d+$/) || [])[1] || '';
    if (r && (service === 'mc' || /^visitor\d*$/.test(service) || service === 'bluemap')) {
      const [cpu, mem, mp, net] = r.split('|');
      const k = service === 'mc' ? 'mc' : service.startsWith('visitor') ? 'visitor' : service === 'bluemap' ? 'bluemap' : null;
      if (k) s[k] = { cpu, mem, memPct: mp, net };
    }
  }
  return s;
}

function getProgress() {
  try {
    if (!fs.existsSync(stateDir)) return { regions:0,total:0,rx:0,rz:0,pct:0 };
    const files = fs.readdirSync(stateDir).filter(f => f.startsWith('visited') && f.endsWith('.json'));
    if (!files.length) return { regions:0,total:0,rx:0,rz:0,pct:0 };
    const visited = new Set(); let maxTotal=0, rx=0, rz=0;
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(stateDir,f),'utf8'));
        if (d.visited) for (const k of Object.keys(d.visited)) visited.add(k);
        if (d.total && d.total > maxTotal) maxTotal = d.total;
      } catch {}
    }
    if (visited.size > 0) {
      const parts = [...visited].pop().split(',');
      rx = parseInt(parts[0])||0; rz = parseInt(parts[1])||0;
    }
    const pct = maxTotal > 0 ? Math.min(100, Math.round(visited.size/Math.max(maxTotal,visited.size)*100)) : 0;
    return { regions: visited.size, total: maxTotal||visited.size, rx, rz, pct };
  } catch { return { regions:0,total:0,rx:0,rz:0,pct:0 }; }
}

function getETA() {
  const now = Date.now();
  const d = etaData;
  const p = getProgress();
  const e = { wp: '', region: '', total: '', wpPct: 0, wpDone: d.wpDone, wpTotal: d.wpTotal };

  // Waypoint ETA
  if (d.wpStart && d.wpTotal > 0 && d.wpDone > 0) {
    const wpElapsed = (now - d.wpStart)/1000;
    const wpAvg = wpElapsed / d.wpDone;
    const wpRemaining = (d.wpTotal - d.wpDone) * wpAvg;
    e.wp = fmtEstimate(wpRemaining);
    e.wpPct = Math.min(100, Math.round(d.wpDone/d.wpTotal*100));
  }

  // Region ETA
  if (d.lastRegionAt && d.firstRegionAt && d.regionsStarted > 1) {
    const regElapsed = (d.lastRegionAt - d.firstRegionAt)/1000;
    const regAvg = regElapsed / (d.regionsStarted - 1);
    const regRemaining = Math.max(0, p.total - p.regions) * regAvg;
    e.region = fmtEstimate(regRemaining);
  }

  // Total ETA = same as region ETA if we don't have waypoint granularity
  if (e.wp) e.total = fmtEstimate(Math.max(0, (d.wpTotal - d.wpDone) * ((d.wpStart && d.wpDone > 0) ? (now - d.wpStart)/1000/d.wpDone : 60)));
  else if (e.region) e.total = e.region;

  return e;
}

function fmtDuration(sec) {
  if (sec <= 0) return '--';
  if (sec < 60) return Math.round(sec)+'s';
  if (sec < 3600) return Math.floor(sec/60)+'m '+Math.round(sec%60)+'s';
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60);
  return h+'h '+m+'m';
}

function fmtEstimate(sec) {
  if (sec <= 0) return 'now';
  const when = new Date(Date.now() + Math.max(0, sec) * 1000).toLocaleString('en-GB', { hour12: false });
  return `${fmtDuration(sec)} @ ${when}`;
}

function readEnv() {
  const cfg = {};
  try { for (const line of fs.readFileSync(envPath,'utf8').split('\n')) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) cfg[m[1]]=m[2]; } } catch {}
  return cfg;
}

function writeEnv(settings) {
  fs.writeFileSync(envPath, [
    '# Overworld Visitor', `MC_HOST=mc`, `MC_PORT=25565`,
    `MC_USERNAME=${settings.MC_USERNAME||'Bot'}`, `MC_AUTH=offline`,
    `RENDER_DISTANCE=${settings.RENDER_DISTANCE||'28'}`,
    `FLY_Y=${settings.FLY_Y||'200'}`, `GRID_STEP=${settings.GRID_STEP||'160'}`,
    `BOT_COUNT=${settings.BOT_COUNT||'1'}`, `WORLD_PATH=${settings.WORLD_PATH||'./mc-data/world'}`,
    `WP_DELAY=2000`, `REGION_DELAY=2000`, `CHUNK_LOAD_TIMEOUT=60000`,
    `MC_MEMORY=${settings.MC_MEMORY||'12G'}`, `BOT_MEMORY=${settings.BOT_MEMORY||'2G'}`,
    `BLUEMAP_HOST=bluemap`, `BLUEMAP_PORT=8100`, `BLUEMAP_MAP=overworld`,
    `FOLLOW_PLAYER=${settings.FOLLOW_PLAYER||''}`, ''
  ].join('\n'));
  if (settings.stateData) {
    const file = path.join(stateDir,'visited.json');
    let existing = {};
    try { if (fs.existsSync(file)) existing = JSON.parse(fs.readFileSync(file,'utf8')); } catch {}
    const merged = { ...existing, visited: { ...(existing.visited||{}), ...settings.stateData } };
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(merged, null, 2));
  }
}

async function runServerCommand(cmd) {
  const result = await compose(`exec -T mc rcon-cli ${shQuote(cmd)}`);
  if (result.ok) return (result.stdout || '(empty)').trim();
  return (result.stderr || result.stdout || 'Command failed').trim();
}

function elog(target, msg, level) {
  const ios = Array.isArray(target) ? target : [target];
  ios.forEach(io => io.emit('log', { msg, level: level||'m' }));
}
function emc(io, msg) { io.emit('mclog', { msg, level: 'm' }); }
function ebm(io, msg) { io.emit('bmlog', { msg, level: 'm' }); }

async function syncVisitorLogs(ios) {
  try {
    const { stdout } = await run(`docker compose --project-directory ${PROJECT_DIR} logs ${ALL_VISITOR_SERVICES.join(' ')} --tail 12 2>/dev/null`, true);
    if (!stdout.trim()) return;
    const lines = stdout.trim().split('\n');
    for (const line of lines.slice(-8)) {
      if (seenVisitorLogs.includes(line)) continue;
      seenVisitorLogs.push(line);
      if (seenVisitorLogs.length > 200) seenVisitorLogs.shift();
      ios.forEach(io => io.emit('visitor-log', { msg: line.slice(0,500) }));

      // Parse waypoint progress: "waypoint 3/9 @"
      const wpMatch = line.match(/waypoint\s+(\d+)\/(\d+)/);
      if (wpMatch) {
        etaData.wpDone = parseInt(wpMatch[1]);
        etaData.wpTotal = parseInt(wpMatch[2]);
        etaData.wpStart = etaData.wpStart || Date.now();
      }

      // Parse region start: "Region (rx, rz) @"
      const regStart = line.match(/Region\s+\((-?\d+),\s*(-?\d+)\)\s+@/);
      if (regStart) {
        if (!etaData.firstRegionAt) etaData.firstRegionAt = Date.now();
        etaData.lastRegionAt = Date.now();
        etaData.regionsStarted++;
        etaData.wpDone = 0; etaData.wpTotal = 0; etaData.wpStart = null;
      }

      // Parse region complete: "Region ... complete in"
      const regDone = line.match(/Region\s+\((-?\d+),\s*(-?\d+)\)\s+complete/);
      if (regDone) {
        etaData.lastRegionAt = Date.now();
      }
    }
  } catch {}
}

async function doPrune(ios) {
  const emit = (step, total, msg, detail) => {
    ios.forEach(io => io.emit('prune-step', { step, total, msg, detail: detail||'' }));
  };

  emit(1, 5, 'Checking running containers...', '');
  elog(ios, 'Prune: scanning containers', 'info');
  const status = await getStatus();
  const running = Object.entries(status).filter(([,s]) => s === 'running');

  if (running.length > 0) {
    const names = running.map(([k]) => k).join(', ');
    emit(2, 5, 'Stopping: ' + names, 'docker compose stop ' + names);
    elog(ios, 'Prune: stopping ' + names, 'info');
    const r = await compose('stop ' + ALL_MANAGED_SERVICES.join(' '));
    emit(2, 5, 'Stopped: ' + names, r.stdout.slice(0,300) || r.stderr.slice(0,300) || 'done');
  } else {
    emit(2, 5, 'No running containers', 'nothing to stop');
  }

  emit(3, 5, 'Removing containers...', 'docker compose rm -sf ' + ALL_MANAGED_SERVICES.join(' '));
  elog(ios, 'Prune: removing containers', 'info');
  const dr = await compose('rm -sf ' + ALL_MANAGED_SERVICES.join(' '));
  emit(3, 5, 'Removed', dr.stdout.slice(0,200) || 'done');

  emit(4, 5, 'Building bot image...', 'docker compose build visitor');
  elog(ios, 'Prune: building bot image', 'info');
  const br = await compose('build visitor');
  emit(4, 5, br.ok ? 'Build complete' : 'Build FAILED', br.stdout.slice(-300) || br.stderr.slice(-300));

  emit(5, 5, 'Prune complete', '');
  ios.forEach(io => io.emit('prune-done', { ok: br.ok }));
  elog(ios, br.ok ? 'Prune complete - services not started' : 'Prune FAILED', br.ok ? 'done' : 'error');
}

async function doAction(ios, cmd) {
  console.log(`[action] ${cmd}`);
  if (cmd.startsWith('cmd:')) {
    const mcCmd = cmd.slice(4); elog(ios, '$ '+mcCmd, 'info');
    const result = await runServerCommand(mcCmd);
    ios.forEach(io => io.emit('cmd-result', result));
    elog(ios, result.slice(0,300), 'm');
    return;
  }
  if (cmd === 'force-stop') {
    elog(ios, 'Force stopping all bot containers...', 'info');
    await compose('kill ' + ALL_MANAGED_SERVICES.join(' ') + ' 2>/dev/null');
    await compose('rm -sf ' + ALL_MANAGED_SERVICES.join(' '));
    elog(ios, 'Force stop complete', 'done');
    await pushAllClients(ios); return;
  }
  elog(ios, '> '+cmd, 'info');
  let r;
  switch (cmd) {
    case 'run-bot':
    case 'start-all': {
      const count = getBotCount();
      r = await compose(`${composeProfile(count)}up -d ${botStackServices(count).join(' ')}`);
      etaData = { regionsStarted:0, firstRegionAt:null, lastRegionAt:null, wpTotal:0, wpDone:0, wpStart:null };
      elog(ios, r.ok?`Bot stack started (${count} bot${count===1?'':'s'})`:'FAILED: '+(r.stderr||'').slice(-200), r.ok?'done':'error');
      break;
    }
    case 'stop-all': r = await compose('stop ' + ALL_MANAGED_SERVICES.join(' ')); elog(ios, 'All stopped', 'done'); break;
    case 'prune': await doPrune(ios); return;
    case 'start-mc': elog(ios, 'Start MC directly is disabled. Use Run the Bot.', 'warn'); break;
    case 'stop-mc': r = await compose('stop mc'); elog(ios, 'MC stopped', 'done'); break;
    case 'start-visitor': elog(ios, 'Start visitor directly is disabled. Use Run the Bot.', 'warn'); break;
    case 'stop-visitor': r = await compose('stop ' + ALL_VISITOR_SERVICES.join(' ')); elog(ios, 'Visitor stopped', 'done'); break;
    case 'start-bluemap': {
      const status = await getStatus(true);
      if (status.mc !== 'stopped' || status.visitor !== 'stopped') {
        elog(ios, 'Standalone BlueMap can only start when the bot stack is stopped.', 'warn');
        break;
      }
      r = await compose('up -d --no-deps bluemap'); elog(ios, 'BlueMap started', 'done'); break;
    }
    case 'stop-bluemap': r = await compose('stop bluemap'); elog(ios, 'BlueMap stopped', 'done'); break;
    case 'build': await compose('build visitor'); elog(ios, 'Build done', 'done'); break;
    default: elog(ios, 'Unknown: '+cmd, 'warn');
  }
  await pushAllClients(ios);
}

async function pushAll(io, quiet) {
  const [status, progress, stats] = await Promise.all([getStatus(quiet), Promise.resolve(getProgress()), getStats(quiet)]);
  io.emit('status', { ...status, progress, stats, eta: getETA(), conn: getConnectionInfo() });
}

async function pushAllClients(ios, quiet) {
  await Promise.all(ios.map(io => pushAll(io, quiet)));
}

function setupServer(p) {
  const app = express(); app.use(express.json({ limit: '10mb' }));
  const srv = http.createServer(app);
  return { app, server: srv, io: new Server(srv, { maxHttpBufferSize: 1e7 }) };
}

function mountRoutes(app, ios) {
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/api/env', (req, res) => res.json(readEnv()));
  app.get('/api/states', (req, res) => {
    const states = {};
    try { if (fs.existsSync(stateDir)) for (const f of fs.readdirSync(stateDir).filter(x => x.endsWith('.json'))) { try { states[f]=JSON.parse(fs.readFileSync(path.join(stateDir,f),'utf8')); } catch { states[f]={error:'invalid JSON'}; } } } catch {}
    res.json(states);
  });
  app.post('/api/wizard', async (req, res) => {
    try { writeEnv(req.body); elog(ios, 'Config saved', 'done'); res.json({ok:true}); }
    catch (err) { res.status(500).json({ok:false, error:err.message}); }
  });
  app.post('/api/action', async (req, res) => { res.json({ok:true}); doAction(ios, req.body.cmd); });
  app.get('/map/*', (req, res) => res.redirect(`http://${DOMAIN}:${BLUEMAP_PORT}`));
}

async function main() {
  const s1 = setupServer(PORT), s2 = setupServer(PORT2);
  const ios = [s1.io, s2.io];
  mountRoutes(s1.app, ios); mountRoutes(s2.app, ios);

  ios.forEach(io => { io.on('connection', socket => { elog(io, 'Connected', 'info'); pushAll(io); socket.on('action', cmd => doAction(ios, cmd)); }); });

  setInterval(async () => {
    for (const io of ios) await pushAll(io, true);
    await syncVisitorLogs(ios);
    try {
      const { stdout } = await run(`docker compose --project-directory ${PROJECT_DIR} logs mc --tail 12 2>/dev/null`, true);
      for (const line of stdout.trim().split('\n').filter(Boolean).slice(-8)) {
        if (seenMcLogs.includes(line)) continue;
        seenMcLogs.push(line);
        if (seenMcLogs.length > 200) seenMcLogs.shift();
        ios.forEach(io => emc(io, line.slice(0,500)));
      }
    } catch {}
    try {
      const { stdout } = await run(`docker compose --project-directory ${PROJECT_DIR} logs bluemap --tail 12 2>/dev/null`, true);
      for (const line of stdout.trim().split('\n').filter(Boolean).slice(-8)) {
        if (seenBmLogs.includes(line)) continue;
        seenBmLogs.push(line);
        if (seenBmLogs.length > 200) seenBmLogs.shift();
        ios.forEach(io => ebm(io, line.slice(0,500)));
      }
    } catch {}
  }, 4000);

  s1.server.listen(PORT, () => console.log(`Panel: http://0.0.0.0:${PORT} (IP: ${LOCAL_IP})`));
  s2.server.listen(PORT2, () => console.log(`Panel: http://0.0.0.0:${PORT2} (IP: ${LOCAL_IP})`));
}

main().catch(console.error);
