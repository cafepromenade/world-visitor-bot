const readline = require('readline');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const prompt = (q) => new Promise(resolve => rl.question(q, resolve));

async function main() {
  console.log('=== Overworld Visitor Setup ===\n');
  console.log('Configure your Minecraft server connection and bot settings.\n');

  const host = await prompt(`Server host [localhost]: `) || 'localhost';
  const port = await prompt(`Server port [25565]: `) || '25565';
  const user = await prompt(`Bot username [ChunkVisitor]: `) || 'ChunkVisitor';
  const auth = await prompt(`Auth mode - offline / mojang / microsoft [offline]: `) || 'offline';
  const rd = await prompt(`Render distance in chunks [32]: `) || '32';
  const y = await prompt(`Flight altitude Y [120]: `) || '120';
  const step = await prompt(`Grid step size in blocks - smaller = more thorough, larger = faster [80]: `) || '80';
  const bmHost = await prompt(`BlueMap host [localhost]: `) || 'localhost';
  const bmPort = '8100';
  const bmMap = await prompt(`BlueMap map name [overworld]: `) || 'overworld';

  const envContent = [
    `# Overworld Visitor configuration`,
    `MC_HOST=${host}`,
    `MC_PORT=${port}`,
    `MC_USERNAME=${user}`,
    `MC_AUTH=${auth}`,
    `RENDER_DISTANCE=${rd}`,
    `FLY_Y=${y}`,
    `GRID_STEP=${step}`,
    `BLUEMAP_HOST=${bmHost}`,
    `BLUEMAP_PORT=${bmPort}`,
    `BLUEMAP_MAP=${bmMap}`,
    ''
  ].join('\n');

  const envPath = path.join(__dirname, '..', '.env');
  fs.writeFileSync(envPath, envContent);
  console.log(`\nConfig written to .env`);

  console.log('\nRun with:');
  console.log('  ./visit-bluemap.sh [bot-count]         (live BlueMap + CLI final render)');
  console.log('  ./run-bot [bot-count]                  (Minecraft + bots + BlueMap)');
  console.log('  ./visit.sh                             (all regions)');
  console.log('  ./visit-new.sh                         (new regions only)');

  rl.close();
}

main();
