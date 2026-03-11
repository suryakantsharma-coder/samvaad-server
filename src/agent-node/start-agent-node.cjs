/**
 * Launcher for the LiveKit agent-node (Neha voice agent).
 * Called from the main server so the agent starts when the server starts.
 * Runs "node dist/main.js start" inside src/agent-node with the server's env.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const AGENT_NODE_DIR = __dirname;
const MAIN_JS = path.join(AGENT_NODE_DIR, 'dist', 'main.js');

function startAgentNode() {
  if (!fs.existsSync(MAIN_JS)) {
    return Promise.reject(
      new Error(
        `Agent node not built. Run: cd src/agent-node && npm install && npm run build (or from root: npm run build:agent-node)`
      )
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['dist/main.js', 'start'], {
      cwd: AGENT_NODE_DIR,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolved = false;
    child.stdout.on('data', (data) => process.stdout.write(data));
    child.stderr.on('data', (data) => process.stderr.write(data));

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    child.on('exit', (code, signal) => {
      if (code !== 0 && code !== null && !resolved) {
        resolved = true;
        reject(new Error(`Agent node exited with code ${code}${signal ? ` signal ${signal}` : ''}`));
      }
    });

    // Consider agent started once process is spawned (LiveKit connects async)
    child.on('spawn', () => {
      console.log('[Samvaad] LiveKit agent-node (Neha) started');
      if (!resolved) {
        resolved = true;
        resolve(child);
      }
    });
  });
}

module.exports = { startAgentNode, AGENT_NODE_DIR };

