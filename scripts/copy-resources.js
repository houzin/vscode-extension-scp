const fs = require('fs');
const path = require('path');

// 要複製的資源目錄
const resources = [
    { src: 'src/templates', dest: 'out/templates' },
    { src: 'src/styles', dest: 'out/styles' },
    { src: 'src/scripts', dest: 'out/scripts' }
];

// 確保目標目錄存在
function ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

// 複製文件
function copyFile(src, dest) {
    const destDir = path.dirname(dest);
    ensureDirectoryExists(destDir);
    fs.copyFileSync(src, dest);
}

// 複製目錄
function copyDirectory(src, dest) {
    ensureDirectoryExists(dest);
    const files = fs.readdirSync(src);
    
    for (const file of files) {
        const srcPath = path.join(src, file);
        const destPath = path.join(dest, file);
        
        if (fs.statSync(srcPath).isDirectory()) {
            copyDirectory(srcPath, destPath);
        } else {
            copyFile(srcPath, destPath);
        }
    }
}

// 複製所有資源
for (const resource of resources) {
    console.log(`Copying ${resource.src} to ${resource.dest}...`);
    copyDirectory(resource.src, resource.dest);
}

console.log('Resource files copied successfully!'); 