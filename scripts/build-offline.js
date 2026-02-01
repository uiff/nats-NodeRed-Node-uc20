const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OFFLINE_DIR = path.join(__dirname, '..', 'offline-packages');

// Ensure offline directory exists
if (!fs.existsSync(OFFLINE_DIR)) {
    fs.mkdirSync(OFFLINE_DIR, { recursive: true });
}

try {
    console.log('Creating npm package...');
    // Run npm pack and capture the filename (it prints the filename to stdout)
    const fileName = execSync('npm pack', { cwd: path.join(__dirname, '..') }).toString().trim();

    if (!fileName) {
        throw new Error('npm pack failed to produce a filename output.');
    }

    const sourcePath = path.join(__dirname, '..', fileName);
    const destPath = path.join(OFFLINE_DIR, fileName);

    console.log(`Moving ${fileName} to ${OFFLINE_DIR}...`);
    fs.renameSync(sourcePath, destPath);

    console.log(`✅ Offline package created successfully: ${destPath}`);
} catch (error) {
    console.error('❌ Failed to create offline package:', error.message);
    process.exit(1);
}
