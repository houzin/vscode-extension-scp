const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Define color codes
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    red: '\x1b[31m'
};

// Print colored message
function log(message, color = colors.reset) {
    console.log(color + message + colors.reset);
}

// Execute command and print output
function execute(command) {
    try {
        log(`Executing command: ${command}`, colors.blue);
        execSync(command, { stdio: 'inherit' });
        return true;
    } catch (error) {
        log(`Error: ${error.message}`, colors.red);
        return false;
    }
}

// Main packaging process
async function packageExtension() {
    // 1. Clean previous build
    log('🧹 Cleaning old files...', colors.bright);
    if (fs.existsSync('out')) {
        fs.rmSync('out', { recursive: true });
    }
    if (fs.existsSync('*.vsix')) {
        fs.unlinkSync('*.vsix');
    }

    // 2. Install dependencies
    log('📦 Installing dependencies...', colors.bright);
    if (!execute('npm install')) {
        return;
    }

    // 3. Compile TypeScript
    log('🔨 Compiling code...', colors.bright);
    if (!execute('npm run compile')) {
        return;
    }

    // 4. Create .vscodeignore file (if not exists)
    if (!fs.existsSync('.vscodeignore')) {
        log('📝 Creating .vscodeignore file...', colors.bright);
        const vscodeignore = `
.vscode/**
.vscode-test/**
src/**
**/tsconfig.json
**/.eslintrc.json
**/*.map
**/*.ts
.gitignore
.git
node_modules/**
scripts/**
!node_modules/ssh2/**
!node_modules/ssh2-sftp-client/**
!node_modules/node-ssh/**
`;
        fs.writeFileSync('.vscodeignore', vscodeignore.trim());
    }

    // 5. Package extension
    log('📦 Packaging extension...', colors.bright);
    if (!execute('vsce package')) {
        return;
    }

    log('✨ Packaging complete!', colors.green);
    log('You can find the .vsix file in the current directory.', colors.green);
}

// Run packaging process
packageExtension().catch(error => {
    log(`❌ Error during packaging: ${error.message}`, colors.red);
    process.exit(1);
}); 