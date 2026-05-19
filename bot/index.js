const mineflayer = require('mineflayer');
const path = require('path');
const fs = require('fs');
const regions = require('./regions');

const WORLD_DIR = process.env.WORLD_DIR || '/app/world';
const STATE_DIR = process.env.STATE_DIR || '/app/state';

const BOT_INDEX = parseInt(process.env.BOT_INDEX || '0');
const BOT_COUNT = parseInt(process.env.BOT_COUNT || '1');
const BOT_SUFFIX = BOT_COUNT > 1 ? `-bot${BOT_INDEX}` : '';
const STATE_FILE = path.join(STATE_DIR, `visited${BOT_SUFFIX}.json`);

const MC_HOST = process.env.MC_HOST || 'localhost';
const MC_PORT = parseInt(process.env.MC_PORT || '25565');
const MC_USERNAME = process.env.MC_USERNAME || 'Bot';
const MC_USERNAME_FULL = BOT_COUNT > 1 ? `${MC_USERNAME}${BOT_INDEX}` : MC_USERNAME;
const MC_AUTH = process.env.MC_AUTH || 'offline';
const NEW_ONLY = process.env.NEW_ONLY === 'true';
const FLY_Y = parseInt(process.env.FLY_Y || '200');
const RENDER_DISTANCE = parseInt(process.env.RENDER_DISTANCE || '32');
const GRID_STEP = parseInt(process.env.GRID_STEP || '80');
const WP_DELAY = parseInt(process.env.WP_DELAY || '2000');
const REGION_DELAY = parseInt(process.env.REGION_DELAY || '3000');
const CHUNK_LOAD_TIMEOUT = parseInt(process.env.CHUNK_LOAD_TIMEOUT || '60000');
const SHUTDOWN_ON_COMPLETE = process.env.SHUTDOWN_ON_COMPLETE === 'true';
const FOLLOW_PLAYER = process.env.FOLLOW_PLAYER || '';

let state;
let todo = [];
let idx = 0;
let bot;
let activeConnection = 0;
let reconnectAttempts = 0;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function chat(msg) {
  if (!bot || !bot.entity) return;
  try { bot.chat(msg); } catch {}
}

function init() {
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

  connect();
}

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

async function waitForChunksLoaded(connId) {
  const start = Date.now();
  const step = Math.max(4, Math.floor(RENDER_DISTANCE / 4));

  while (Date.now() - start < CHUNK_LOAD_TIMEOUT) {
    if (connId !== activeConnection) return;
    if (!bot.entity) return;

    const pos = bot.entity.position;
    const cx = Math.floor(pos.x / 16);
    const cz = Math.floor(pos.z / 16);

    let allLoaded = true;
    for (let dx = -RENDER_DISTANCE; dx <= RENDER_DISTANCE && allLoaded; dx += step) {
      for (let dz = -RENDER_DISTANCE; dz <= RENDER_DISTANCE && allLoaded; dz += step) {
        if (!bot.world.getColumn(cx + dx, cz + dz)) {
          allLoaded = false;
        }
      }
    }

    if (allLoaded) return;
    await delay(500);
  }

  log('WARN: Chunks not fully loaded after timeout');
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

    const followFile = path.join(STATE_DIR, 'follow_player.txt');
    let followPlayer = FOLLOW_PLAYER;
    try { const f = fs.readFileSync(followFile, 'utf8').trim(); if (f) followPlayer = f; } catch {}
    if (followPlayer) {
      chat(`/tp ${followPlayer} ${wp.x} ${wp.y + 5} ${wp.z}`);
    }

    chat(`/tp ${MC_USERNAME_FULL} ${wp.x} ${wp.y} ${wp.z}`);
    await delay(500);

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
    chat(`/tp ${MC_USERNAME_FULL} ${target.cx} ${FLY_Y} ${target.cz}`);
    await delay(REGION_DELAY);
    if (connId !== activeConnection) return;

    await flyRegion(connId, target, current);
    if (connId !== activeConnection) return;

    regions.markVisited(state, target.rx, target.rz);

    if (current % 20 === 0 || current === todo.length) {
      regions.saveState(STATE_FILE, state);
      log(`Progress saved: ${current}/${todo.length}`);
    }
  } catch (err) {
    log(`Error in region (${target.rx},${target.rz}): ${err.message}`);
    try { chat(`Error: ${err.message}`); } catch {}
    if (!bot.entity) return;
  }

  idx++;
  processNext(connId);
}

init();
