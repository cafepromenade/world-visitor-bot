const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REGION_RE = /^r\.(-?\d+)\.(-?\d+)\.mca$/;

function parseRegionName(filename) {
  const m = filename.match(REGION_RE);
  if (!m) return null;
  return { rx: parseInt(m[1]), rz: parseInt(m[2]) };
}

function regionCenter(rx, rz) {
  return { x: rx * 512 + 256, z: rz * 512 + 256 };
}

const OVERWORLD_REGION = ['dimensions', 'minecraft', 'overworld', 'region'];

function getAllRegions(worldDir) {
  const regionDir = path.join(worldDir, ...OVERWORLD_REGION);
  if (!fs.existsSync(regionDir)) return [];
  return fs.readdirSync(regionDir)
    .map(f => {
      const parsed = parseRegionName(f);
      if (!parsed) return null;
      const center = regionCenter(parsed.rx, parsed.rz);
      return { rx: parsed.rx, rz: parsed.rz, cx: center.x, cz: center.z, file: f };
    })
    .filter(Boolean)
    .sort((a, b) => a.rz - b.rz || a.rx - b.rx);
}

function distanceFromOrigin(region) {
  return Math.hypot(region.cx, region.cz);
}

function sortCenterOut(regions) {
  return [...regions].sort((a, b) => {
    const distance = distanceFromOrigin(a) - distanceFromOrigin(b);
    if (distance !== 0) return distance;

    const angle = Math.atan2(a.cz, a.cx) - Math.atan2(b.cz, b.cx);
    return angle || a.rz - b.rz || a.rx - b.rx;
  });
}

function assignBotRegions(allRegions, botCount, botIndex) {
  const count = Math.max(1, botCount | 0);
  const index = Math.max(0, botIndex | 0);
  return sortCenterOut(allRegions).filter((_, i) => i % count === index);
}

function regionKey(rx, rz) {
  return `${rx},${rz}`;
}

function loadState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (_) {
    return { visited: {}, lastCommit: null };
  }
}

function saveState(statePath, state) {
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function getGitDiffRegions(worldDir, oldCommit, newCommit) {
  try {
    const repoRoot = path.resolve(worldDir, '..');
    const gitDir = path.join(repoRoot, '.git');
    const regionDir = path.join(worldDir, ...OVERWORLD_REGION);
    const relativeRegion = path.relative(repoRoot, regionDir).replace(/\\/g, '/');
    const out = execSync(
      `git --git-dir="${gitDir}" --work-tree="${repoRoot}" diff --name-only --diff-filter=AM ${oldCommit} ${newCommit} -- ${relativeRegion}/`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();
    if (!out) return [];
    return out.split('\n')
      .map(line => path.basename(line))
      .map(parseRegionName)
      .filter(Boolean)
      .map(p => {
        const c = regionCenter(p.rx, p.rz);
        return { rx: p.rx, rz: p.rz, cx: c.x, cz: c.z, file: `r.${p.rx}.${p.rz}.mca` };
      });
  } catch (e) {
    console.error('git diff failed:', e.message);
    return [];
  }
}

function getCurrentCommit(repoRoot) {
  try {
    const gitDir = path.join(repoRoot, '.git');
    return execSync(`git --git-dir="${gitDir}" rev-parse HEAD`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (_) {
    return null;
  }
}

function selectRegions(allRegions, state, newOnly, worldDir) {
  const repoRoot = path.resolve(worldDir, '..');
  const currentCommit = getCurrentCommit(repoRoot);
  const visited = state.visited || {};

  if (newOnly && state.lastCommit && currentCommit) {
    const newRegions = getGitDiffRegions(worldDir, state.lastCommit, currentCommit);
    const unvisitedNew = newRegions.filter(r => !visited[regionKey(r.rx, r.rz)]);
    console.log(`Found ${newRegions.length} new/modified regions in git (${unvisitedNew.length} unvisited)`);
    return { regions: unvisitedNew, currentCommit };
  }

  if (newOnly && !state.lastCommit) {
    console.log('NEW_ONLY mode but no previous state found. Falling back to all unvisited regions.');
  }

  const unvisited = allRegions.filter(r => !visited[regionKey(r.rx, r.rz)]);
  return { regions: unvisited, currentCommit };
}

function markVisited(state, rx, rz) {
  if (!state.visited) state.visited = {};
  state.visited[regionKey(rx, rz)] = Date.now();
}

module.exports = {
  getAllRegions, loadState, saveState, selectRegions,
  markVisited, regionKey, getCurrentCommit, regionCenter,
  sortCenterOut, assignBotRegions
};
