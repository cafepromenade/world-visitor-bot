const mineflayer = require('mineflayer');
const path = require('path');
const fs = require('fs');
const regions = require('./regions');

const WORLD_DIR = process.env.WORLD_DIR || '/app/world';
const STATE_DIR = process.env.STATE_DIR || '/app/state';

function readInt(name, fallback, min = Number.MIN_SAFE_INTEGER) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

const BOT_INDEX = readInt('BOT_INDEX', 0, 0);
const BOT_COUNT = readInt('BOT_COUNT', 1, 1);
const BOT_SUFFIX = BOT_COUNT > 1 ? `-bot${BOT_INDEX}` : '';
const STATE_FILE = path.join(STATE_DIR, `visited${BOT_SUFFIX}.json`);

const MC_HOST = process.env.MC_HOST || 'localhost';
const MC_PORT = readInt('MC_PORT', 25565, 1);
const MC_USERNAME = process.env.MC_USERNAME || 'Bot';
const MC_USERNAME_FULL = BOT_COUNT > 1 ? `${MC_USERNAME}${BOT_INDEX}` : MC_USERNAME;
const MC_AUTH = process.env.MC_AUTH || 'offline';
const NEW_ONLY = process.env.NEW_ONLY === 'true';
const FLY_Y = readInt('FLY_Y', 200);
const RENDER_DISTANCE = readInt('RENDER_DISTANCE', 32, 2);
const GRID_STEP = readInt('GRID_STEP', 80, 1);
const WP_DELAY = readInt('WP_DELAY', 2000, 0);
const REGION_DELAY = readInt('REGION_DELAY', 3000, 0);
const CHUNK_LOAD_TIMEOUT = readInt('CHUNK_LOAD_TIMEOUT', 60000, 1000);
const CHUNK_CHECK_RADIUS = readInt('CHUNK_CHECK_RADIUS', 1, 0);
const MOVE_MODE = (process.env.MOVE_MODE || 'smooth').toLowerCase();
const MOVE_STEP = readInt('MOVE_STEP', 32, 1);
const MOVE_DELAY = readInt('MOVE_DELAY', 150, 0);
const MOVE_REACH_DISTANCE = readInt('MOVE_REACH_DISTANCE', 8, 1);
const SHUTDOWN_ON_COMPLETE = process.env.SHUTDOWN_ON_COMPLETE === 'true';
const FOLLOW_PLAYER = process.env.FOLLOW_PLAYER || '';
const PLAYER_NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const BOT_ID = `bot${BOT_INDEX}`;
const BOT_STATUS_DIR = path.join(STATE_DIR, 'bots');
const BOT_STATUS_FILE = path.join(BOT_STATUS_DIR, `${BOT_ID}.json`);
const BLUEMAP_MAP_CONFIG = process.env.BLUEMAP_MAP_CONFIG || '';
const BLUEMAP_MARKERS_JSON = process.env.BLUEMAP_MARKERS_JSON || '';
const BOT_PATH_MAX = readInt('BOT_PATH_MAX', 500, 2);
const MARKER_START = '  # WORLD_VISITOR_BOT_MARKERS_START';
const MARKER_END = '  # WORLD_VISITOR_BOT_MARKERS_END';

let state;
let todo = [];
let idx = 0;
let bot;
let activeConnection = 0;
let reconnectAttempts = 0;
let shuttingDown = false;
let botStatus = 'starting';
let currentRegion = null;
let currentWaypoint = null;
let pathTrace = [];
let lastStatusWriteAt = 0;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function roundCoord(value) {
  return Math.round(value * 10) / 10;
}

function currentPosition() {
  if (!bot?.entity?.position) return null;
  const p = bot.entity.position;
  return { x: roundCoord(p.x), y: roundCoord(p.y), z: roundCoord(p.z) };
}

function appendPathPoint(pos) {
  if (!pos) return;
  const last = pathTrace[pathTrace.length - 1];
  if (!last || Math.hypot(pos.x - last.x, pos.y - last.y, pos.z - last.z) >= 24) {
    pathTrace.push(pos);
    if (pathTrace.length > BOT_PATH_MAX) pathTrace = pathTrace.slice(-BOT_PATH_MAX);
  }
}

function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${BOT_ID}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function htmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function jsString(value) {
  return JSON.stringify(String(value));
}

function hoconPos(pos) {
  return `{ x: ${roundCoord(pos.x)}, y: ${roundCoord(pos.y)}, z: ${roundCoord(pos.z)} }`;
}

function isValidPosition(pos) {
  return pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z);
}

function isoDate(value) {
  const date = new Date(value || Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function readBotStatuses() {
  try {
    if (!fs.existsSync(BOT_STATUS_DIR)) return [];
    return fs.readdirSync(BOT_STATUS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(BOT_STATUS_DIR, f), 'utf8')); }
        catch { return null; }
      })
      .filter(s => isValidPosition(s?.position))
      .sort((a, b) => (a.index || 0) - (b.index || 0));
  } catch {
    return [];
  }
}

function buildBlueMapBotMarkerBlock(statuses) {
  const lines = [
    '  "world-visitor-bots": {',
    '    label: "World Visitor Bots"',
    '    toggleable: true',
    '    default-hidden: false',
    '    sorting: -100',
    '    markers: {'
  ];

  statuses.forEach((s, idx) => {
    const label = `${s.username || s.id} ${s.status || 'unknown'}`;
    const pos = s.position;
    const detail = `${htmlEscape(s.username || s.id)}<br>Status: ${htmlEscape(s.status || 'unknown')}<br>Region: ${htmlEscape(s.region || '-')}<br>Waypoint: ${htmlEscape(s.waypoint || '-')}<br>Updated: ${isoDate(s.updatedAt)}<br>Position: ${pos.x}, ${pos.y}, ${pos.z}`;
    lines.push(`      "${s.id}-current": {`);
    lines.push('        type: "html"');
    lines.push(`        position: ${hoconPos(pos)}`);
    lines.push(`        label: ${jsString(label)}`);
    lines.push(`        html: ${jsString(`<div style='transform:translate(-50%,-100%);background:#34a853;color:#fff;border:2px solid #fff;border-radius:12px;padding:3px 8px;font:700 12px sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.45);'>${htmlEscape(s.username || s.id)}</div>`)}`);
    lines.push(`        detail: ${jsString(detail)}`);
    lines.push('        anchor: { x: 0, y: 0 }');
    lines.push(`        sorting: ${idx}`);
    lines.push('        listed: true');
    lines.push('      }');

    const trace = Array.isArray(s.path) ? s.path.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) : [];
    if (trace.length >= 2) {
      const center = trace.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y, z: acc.z + p.z }), { x: 0, y: 0, z: 0 });
      center.x /= trace.length; center.y /= trace.length; center.z /= trace.length;
      lines.push(`      "${s.id}-path": {`);
      lines.push('        type: "line"');
      lines.push(`        position: ${hoconPos(center)}`);
      lines.push(`        label: ${jsString(`${s.username || s.id} path`)}`);
      lines.push('        line: [');
      trace.forEach(p => lines.push(`          ${hoconPos(p)}`));
      lines.push('        ]');
      lines.push(`        detail: ${jsString(`${htmlEscape(s.username || s.id)} movement trace (${trace.length} points)`)}`);
      lines.push('        depth-test: false');
      lines.push('        line-width: 4');
      lines.push(`        line-color: ${idx % 4 === 0 ? '{ r: 52, g: 168, b: 83, a: 0.9 }' : idx % 4 === 1 ? '{ r: 66, g: 133, b: 244, a: 0.9 }' : idx % 4 === 2 ? '{ r: 251, g: 188, b: 4, a: 0.9 }' : '{ r: 234, g: 67, b: 53, a: 0.9 }'}`);
      lines.push(`        sorting: ${idx + 100}`);
      lines.push('        listed: true');
      lines.push('      }');
    }
  });

  lines.push('    }');
  lines.push('  }');
  return lines.join('\n');
}

function buildBlueMapLiveMarkerSet(statuses) {
  const markers = {};
  statuses.forEach((s, idx) => {
    const pos = s.position;
    const label = `${s.username || s.id} ${s.status || 'unknown'}`;
    markers[`${s.id}-current`] = {
      type: 'html',
      label,
      position: pos,
      anchor: { x: 0, y: 0 },
      html: `<div style='transform:translate(-50%,-100%);background:#34a853;color:#fff;border:2px solid #fff;border-radius:12px;padding:3px 8px;font:700 12px sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.45);'>${htmlEscape(s.username || s.id)}</div>`,
      sorting: idx,
      listed: true
    };
    const trace = Array.isArray(s.path) ? s.path.filter(isValidPosition) : [];
    if (trace.length >= 2) {
      const center = trace.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y, z: acc.z + p.z }), { x: 0, y: 0, z: 0 });
      center.x = roundCoord(center.x / trace.length);
      center.y = roundCoord(center.y / trace.length);
      center.z = roundCoord(center.z / trace.length);
      markers[`${s.id}-path`] = {
        type: 'line',
        label: `${s.username || s.id} path`,
        position: center,
        line: trace,
        depthTest: false,
        lineWidth: 4,
        lineColor: idx % 4 === 0 ? { r: 52, g: 168, b: 83, a: 0.9 } : idx % 4 === 1 ? { r: 66, g: 133, b: 244, a: 0.9 } : idx % 4 === 2 ? { r: 251, g: 188, b: 4, a: 0.9 } : { r: 234, g: 67, b: 53, a: 0.9 },
        sorting: idx + 100,
        listed: true
      };
    }
  });
  return { label: 'World Visitor Bots', toggleable: true, defaultHidden: false, sorting: -100, markers };
}

function replaceBlueMapMarkerBlock(config, block) {
  const replacement = `${MARKER_START}\n${block}\n${MARKER_END}`;
  const start = config.indexOf(MARKER_START);
  const end = config.indexOf(MARKER_END);
  if (start !== -1 && end !== -1 && end > start) {
    return `${config.slice(0, start)}${replacement}${config.slice(end + MARKER_END.length)}`;
  }

  const insertAt = config.lastIndexOf('\n}');
  if (insertAt === -1) return config;
  return `${config.slice(0, insertAt)}\n${replacement}${config.slice(insertAt)}`;
}

function updateBlueMapMarkerConfig() {
  updateBlueMapLiveMarkers();
  if (!BLUEMAP_MAP_CONFIG || !fs.existsSync(BLUEMAP_MAP_CONFIG)) return;
  const lockFile = `${BLUEMAP_MAP_CONFIG}.visitor-lock`;
  let lockFd = null;
  try {
    try {
      const stat = fs.statSync(lockFile);
      if (Date.now() - stat.mtimeMs > 10000) fs.unlinkSync(lockFile);
    } catch {}
    lockFd = fs.openSync(lockFile, 'wx');
    const config = fs.readFileSync(BLUEMAP_MAP_CONFIG, 'utf8');
    const next = replaceBlueMapMarkerBlock(config, buildBlueMapBotMarkerBlock(readBotStatuses()));
    if (next !== config) fs.writeFileSync(BLUEMAP_MAP_CONFIG, next);
  } catch (err) {
    if (err.code !== 'EEXIST') log(`WARN: failed to update BlueMap marker config: ${err.message}`);
  } finally {
    if (lockFd !== null) {
      try { fs.closeSync(lockFd); } catch {}
      try { fs.unlinkSync(lockFile); } catch {}
    }
  }
}

function updateBlueMapLiveMarkers() {
  if (!BLUEMAP_MARKERS_JSON) return;
  try {
    const statuses = readBotStatuses();
    let current = {};
    try { current = JSON.parse(fs.readFileSync(BLUEMAP_MARKERS_JSON, 'utf8')); } catch {}
    current['world-visitor-bots'] = buildBlueMapLiveMarkerSet(statuses);
    writeJsonAtomic(BLUEMAP_MARKERS_JSON, current);
  } catch (err) {
    log(`WARN: failed to update BlueMap live markers: ${err.message}`);
  }
}

function writeBotStatus(status, force = false) {
  const now = Date.now();
  if (!force && now - lastStatusWriteAt < 1000) return;
  lastStatusWriteAt = now;
  botStatus = status || botStatus;
  const pos = currentPosition();
  if (pos) appendPathPoint(pos);
  const record = {
    id: BOT_ID,
    index: BOT_INDEX,
    count: BOT_COUNT,
    username: MC_USERNAME_FULL,
    status: botStatus,
    position: pos || pathTrace[pathTrace.length - 1] || null,
    region: currentRegion,
    waypoint: currentWaypoint,
    updatedAt: new Date(now).toISOString(),
    path: pathTrace
  };
  try {
    writeJsonAtomic(BOT_STATUS_FILE, record);
    updateBlueMapMarkerConfig();
  } catch (err) {
    log(`WARN: failed to write bot status: ${err.message}`);
  }
}

function chat(msg) {
  if (!bot || !bot.entity) return;
  try {
    bot.chat(msg);
  } catch (err) {
    log(`WARN: failed to send command "${msg}": ${err.message}`);
  }
}

function init() {
  if (BOT_INDEX >= BOT_COUNT) {
    log(`Invalid bot assignment: BOT_INDEX=${BOT_INDEX} must be less than BOT_COUNT=${BOT_COUNT}`);
    process.exit(1);
  }

  let allRegions = regions.getAllRegions(WORLD_DIR);
  allRegions = allRegions.filter((_, i) => i % BOT_COUNT === BOT_INDEX);
  log(`Found ${allRegions.length} regions assigned to bot ${BOT_INDEX}/${BOT_COUNT}`);

  state = regions.loadState(STATE_FILE);
  const result = regions.selectRegions(allRegions, state, NEW_ONLY, WORLD_DIR);

  todo = result.regions;
  state.lastCommit = result.currentCommit || state.lastCommit;

  if (todo.length === 0) {
    log('All regions already visited. Nothing to do.');
    writeBotStatus('complete', true);
    process.exit(0);
  }

  log(`Will visit ${todo.length} regions (NEW_ONLY=${NEW_ONLY})`);
  log(`Server: ${MC_HOST}:${MC_PORT}  Username: ${MC_USERNAME_FULL}  Auth: ${MC_AUTH}`);
  log(`Render distance: ${RENDER_DISTANCE}  Flight Y: ${FLY_Y}  Grid step: ${GRID_STEP} blocks`);
  log(`Chunk check radius: ${CHUNK_CHECK_RADIUS}  Chunk load timeout: ${CHUNK_LOAD_TIMEOUT}ms`);
  log(`Movement mode: ${MOVE_MODE}  Step: ${MOVE_STEP} blocks  Delay: ${MOVE_DELAY}ms`);
  writeBotStatus('connecting', true);

  connect();
}

function visitedCount() {
  return Object.keys(state?.visited || {}).length;
}

function saveProgress(reason) {
  if (!state) return;
  regions.saveState(STATE_FILE, state);
  const suffix = reason ? ` (${reason})` : '';
  log(`Progress saved: ${visitedCount()}/${todo.length}${suffix}`);
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Received ${reason}. Saving progress and disconnecting...`);
  saveProgress('shutdown');
  writeBotStatus('stopping', true);
  try { bot?.end(); } catch {}
  setTimeout(() => process.exit(0), 1000);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

function connect() {
  const myConn = ++activeConnection;
  bot = mineflayer.createBot({
    host: MC_HOST,
    port: MC_PORT,
    username: MC_USERNAME_FULL,
    auth: MC_AUTH,
    viewDistance: RENDER_DISTANCE
  });

  bot.once('spawn', () => onSpawn(myConn));
  bot.on('kicked', onKicked);
  bot.on('error', onError);
  bot.on('end', onEnd);
  bot.on('health', onHealth);
  bot.on('playerJoined', onPlayerJoined);
}

function onHealth() {
  if (bot.health < 20) {
    log(`WARN: took damage! Health: ${bot.health}  Food: ${bot.food}  Position: ${bot.entity.position}`);
    chat(`/effect give ${MC_USERNAME_FULL} minecraft:instant_health 1 5`);
    chat(`/effect give ${MC_USERNAME_FULL} minecraft:resistance 9999 5 true`);
  }
}

function onPlayerJoined(player) {
  if (player.username === MC_USERNAME_FULL) return;
  log(`Player joined: ${player.username} - granting OP`);
  chat(`/op ${player.username}`);
}

function onSpawn(connId) {
  if (connId !== activeConnection) return;
  log('Bot spawned. Starting flight mode...');
  writeBotStatus('spawned', true);
  reconnectAttempts = 0;
  chat(`/gamemode creative ${MC_USERNAME_FULL}`);
  const followPlayers = getFollowPlayers();
  if (followPlayers.length) {
    followPlayers.forEach(player => chat(`/op ${player}`));
    log(`OP'd follow player${followPlayers.length === 1 ? '' : 's'}: ${followPlayers.join(', ')}`);
  }
  setTimeout(() => {
    if (connId !== activeConnection) return;
    bot.creative.startFlying();
    log('Flying enabled. Starting region visits in 3s...');
    writeBotStatus('flying', true);
    setTimeout(() => processNext(connId), 3000);
  }, 2000);
}

function onKicked(reason) {
  log(`Kicked: ${reason}`);
}

function onError(err) {
  log(`Error: ${err.message}`);
}

function onEnd() {
  log('Connection ended');
  writeBotStatus(shuttingDown ? 'stopped' : 'disconnected', true);
  if (shuttingDown) {
    process.exit(0);
    return;
  }
  if (idx < todo.length && reconnectAttempts < 10) {
    reconnectAttempts++;
    log(`Reconnecting in 10s... (attempt ${reconnectAttempts}/10)`);
    writeBotStatus('reconnecting', true);
    setTimeout(connect, 10000);
  } else if (idx >= todo.length) {
    log('All regions visited. Exiting.');
    writeBotStatus('complete', true);
    process.exit(0);
  } else {
    log('Max reconnect attempts reached. Exiting.');
    writeBotStatus('failed', true);
    process.exit(1);
  }
}

function buildFlightGrid(cx, cz, halfSize) {
  const waypoints = [];
  const step = GRID_STEP;

  for (let offset = -halfSize; offset <= halfSize; offset += step) {
    const row = [];
    for (let cross = -halfSize; cross <= halfSize; cross += step) {
      row.push({ ox: offset, oz: cross });
    }
    if (waypoints.length % 2 === 1) {
      row.reverse();
    }
    waypoints.push(...row);
  }

  return waypoints.map(wp => ({
    x: cx + wp.ox,
    y: FLY_Y,
    z: cz + wp.oz
  }));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function splitPlayerList(value) {
  return [...new Set(String(value || '')
    .split(/[,\n\r\t ]+/)
    .map(name => name.trim())
    .filter(name => PLAYER_NAME_RE.test(name)))];
}

function getFollowPlayers() {
  const followFile = path.join(STATE_DIR, 'follow_player.txt');
  try {
    const value = fs.readFileSync(followFile, 'utf8').trim();
    const players = splitPlayerList(value);
    if (players.length) return players;
  } catch {}
  return splitPlayerList(FOLLOW_PLAYER);
}

function tpCommand(name, x, y, z) {
  chat(`/tp ${name} ${Math.round(x)} ${Math.round(y)} ${Math.round(z)}`);
}

async function waitForPosition(target, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (!bot.entity) return false;
    const pos = bot.entity.position;
    const distance = Math.hypot(pos.x - target.x, pos.y - target.y, pos.z - target.z);
    if (distance <= MOVE_REACH_DISTANCE) return true;
    await delay(100);
  }
  return false;
}

async function moveToWaypoint(connId, target) {
  if (connId !== activeConnection || !bot.entity) return;

  const followPlayers = getFollowPlayers();
  const startPos = bot.entity.position;
  const start = { x: startPos.x, y: startPos.y, z: startPos.z };
  const dx = target.x - start.x;
  const dy = target.y - start.y;
  const dz = target.z - start.z;
  const distance = Math.hypot(dx, dy, dz);
  const steps = MOVE_MODE === 'teleport' ? 1 : Math.max(1, Math.ceil(distance / MOVE_STEP));

  for (let step = 1; step <= steps; step++) {
    if (connId !== activeConnection) return;
    const t = step / steps;
    const x = start.x + dx * t;
    const y = start.y + dy * t;
    const z = start.z + dz * t;
    followPlayers.forEach(player => tpCommand(player, x, y + 5, z));
    tpCommand(MC_USERNAME_FULL, x, y, z);
    writeBotStatus('moving');
    if (step < steps || MOVE_DELAY > 0) {
      await delay(MOVE_DELAY);
    }
  }

  const arrived = await waitForPosition(target);
  writeBotStatus(arrived ? 'arrived' : 'moving', true);
  if (!arrived && bot.entity) {
    const pos = bot.entity.position;
    log(`WARN: movement target not reached. Target=(${target.x}, ${target.y}, ${target.z}) Position=(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
  }
}

async function waitForChunksLoaded(connId) {
  const start = Date.now();
  const radius = Math.min(CHUNK_CHECK_RADIUS, RENDER_DISTANCE);
  const step = radius <= 2 ? 1 : Math.max(1, Math.floor(radius / 2));
  let lastMissing = 0;
  let lastTotal = 0;

  while (Date.now() - start < CHUNK_LOAD_TIMEOUT) {
    if (connId !== activeConnection) return;
    if (!bot.entity) return;

    const pos = bot.entity.position;
    const cx = Math.floor(pos.x / 16);
    const cz = Math.floor(pos.z / 16);

    let allLoaded = true;
    let missing = 0;
    let total = 0;
    for (let dx = -radius; dx <= radius; dx += step) {
      for (let dz = -radius; dz <= radius; dz += step) {
        total++;
        const column = typeof bot.world.getLoadedColumn === 'function'
          ? bot.world.getLoadedColumn(cx + dx, cz + dz)
          : bot.world.getColumn(cx + dx, cz + dz);
        if (!column) {
          allLoaded = false;
          missing++;
        }
      }
    }
    lastMissing = missing;
    lastTotal = total;

    if (allLoaded) return;
    await delay(500);
  }

  log(`WARN: Chunks not fully loaded after timeout (${lastMissing}/${lastTotal} sample columns missing, radius ${radius})`);
}

async function flyRegion(connId, target, index) {
  const regionSize = 512;
  const half = regionSize / 2;
  const waypoints = buildFlightGrid(target.cx, target.cz, half);
  const start = Date.now();
  currentRegion = `${target.rx},${target.rz}`;
  currentWaypoint = `0/${waypoints.length}`;
  writeBotStatus('region', true);

  log(`[${index}/${todo.length}] Region (${target.rx}, ${target.rz}) @ (${target.cx}, ${FLY_Y}, ${target.cz}) - ${waypoints.length} waypoints`);

  for (let i = 0; i < waypoints.length; i++) {
    if (connId !== activeConnection) return;
    const wp = waypoints[i];
    currentWaypoint = `${i + 1}/${waypoints.length}`;
    writeBotStatus('waypoint', true);

    await moveToWaypoint(connId, wp);

    await waitForChunksLoaded(connId);
    if (connId !== activeConnection) return;

    if (i % 3 === 0) {
      log(`[${index}/${todo.length}]   waypoint ${i + 1}/${waypoints.length} @ (${wp.x}, ${FLY_Y}, ${wp.z})`);
    }

    if (i < waypoints.length - 1) {
      await delay(WP_DELAY);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log(`[${index}/${todo.length}] Region (${target.rx}, ${target.rz}) complete in ${elapsed}s`);
  writeBotStatus('region-complete', true);
}

async function processNext(connId) {
  if (connId !== activeConnection) return;

  if (idx >= todo.length) {
    log('All regions visited! Saving state...');
    regions.saveState(STATE_FILE, state);
    log('Done.');
    writeBotStatus('complete', true);
    if (SHUTDOWN_ON_COMPLETE) {
      log('Shutting down server in 10s...');
      await delay(10000);
      chat('/stop');
    }
    await delay(3000);
    bot.end();
    process.exit(0);
    return;
  }

  const current = idx + 1;
  const target = todo[idx];
  const key = regions.regionKey(target.rx, target.rz);
  currentRegion = `${target.rx},${target.rz}`;
  currentWaypoint = null;

  if (state.visited && state.visited[key]) {
    log(`[${current}/${todo.length}] Already visited (${target.rx},${target.rz}) - skipping`);
    idx++;
    processNext(connId);
    return;
  }

  try {
    writeBotStatus('to-region', true);
    await moveToWaypoint(connId, { x: target.cx, y: FLY_Y, z: target.cz });
    await delay(REGION_DELAY);
    if (connId !== activeConnection) return;

    await flyRegion(connId, target, current);
    if (connId !== activeConnection) return;

    regions.markVisited(state, target.rx, target.rz);

    saveProgress('region complete');
  } catch (err) {
    log(`Error in region (${target.rx},${target.rz}): ${err.message}`);
    writeBotStatus('error', true);
    try { chat(`Error: ${err.message}`); } catch {}
    if (!bot.entity) return;
  }

  idx++;
  processNext(connId);
}

init();
