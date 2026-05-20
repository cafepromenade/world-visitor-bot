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

let state;
let todo = [];
let idx = 0;
let bot;
let activeConnection = 0;
let reconnectAttempts = 0;
let shuttingDown = false;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
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
    process.exit(0);
  }

  log(`Will visit ${todo.length} regions (NEW_ONLY=${NEW_ONLY})`);
  log(`Server: ${MC_HOST}:${MC_PORT}  Username: ${MC_USERNAME_FULL}  Auth: ${MC_AUTH}`);
  log(`Render distance: ${RENDER_DISTANCE}  Flight Y: ${FLY_Y}  Grid step: ${GRID_STEP} blocks`);
  log(`Chunk check radius: ${CHUNK_CHECK_RADIUS}  Chunk load timeout: ${CHUNK_LOAD_TIMEOUT}ms`);
  log(`Movement mode: ${MOVE_MODE}  Step: ${MOVE_STEP} blocks  Delay: ${MOVE_DELAY}ms`);

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
  reconnectAttempts = 0;
  chat(`/gamemode creative ${MC_USERNAME_FULL}`);
  if (FOLLOW_PLAYER) {
    chat(`/op ${FOLLOW_PLAYER}`);
    log(`OP'd follow player: ${FOLLOW_PLAYER}`);
  }
  setTimeout(() => {
    if (connId !== activeConnection) return;
    bot.creative.startFlying();
    log('Flying enabled. Starting region visits in 3s...');
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
  if (shuttingDown) {
    process.exit(0);
    return;
  }
  if (idx < todo.length && reconnectAttempts < 10) {
    reconnectAttempts++;
    log(`Reconnecting in 10s... (attempt ${reconnectAttempts}/10)`);
    setTimeout(connect, 10000);
  } else if (idx >= todo.length) {
    log('All regions visited. Exiting.');
    process.exit(0);
  } else {
    log('Max reconnect attempts reached. Exiting.');
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

function getFollowPlayer() {
  const followFile = path.join(STATE_DIR, 'follow_player.txt');
  try {
    const value = fs.readFileSync(followFile, 'utf8').trim();
    if (value) return value;
  } catch {}
  return FOLLOW_PLAYER;
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

  const followPlayer = getFollowPlayer();
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
    if (followPlayer) tpCommand(followPlayer, x, y + 5, z);
    tpCommand(MC_USERNAME_FULL, x, y, z);
    if (step < steps || MOVE_DELAY > 0) {
      await delay(MOVE_DELAY);
    }
  }

  const arrived = await waitForPosition(target);
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
        if (!bot.world.getColumn(cx + dx, cz + dz)) {
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

  log(`[${index}/${todo.length}] Region (${target.rx}, ${target.rz}) @ (${target.cx}, ${FLY_Y}, ${target.cz}) - ${waypoints.length} waypoints`);

  for (let i = 0; i < waypoints.length; i++) {
    if (connId !== activeConnection) return;
    const wp = waypoints[i];

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
}

async function processNext(connId) {
  if (connId !== activeConnection) return;

  if (idx >= todo.length) {
    log('All regions visited! Saving state...');
    regions.saveState(STATE_FILE, state);
    log('Done.');
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

  if (state.visited && state.visited[key]) {
    log(`[${current}/${todo.length}] Already visited (${target.rx},${target.rz}) - skipping`);
    idx++;
    processNext(connId);
    return;
  }

  try {
    await moveToWaypoint(connId, { x: target.cx, y: FLY_Y, z: target.cz });
    await delay(REGION_DELAY);
    if (connId !== activeConnection) return;

    await flyRegion(connId, target, current);
    if (connId !== activeConnection) return;

    regions.markVisited(state, target.rx, target.rz);

    saveProgress('region complete');
  } catch (err) {
    log(`Error in region (${target.rx},${target.rz}): ${err.message}`);
    try { chat(`Error: ${err.message}`); } catch {}
    if (!bot.entity) return;
  }

  idx++;
  processNext(connId);
}

init();
