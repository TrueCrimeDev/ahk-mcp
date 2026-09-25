#!/usr/bin/env node

/**
 * Post-installation script for AutoHotkey v2 MCP Server
 * 
 * This script runs after npm install to set up the project
 * and ensure everything is properly configured.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ANSI color codes for better output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSuccess(message) {
  log(`✅ ${message}`, 'green');
}

function logWarning(message) {
  log(`⚠️  ${message}`, 'yellow');
}

function logError(message) {
  log(`❌ ${message}`, 'red');
}

function logInfo(message) {
  log(`ℹ️  ${message}`, 'blue');
}

function runCommand(command, description, options = {}) {
  try {
    execSync(command, { stdio: 'pipe', ...options });
    logSuccess(description);
    return true;
  } catch (error) {
    logWarning(`${description} failed: ${error.message}`);
    return false;
  }
}

function ensureDirectories() {
  logInfo('Ensuring required directories exist...');
  
  const directories = [
    'dist',
    'logs',
    'data',
    'coverage',
    '.nyc_output'
  ];

  directories.forEach(dir => {
    const dirPath = path.join(process.cwd(), dir);
    if (!fs.existsSync(dirPath)) {
      try {
        fs.mkdirSync(dirPath, { recursive: true });
        logSuccess(`Created directory: ${dir}`);
      } catch (error) {
        logWarning(`Failed to create directory ${dir}: ${error.message}`);
      }
    }
  });
}

function setupGitHooks() {
  logInfo('Setting up Git hooks...');
  
  try {
    // Initialize Husky if .husky directory exists
    const huskyDir = path.join(process.cwd(), '.husky');
    if (fs.existsSync(huskyDir)) {
      runCommand('npx husky install', 'Initialized Husky');
    }
  } catch (error) {
    logWarning(`Git hooks setup failed: ${error.message}`);
  }
}

function buildProject() {
  logInfo('Building project...');
  
  // Only build if dist directory doesn't exist or is empty
  const distDir = path.join(process.cwd(), 'dist');
  const indexJs = path.join(distDir, 'index.js');
  
  if (!fs.existsSync(indexJs)) {
    runCommand('npm run build', 'Built TypeScript project');
  } else {
    logInfo('Project already built, skipping build step');
  }
}

function validateDependencies() {
  logInfo('Validating critical dependencies...');
  
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  
  const criticalDeps = [
    '@modelcontextprotocol/server',
    'zod',
    'prom-client'
  ];
  
  let missingDeps = [];
  
  criticalDeps.forEach(dep => {
    if (!packageJson.dependencies[dep]) {
      missingDeps.push(dep);
    }
  });
  
  if (missingDeps.length > 0) {
    logError(`Missing critical dependencies: ${missingDeps.join(', ')}`);
    logInfo('Run: npm install to install missing dependencies');
  } else {
    logSuccess('All critical dependencies are present');
  }
}

function createEnvironmentFiles() {
  logInfo('Checking environment files...');
  
  const envExamplePath = path.join(process.cwd(), '.env.example');
  const envPath = path.join(process.cwd(), '.env');
  
  // Create .env from .env.example if .env doesn't exist
  if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
    try {
      fs.copyFileSync(envExamplePath, envPath);
      logSuccess('Created .env from .env.example');
    } catch (error) {
      logWarning(`Failed to create .env: ${error.message}`);
    }
  }
}

function main() {
  log('🚀 AutoHotkey v2 MCP Server - Post-installation Setup', 'bright');
  log('================================================', 'bright');
  
  try {
    ensureDirectories();
    setupGitHooks();
    validateDependencies();
    createEnvironmentFiles();
    buildProject();
    
    logSuccess('\n🎉 Post-installation setup completed successfully!');
    logInfo('\nNext steps:');
    logInfo('1. Run "npm run dev" to start development server');
    logInfo('2. Run "npm test" to run tests');
    logInfo('3. Check the documentation in docs/ for more information');
    
  } catch (error) {
    logError(`Post-installation setup failed: ${error.message}`);
    process.exit(1);
  }
}

// Run the post-installation setup
main();