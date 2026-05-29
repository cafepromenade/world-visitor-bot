const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const regions = require('../regions');

function makeWorld(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overworld-visitor-'));
  const regionDir = path.join(root, 'world', 'dimensions', 'minecraft', 'overworld', 'region');
  fs.mkdirSync(regionDir, { recursive: true });
  for (const file of files) {
    fs.writeFileSync(path.join(regionDir, file), '');
  }
  return { root, worldDir: path.join(root, 'world') };
}

test('getAllRegions returns valid overworld regions in a stable order', () => {
  const { root, worldDir } = makeWorld([
    'notes.txt',
    'r.2.-1.mca',
    'r.-1.0.mca',
    'r.0.-1.mca'
  ]);

  try {
    assert.deepEqual(regions.getAllRegions(worldDir), [
      { rx: 0, rz: -1, cx: 256, cz: -256, file: 'r.0.-1.mca' },
      { rx: 2, rz: -1, cx: 1280, cz: -256, file: 'r.2.-1.mca' },
      { rx: -1, rz: 0, cx: -256, cz: 256, file: 'r.-1.0.mca' }
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('selectRegions skips visited regions and works outside a git checkout', () => {
  const { root, worldDir } = makeWorld(['r.0.0.mca', 'r.1.0.mca']);

  try {
    const allRegions = regions.getAllRegions(worldDir);
    const state = { visited: { [regions.regionKey(0, 0)]: Date.now() } };
    const selected = regions.selectRegions(allRegions, state, false, worldDir);

    assert.equal(selected.currentCommit, null);
    assert.deepEqual(selected.regions.map(r => regions.regionKey(r.rx, r.rz)), ['1,0']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assignBotRegions starts center-out and keeps bots spread apart', () => {
  const { root, worldDir } = makeWorld([
    'r.-2.0.mca',
    'r.-1.-1.mca',
    'r.-1.0.mca',
    'r.0.-1.mca',
    'r.0.0.mca',
    'r.1.0.mca'
  ]);

  try {
    const allRegions = regions.getAllRegions(worldDir);
    const assigned = [0, 1, 2, 3].map(index => regions.assignBotRegions(allRegions, 4, index)[0]);

    assert.deepEqual(assigned.map(r => regions.regionKey(r.rx, r.rz)).sort(), [
      '-1,-1',
      '-1,0',
      '0,-1',
      '0,0'
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadState and saveState tolerate missing files and create directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overworld-visitor-state-'));
  const statePath = path.join(root, 'nested', 'visited.json');

  try {
    assert.deepEqual(regions.loadState(statePath), { visited: {}, lastCommit: null });

    const state = { visited: {}, lastCommit: 'abc123' };
    regions.markVisited(state, -2, 3);
    regions.saveState(statePath, state);

    assert.deepEqual(regions.loadState(statePath), state);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
