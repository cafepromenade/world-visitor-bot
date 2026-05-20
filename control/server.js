const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const PROJECT_DIR = process.env.PROJECT_DIR || '/app/project';
const PORT = parseInt(process.env.PORT || '80');
const PORT2 = parseInt(process.env.PORT2 || '3000');
const DOMAIN = process.env.DOMAIN || 'bigheados.com';
const BLUEMAP_PORT = '8100';
const MC_PORT = '25565';
const envPath = path.join(PROJECT_DIR, '.env');
const stateDir = path.join(PROJECT_DIR, 'state');
const bluemapWebDir = path.join(PROJECT_DIR, 'web');
const bluemapMapConfig = path.join(PROJECT_DIR, 'config', 'maps', 'overworld.conf');
const bluemapMarkersJson = path.join(bluemapWebDir, 'maps', 'overworld', 'live', 'markers.json');
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME || path.basename(PROJECT_DIR);
const ALL_VISITOR_SERVICES = ['visitor', 'visitor1', 'visitor2', 'visitor3'];
const ALL_MANAGED_SERVICES = ['mc', ...ALL_VISITOR_SERVICES, 'bluemap'];

let etaData = { regionsStarted: 0, firstRegionAt: null, lastRegionAt: null, wpTotal: 0, wpDone: 0, wpStart: null };
let seenMcLogs = [];
let seenBmLogs = [];
let seenVisitorLogs = [];
let logBotStatuses = new Map();

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

function getBlueMapUrls() {
  return {
    primary: `http://${DOMAIN}:${BLUEMAP_PORT}`,
    fallback: `http://${LOCAL_IP}:${BLUEMAP_PORT}`,
    port: BLUEMAP_PORT,
    staticUrl: '/bluemap/'
  };
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
  return ['mc', ...visitorServices(count)];
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

function prepareWritableDirs() {
  const dirs = ['data', 'web', 'state', 'config'].map(d => shQuote(path.join(PROJECT_DIR, d))).join(' ');
  const cmd = `mkdir -p ${dirs} && chown -R 1000:1000 ${dirs} 2>/dev/null || true; chmod -R u+rwX,g+rwX ${dirs} 2>/dev/null || true`;
  console.log('[run] preparing writable BlueMap/bot directories');
  return new Promise(resolve => {
    exec(cmd, { timeout: 180000, maxBuffer: 1024*1024*10 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout||'', stderr: stderr||'' });
    });
  });
}

function isTcpOpen(host, port, timeout = 1200) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port, timeout }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

async function getServiceStatusByLabel(service, quiet) {
  const filters = `--filter ${shQuote(`label=com.docker.compose.project=${COMPOSE_PROJECT}`)} --filter ${shQuote(`label=com.docker.compose.service=${service}`)}`;
  const { stdout } = await run(`docker ps -a ${filters} --format '{{.Status}}' 2>/dev/null`, quiet);
  return aggregateComposeStatus(stdout);
}

async function getServiceContainerByLabel(service, quiet) {
  const filters = `--filter ${shQuote(`label=com.docker.compose.project=${COMPOSE_PROJECT}`)} --filter ${shQuote(`label=com.docker.compose.service=${service}`)}`;
  const { stdout } = await run(`docker ps -a ${filters} --format '{{.Names}}' 2>/dev/null`, quiet);
  return stdout.trim().split('\n').filter(Boolean)[0] || '';
}

async function getManagedContainerNames(quiet) {
  const names = [];
  for (const service of ALL_MANAGED_SERVICES) {
    const filters = `--filter ${shQuote(`label=com.docker.compose.project=${COMPOSE_PROJECT}`)} --filter ${shQuote(`label=com.docker.compose.service=${service}`)}`;
    const { stdout } = await run(`docker ps -a ${filters} --format '{{.Names}}' 2>/dev/null`, quiet);
    names.push(...stdout.trim().split('\n').filter(Boolean));
  }
  return [...new Set(names)];
}

async function getContainerWritableBytes(names, quiet) {
  if (!names.length) return 0;
  const { stdout } = await run(`docker inspect --size --format '{{.SizeRw}}' ${names.map(shQuote).join(' ')} 2>/dev/null`, quiet);
  return stdout.split('\n').reduce((sum, line) => sum + (parseInt(line, 10) || 0), 0);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

async function getBlueMapMode(status, quiet) {
  if (await isTcpOpen('mc', parseInt(BLUEMAP_PORT, 10))) return 'web';
  const container = await getServiceContainerByLabel('bluemap', quiet);
  if (!container || status.bluemap !== 'running') return '';
  const { stdout } = await run(`docker inspect --format '{{json .Config.Cmd}}' ${shQuote(container)} 2>/dev/null`, quiet);
  let cmd = [];
  try { cmd = JSON.parse(stdout.trim() || '[]'); } catch {}
  return cmd.includes('-w') ? 'web' : 'cli';
}

async function getBlueMapInfo(status, quiet) {
  const urls = getBlueMapUrls();
  const staticAvailable = fs.existsSync(path.join(bluemapWebDir, 'index.html'));
  const mode = await getBlueMapMode(status, quiet);
  if (mode === 'web') {
    return { available: true, mode, label: 'Live BlueMap', ...urls };
  }
  if (mode === 'cli') {
    return { available: staticAvailable, mode, label: 'CLI BlueMap render output', ...urls };
  }
  if (staticAvailable) {
    return { available: true, mode: 'static', label: 'Last BlueMap render output', ...urls };
  }
  return { available: false, mode: 'none', label: 'BlueMap is not available yet', ...urls };
}

async function getStatus(quiet) {
  const [mc, vis, bmLabel] = await Promise.all([
    run(`docker compose --project-directory ${PROJECT_DIR} ps mc --format '{{.Status}}' 2>/dev/null`, quiet),
    run(`docker compose --project-directory ${PROJECT_DIR} ps ${ALL_VISITOR_SERVICES.join(' ')} --format '{{.Status}}' 2>/dev/null`, quiet),
    getServiceStatusByLabel('bluemap', quiet),
  ]);
  let mcStatus = parseComposeStatus(mc.stdout);
  if (mcStatus === 'running' && !(await isTcpOpen('mc', 25565))) mcStatus = 'starting';
  const liveBlueMap = await isTcpOpen('mc', parseInt(BLUEMAP_PORT, 10));
  return { mc: mcStatus, visitor: aggregateComposeStatus(vis.stdout), bluemap: liveBlueMap ? 'running' : bmLabel };
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
    const worldTotal = countWorldRegions();
    if (!files.length) return { regions:0,total:worldTotal,rx:0,rz:0,pct:0 };
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
    const total = worldTotal || maxTotal || visited.size;
    const pct = total > 0 ? Math.min(100, Math.round(visited.size/Math.max(total,visited.size)*100)) : 0;
    return { regions: visited.size, total, rx, rz, pct };
  } catch { return { regions:0,total:0,rx:0,rz:0,pct:0 }; }
}

function countWorldRegions() {
  const cfg = readEnv();
  const rawWorldPath = cfg.WORLD_PATH || './mc-data/world';
  const worldPath = path.isAbsolute(rawWorldPath) ? rawWorldPath : path.resolve(PROJECT_DIR, rawWorldPath);
  const dirs = [
    path.join(worldPath, 'dimensions', 'minecraft', 'overworld', 'region'),
    path.join(worldPath, 'region')
  ];
  for (const dir of dirs) {
    try {
      if (fs.existsSync(dir)) return fs.readdirSync(dir).filter(f => /^r\.-?\d+\.-?\d+\.mca$/.test(f)).length;
    } catch {}
  }
  return 0;
}

function getBotStatuses() {
  const dir = path.join(stateDir, 'bots');
  try {
    const fallback = new Map(logBotStatuses);
    const merge = status => {
      if (!status?.id || !status?.position) return;
      const existing = fallback.get(status.id);
      if (!existing || Date.parse(status.updatedAt || '') >= Date.parse(existing.updatedAt || '')) {
        fallback.set(status.id, status);
      }
    };
    if (!fs.existsSync(dir)) return [...fallback.values()].sort((a, b) => (a.index || 0) - (b.index || 0));
    fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
        catch { return null; }
      })
      .forEach(merge);
    return [...fallback.values()].filter(s => s?.id && s?.position && Number.isFinite(s.position.x) && Number.isFinite(s.position.y) && Number.isFinite(s.position.z)).map(s => ({
        id: String(s.id),
        index: Number.isFinite(s.index) ? s.index : 0,
        username: String(s.username || s.id),
        status: String(s.status || 'unknown'),
        position: s.position,
        region: s.region || '',
        waypoint: s.waypoint || '',
        updatedAt: s.updatedAt || '',
      }))
      .sort((a, b) => a.index - b.index);
  } catch {
    return [...logBotStatuses.values()];
  }
}

function updateBotStatusFromLog(line) {
  const prefixed = line.match(/^([A-Za-z0-9_-]+)\s+\|\s+(.*)$/);
  const source = prefixed ? prefixed[1] : 'visitor';
  const msg = prefixed ? prefixed[2] : line;
  const serviceMatch = source.match(/visitor(\d*)/);
  if (!serviceMatch) return;
  const index = serviceMatch[1] ? parseInt(serviceMatch[1], 10) : 0;
  const id = `bot${index}`;
  const cfg = readEnv();
  const username = `${cfg.MC_USERNAME || 'Bot'}${getBotCount() > 1 ? index : ''}`;
  const current = logBotStatuses.get(id) || { id, index, username, status: 'running', position: null, updatedAt: '', region: '', waypoint: '' };
  const waypoint = msg.match(/waypoint\s+(\d+)\/(\d+)\s+@\s+\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/);
  const region = msg.match(/Region\s+\((-?\d+),\s*(-?\d+)\)\s+@\s+\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/);
  const match = waypoint || region;
  if (!match) return;
  const offset = waypoint ? 3 : 3;
  current.status = waypoint ? 'waypoint' : 'region';
  current.position = { x: parseFloat(match[offset]), y: parseFloat(match[offset + 1]), z: parseFloat(match[offset + 2]) };
  if (waypoint) current.waypoint = `${match[1]}/${match[2]}`;
  if (region) current.region = `${match[1]},${match[2]}`;
  current.updatedAt = new Date().toISOString();
  logBotStatuses.set(id, current);
}

function getMarkerInfo() {
  try {
    if (!fs.existsSync(bluemapMarkersJson)) return { present: false, updatedAt: '', set: 'World Visitor Bots' };
    const markers = JSON.parse(fs.readFileSync(bluemapMarkersJson, 'utf8'));
    const stat = fs.statSync(bluemapMarkersJson);
    return {
      present: Boolean(markers['world-visitor-bots']),
      updatedAt: stat.mtime.toISOString(),
      set: 'World Visitor Bots'
    };
  } catch {
    return { present: false, updatedAt: '', set: 'World Visitor Bots' };
  }
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
      updateBotStatusFromLog(line);
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
  const beforeNames = await getManagedContainerNames(true);
  const beforeBytes = await getContainerWritableBytes(beforeNames, true);
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

  const reclaimed = formatBytes(beforeBytes);
  emit(5, 5, 'Prune complete', `Estimated container writable space cleared: ${reclaimed}`);
  ios.forEach(io => io.emit('prune-done', { ok: br.ok, reclaimed }));
  elog(ios, br.ok ? `Prune complete - ${reclaimed} cleared, services not started` : 'Prune FAILED', br.ok ? 'done' : 'error');
}

async function doStop(ios, force = false) {
  const emit = (step, total, msg, detail) => ios.forEach(io => io.emit('op-step', { step, total, msg, detail: detail || '' }));
  emit(1, 4, force ? 'Force stopping visitor bots...' : 'Stopping visitor bots...', 'This prevents duplicate actions while containers shut down.');
  elog(ios, force ? 'Force stopping stack...' : 'Stopping stack...', 'info');
  const stopCmd = force ? 'kill' : 'stop';
  let r = await compose(`${stopCmd} ${ALL_VISITOR_SERVICES.join(' ')} 2>/dev/null`);
  emit(2, 4, 'Visitor bots stopped', r.stdout.slice(-500) || r.stderr.slice(-500) || 'done');
  r = await compose(`${stopCmd} mc 2>/dev/null`);
  emit(3, 4, 'Minecraft server stopped', r.stdout.slice(-500) || r.stderr.slice(-500) || 'done');
  r = await compose(`${stopCmd} bluemap 2>/dev/null`);
  if (force) await compose('rm -sf ' + ALL_MANAGED_SERVICES.join(' '));
  emit(4, 4, 'Stop complete', r.stdout.slice(-500) || r.stderr.slice(-500) || 'BlueMap CLI was not running');
  ios.forEach(io => io.emit('op-done', { ok: true, msg: 'Stop complete' }));
  elog(ios, 'Stop complete', 'done');
  await pushAllClients(ios);
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
  if (cmd.startsWith('tp-bot:')) {
    const [, playerRaw, botRaw] = cmd.split(':');
    const player = decodeURIComponent(playerRaw || '').trim();
    const botId = decodeURIComponent(botRaw || '').trim();
    if (!/^[A-Za-z0-9_]{1,16}$/.test(player)) {
      elog(ios, 'Teleport failed: enter a valid Minecraft player name.', 'e');
      return;
    }
    const target = getBotStatuses().find(b => b.id === botId);
    if (!target) {
      elog(ios, 'Teleport failed: bot location is not available yet.', 'e');
      return;
    }
    const p = target.position;
    const tpCmd = `tp ${player} ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}`;
    elog(ios, `Teleporting ${player} to ${target.username}...`, 'info');
    const result = await runServerCommand(tpCmd);
    ios.forEach(io => io.emit('cmd-result', result));
    elog(ios, result.slice(0,300), 'm');
    return;
  }
  if (cmd === 'force-stop') {
    await doStop(ios, true); return;
  }
  elog(ios, '> '+cmd, 'info');
  let r;
  switch (cmd) {
    case 'run-bot':
    case 'start-all': {
      const status = await getStatus(true);
      if (status.mc !== 'stopped' || status.visitor !== 'stopped') {
        elog(ios, 'Bot stack is already running or starting.', 'warn');
        break;
      }
      const count = getBotCount();
      await prepareWritableDirs();
      await compose('stop bluemap 2>/dev/null');
      await compose('rm -sf bluemap 2>/dev/null');
      r = await compose(`${composeProfile(count)}up -d ${botStackServices(count).join(' ')}`);
      etaData = { regionsStarted:0, firstRegionAt:null, lastRegionAt:null, wpTotal:0, wpDone:0, wpStart:null };
      elog(ios, r.ok?`Bot stack started (${count} bot${count===1?'':'s'})`:'FAILED: '+(r.stderr||'').slice(-200), r.ok?'done':'error');
      break;
    }
    case 'stop-all': await doStop(ios, false); return;
    case 'prune': await doPrune(ios); return;
    case 'start-mc': elog(ios, 'Start MC directly is disabled. Use Run the Bot.', 'warn'); break;
    case 'stop-mc': r = await compose('stop mc'); elog(ios, 'MC stopped', 'done'); break;
    case 'start-visitor': elog(ios, 'Start visitor directly is disabled. Use Run the Bot.', 'warn'); break;
    case 'stop-visitor': r = await compose('stop ' + ALL_VISITOR_SERVICES.join(' ')); elog(ios, 'Visitor stopped', 'done'); break;
    case 'start-bluemap': {
      const status = await getStatus(true);
      if (status.mc !== 'stopped' || status.visitor !== 'stopped') {
        elog(ios, 'CLI BlueMap is offline-only. Use Open BlueMap while the Minecraft server is running.', 'warn');
        break;
      }
      if (status.bluemap !== 'stopped') {
        elog(ios, 'BlueMap is already running or starting.', 'warn');
        break;
      }
      await prepareWritableDirs();
      r = await compose('--profile cli up -d bluemap'); elog(ios, 'BlueMap CLI render started', 'done'); break;
    }
    case 'stop-bluemap': r = await compose('stop bluemap'); elog(ios, 'BlueMap stopped', 'done'); break;
    case 'build': await compose('build visitor'); elog(ios, 'Build done', 'done'); break;
    default: elog(ios, 'Unknown: '+cmd, 'warn');
  }
  await pushAllClients(ios);
}

async function pushAll(io, quiet) {
  const [status, progress, stats] = await Promise.all([getStatus(quiet), Promise.resolve(getProgress()), getStats(quiet)]);
  const bluemapInfo = await getBlueMapInfo(status, quiet);
  io.emit('status', { ...status, progress, stats, eta: getETA(), conn: getConnectionInfo(), bluemapInfo, bots: getBotStatuses(), markerInfo: getMarkerInfo() });
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
  app.get(/^\/bluemap$/, (req, res) => res.redirect('/bluemap/'));
  app.use('/bluemap', express.static(bluemapWebDir));
  app.get('/bluemap/*', (req, res) => {
    const index = path.join(bluemapWebDir, 'index.html');
    if (fs.existsSync(index)) res.sendFile(index);
    else res.status(404).send('BlueMap web output is not available yet.');
  });
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
