#!/usr/bin/env node

/**
 * Development Environment Setup Script
 *
 * This script sets up a complete development environment for the AutoHotkey v2 MCP Server project.
 * It installs dependencies, configures Git hooks, and verifies the setup.
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// ANSI color codes for better output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logStep(step) {
  log(`\n📋 Step ${step}`, 'cyan');
}

function logSuccess(message) {
  log(`✅ ${message}`, 'green');
}

function logError(message) {
  log(`❌ ${message}`, 'red');
}

function logWarning(message) {
  log(`⚠️  ${message}`, 'yellow');
}

function logInfo(message) {
  log(`ℹ️  ${message}`, 'blue');
}

function runCommand(command, description, options = {}) {
  try {
    log(`Running: ${command}`, 'magenta');
    execSync(command, { stdio: 'inherit', ...options });
    logSuccess(description);
    return true;
  } catch (error) {
    logError(`${description} failed: ${error.message}`);
    return false;
  }
}

function checkPrerequisites() {
  logStep('1: Checking Prerequisites');

  const requiredCommands = [
    { cmd: 'node', version: '--version', minVersion: '18.0.0' },
    { cmd: 'npm', version: '--version', minVersion: '8.0.0' },
    { cmd: 'git', version: '--version', minVersion: '2.0.0' },
  ];

  let allPrerequisitesMet = true;

  requiredCommands.forEach(({ cmd, version, minVersion }) => {
    try {
      const versionOutput = execSync(`${cmd} ${version}`, { encoding: 'utf8' }).trim();
      logInfo(`${cmd}: ${versionOutput}`);

      // Simple version check (could be enhanced)
      if (
        cmd === 'node' &&
        !versionOutput.includes('v18') &&
        !versionOutput.includes('v19') &&
        !versionOutput.includes('v20') &&
        !versionOutput.includes('v21')
      ) {
        logWarning(`${cmd} version might be too old. Recommended: ${minVersion}+`);
      }
    } catch (error) {
      logError(`${cmd} is not installed or not in PATH`);
      allPrerequisitesMet = false;
    }
  });

  if (!allPrerequisitesMet) {
    logError('Please install the missing prerequisites and run this script again.');
    process.exit(1);
  }

  logSuccess('All prerequisites met');
}

function installDependencies() {
  logStep('2: Installing Dependencies');

  if (!runCommand('npm ci', 'Installing dependencies')) {
    logError('Failed to install dependencies');
    process.exit(1);
  }
}

function setupGitHooks() {
  logStep('3: Setting Up Git Hooks');

  // Initialize Husky
  if (!runCommand('npx husky install', 'Initializing Husky')) {
    logWarning('Failed to initialize Husky, continuing...');
  }

  // Make pre-commit hook executable
  const preCommitPath = path.join(process.cwd(), '.husky', 'pre-commit');
  if (fs.existsSync(preCommitPath)) {
    try {
      fs.chmodSync(preCommitPath, '755');
      logSuccess('Made pre-commit hook executable');
    } catch (error) {
      logWarning('Failed to make pre-commit hook executable');
    }
  }
}

function buildProject() {
  logStep('4: Building Project');

  if (!runCommand('npm run build', 'Building TypeScript project')) {
    logError('Failed to build project');
    process.exit(1);
  }
}

function runTests() {
  logStep('5: Running Tests');

  if (!runCommand('npm run test', 'Running unit tests')) {
    logWarning('Some tests failed, but continuing setup...');
  }
}

function setupVSCode() {
  logStep('6: Setting Up VS Code Configuration');

  const vscodeDir = path.join(process.cwd(), '.vscode');

  if (!fs.existsSync(vscodeDir)) {
    fs.mkdirSync(vscodeDir, { recursive: true });
  }

  // Create VS Code settings
  const settings = {
    'typescript.preferences.importModuleSpecifier': 'relative',
    'editor.formatOnSave': true,
    'editor.defaultFormatter': 'esbenp.prettier-vscode',
    'editor.codeActionsOnSave': {
      'source.fixAll.eslint': true,
      'source.organizeImports': true,
    },
    'files.associations': {
      '*.ahk': 'autohotkey',
    },
    'emmet.includeLanguages': {
      ahk: 'html',
    },
  };

  const settingsPath = path.join(vscodeDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  logSuccess('Created VS Code settings');

  // Create VS Code extensions recommendation
  const extensions = {
    recommendations: [
      'esbenp.prettier-vscode',
      'dbaeumer.vscode-eslint',
      'ms-vscode.vscode-typescript-next',
      'bradlc.vscode-tailwindcss',
      'ms-vscode.vscode-json',
      'redhat.vscode-yaml',
      'ms-vscode.vscode-markdown',
      'autohotkey.autohotkey-plus',
    ],
  };

  const extensionsPath = path.join(vscodeDir, 'extensions.json');
  fs.writeFileSync(extensionsPath, JSON.stringify(extensions, null, 2));
  logSuccess('Created VS Code extensions recommendation');
}

function createEnvironmentFiles() {
  logStep('7: Creating Environment Files');

  // Create .env.example if it doesn't exist
  const envExamplePath = path.join(process.cwd(), '.env.example');
  if (!fs.existsSync(envExamplePath)) {
    const envExample = `# AutoHotkey MCP Server Environment Variables

# Node Environment
NODE_ENV=development

# Log Level (error, warn, info, debug)
AHK_MCP_LOG_LEVEL=info

# Data Mode (light, full)
AHK_MCP_DATA_MODE=light

# Server Configuration
PORT=3000

# AutoHotkey Configuration
AHK_PATH=C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe

# Development Settings
AHK_MCP_DEV_MODE=true
AHK_MCP_DEBUG=true

# Test Configuration
TEST_TIMEOUT=30000
`;
    fs.writeFileSync(envExamplePath, envExample);
    logSuccess('Created .env.example');
  }

  // Create .env.test for testing
  const envTestPath = path.join(process.cwd(), '.env.test');
  if (!fs.existsSync(envTestPath)) {
    const envTest = `# Test Environment Variables
NODE_ENV=test
AHK_MCP_LOG_LEVEL=error
AHK_MCP_DATA_MODE=light
PORT=3001
`;
    fs.writeFileSync(envTestPath, envTest);
    logSuccess('Created .env.test');
  }

  // Copy .env.example to .env if .env doesn't exist
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    fs.copyFileSync(envExamplePath, envPath);
    logInfo('Created .env from .env.example');
  }
}

function verifySetup() {
  logStep('8: Verifying Setup');

  const checks = [
    {
      name: 'Node modules installed',
      check: () => fs.existsSync(path.join(process.cwd(), 'node_modules')),
    },
    {
      name: 'TypeScript build successful',
      check: () => fs.existsSync(path.join(process.cwd(), 'dist', 'index.js')),
    },
    {
      name: 'Git hooks installed',
      check: () => fs.existsSync(path.join(process.cwd(), '.husky', 'pre-commit')),
    },
    {
      name: 'Environment files created',
      check: () => fs.existsSync(path.join(process.cwd(), '.env')),
    },
    {
      name: 'VS Code configuration created',
      check: () => fs.existsSync(path.join(process.cwd(), '.vscode', 'settings.json')),
    },
  ];

  let allChecksPassed = true;

  checks.forEach(({ name, check }) => {
    if (check()) {
      logSuccess(name);
    } else {
      logError(name);
      allChecksPassed = false;
    }
  });

  if (allChecksPassed) {
    logSuccess('\n🎉 Development environment setup completed successfully!');
    logInfo('\nNext steps:');
    logInfo('1. Open the project in VS Code');
    logInfo('2. Install the recommended extensions');
    logInfo('3. Run "npm run dev" to start development server');
    logInfo('4. Run "npm test" to run tests');
    logInfo('5. Check the documentation in docs/ for more information');
  } else {
    logError('\n❌ Some setup checks failed. Please review the errors above.');
    process.exit(1);
  }
}

async function main() {
  log('🚀 AutoHotkey v2 MCP Server - Development Environment Setup', 'bright');
  log('=========================================================', 'bright');

  try {
    checkPrerequisites();
    installDependencies();
    setupGitHooks();
    buildProject();
    runTests();
    setupVSCode();
    createEnvironmentFiles();
    verifySetup();
  } catch (error) {
    logError(`Setup failed: ${error.message}`);
    process.exit(1);
  } finally {
    rl.close();
  }
}

// Handle process termination
process.on('SIGINT', () => {
  log('\n\nSetup interrupted by user', 'yellow');
  rl.close();
  process.exit(1);
});

// Run the setup
main();
