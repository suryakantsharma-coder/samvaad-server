#!/usr/bin/env node

/**
 * Cloudflare Tunnel — exposes the local Express API (PORT, default 3000).
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const LOCAL_PORT = parseInt(process.env.PORT, 10) || 3000;
const TUNNEL_NAME = process.env.CLOUDFLARE_TUNNEL_NAME || 'samvaad-agent';

console.log('\n🌐 Starting Cloudflare Tunnel for Exotel WebSocket Connections\n');

// Check if cloudflared is installed
function checkCloudflared() {
  return new Promise((resolve, reject) => {
    const check = spawn('cloudflared', ['--version'], { stdio: 'pipe' });
    check.on('close', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        reject(new Error('cloudflared not found'));
      }
    });
    check.on('error', () => {
      reject(new Error('cloudflared not installed'));
    });
  });
}

// Create tunnel if it doesn't exist
function ensureTunnel() {
  return new Promise((resolve, reject) => {
    const list = spawn('cloudflared', ['tunnel', 'list'], { stdio: 'pipe' });
    let output = '';
    
    list.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    list.on('close', async (code) => {
      if (output.includes(TUNNEL_NAME)) {
        console.log(`✓ Tunnel "${TUNNEL_NAME}" exists\n`);
        resolve();
      } else {
        console.log(`Creating tunnel "${TUNNEL_NAME}"...`);
        const create = spawn('cloudflared', ['tunnel', 'create', TUNNEL_NAME], {
          stdio: 'inherit',
        });
        
        create.on('close', (code) => {
          if (code === 0) {
            console.log(`✓ Tunnel "${TUNNEL_NAME}" created\n`);
            resolve();
          } else {
            reject(new Error('Failed to create tunnel'));
          }
        });
      }
    });
  });
}

// Start the tunnel
function startTunnel() {
  console.log('Configuration:');
  console.log(`  Tunnel Name: ${TUNNEL_NAME}`);
  console.log(`  Local Port: ${LOCAL_PORT}`);
  console.log(`  Protocol: HTTP`);
  console.log(`  Local URL: http://localhost:${LOCAL_PORT}\n`);
  
  console.log('🚀 Starting Cloudflare tunnel...');
  console.log('Press Ctrl+C to stop\n');
  
  const tunnel = spawn('cloudflared', ['tunnel', 'run', TUNNEL_NAME], {
    stdio: 'inherit',
    env: {
      ...process.env,
      TUNNEL_TRANSPORT_PROTOCOL: 'http2',
    },
  });
  
  tunnel.on('error', (err) => {
    console.error('❌ Tunnel error:', err.message);
    process.exit(1);
  });
  
  tunnel.on('close', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`\n❌ Tunnel exited with code ${code}`);
      process.exit(1);
    }
  });
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\nStopping tunnel...');
    tunnel.kill();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    tunnel.kill();
    process.exit(0);
  });
}

// Main execution
async function main() {
  try {
    await checkCloudflared();
    await ensureTunnel();
    startTunnel();
  } catch (err) {
    console.error(`\n❌ ${err.message}\n`);
    console.log('Installation instructions:');
    console.log('  macOS: brew install cloudflared');
    console.log('  Linux: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/');
    console.log('  Windows: Download from https://github.com/cloudflare/cloudflared/releases\n');
    console.log('After installation, authenticate with:');
    console.log('  cloudflared tunnel login\n');
    process.exit(1);
  }
}

main();
