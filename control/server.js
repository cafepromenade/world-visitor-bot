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

function compose(args) {
  return new Promise((resolve) => {
    const cmd = `docker compose --project-directory ${PROJECT_HOST_DIR} ${args}`;
    exec(cmd, { timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout, stderr, cmd });
    });
  });
}

function run(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout, stderr });
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

function getProgress() {
  try {
    const stateDir = path.join(PROJECT_DIR, 'state');
    const files = fs.readdirSync(stateDir).filter(f => f.startsWith('visited') && f.endsWith('.json'));
    let totalRegions = 0;
    let visitedRegions = 0;
    let rx = 0, rz = 0;

    for (const f of files) {
      const data = JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8'));
      if (data.visited) {
        const keys = Object.keys(data.visited);
        visitedRegions += keys.length;
        if (keys.length > 0) {
          const last = keys[keys.length - 1];
          const parts = last.split(',');
          rx = parseInt(parts[0]) || 0;
          rz = parseInt(parts[1]) || 0;
        }
      }
      totalRegions += (data.total || 0);
    }

    return { regions: visitedRegions, total: totalRegions || 1, rx, rz, pct: totalRegions ? Math.round(visitedRegions / totalRegions * 100) : 0 };
  } catch {
    return { regions: 0, total: 0, rx: 0, rz: 0, pct: 0 };
  }
}

async function getLogs() {
  try {
    const { stdout } = await run(`docker compose --project-directory ${PROJECT_HOST_DIR} logs --tail 30 --no-log-prefix mc visitor bluemap 2>/dev/null`);
    return stdout.split('\n').filter(Boolean).slice(-20);
  } catch {
    return [];
  }
}

function broadcastLog(io, msg, level) {
  io.emit('log', { msg, level, time: new Date().toISOString() });
}

function setupServer(port) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  return { app, server, io };
}

async function main() {
  const { app, server, io } = setupServer(PORT);
  const app2 = express();
  const server2 = http.createServer(app2);
  const io2 = new Server(server2);

  app.use(express.static(path.join(__dirname, 'public')));
  app2.use(express.static(path.join(__dirname, 'public')));

  const handle = (io) => {
    io.on('connection', (socket) => {
      broadcastLog(io, 'Client connected', 'info');

      (async () => {
        const status = await getStatus();
        const progress = getProgress();
        io.emit('status', { ...status, progress });
      })();

      socket.on('action', async (cmd) => {
        broadcastLog(io, `Action: ${cmd}`, 'info');

        let result;
        switch (cmd) {
          case 'start-all':
            result = await compose('up -d mc visitor bluemap');
            broadcastLog(io, `Started all services`, result.ok ? 'done' : 'error');
            break;
          case 'stop-all':
            result = await compose('stop mc visitor bluemap');
            broadcastLog(io, `Stopped all services`, 'done');
            break;
          case 'prune':
            result = await compose('down mc visitor bluemap');
            result = await compose('up -d mc visitor bluemap');
            broadcastLog(io, `Pruned and restarted`, 'done');
            break;
          case 'start-mc':
            result = await compose('up -d --no-deps mc');
            broadcastLog(io, `MC server starting...`, 'info');
            break;
          case 'stop-mc':
            result = await compose('stop mc');
            broadcastLog(io, `MC server stopped`, 'done');
            break;
          case 'start-visitor':
            result = await compose('up -d --no-deps visitor');
            broadcastLog(io, `Visitor starting...`, 'info');
            break;
          case 'stop-visitor':
            result = await compose('stop visitor');
            broadcastLog(io, `Visitor stopped`, 'done');
            break;
          case 'start-bluemap':
            result = await compose('up -d --no-deps bluemap');
            broadcastLog(io, `BlueMap starting...`, 'info');
            break;
          case 'stop-bluemap':
            result = await compose('stop bluemap');
            broadcastLog(io, `BlueMap stopped`, 'done');
            break;
          default:
            broadcastLog(io, `Unknown action: ${cmd}`, 'warn');
        }

        const status = await getStatus();
        const progress = getProgress();
        io.emit('status', { ...status, progress });
      });
    });
  };

  handle(io);
  handle(io2);

  setInterval(async () => {
    const status = await getStatus();
    const progress = getProgress();
    io.emit('status', { ...status, progress });
    io2.emit('status', { ...status, progress });
  }, 3000);

  app.get('/map/*', (req, res) => res.redirect('http://localhost:8100'));

  server.listen(PORT, () => console.log(`Control panel: http://localhost:${PORT}`));
  server2.listen(PORT2, () => console.log(`Control panel: http://localhost:${PORT2}`));
}

main().catch(console.error);
