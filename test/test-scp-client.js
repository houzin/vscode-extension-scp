const { ScpClientWrapper } = require('./dist/services/ssh/scp-client-wrapper');
const path = require('path');
const fs = require('fs');

// 测试配置
const config = {
    host: '192.168.8.8',
    port: 22,
    username: 'xxx',
    password: 'xxxx',
    readyTimeout: 5000  // 添加连接超时设置
};

// 创建测试文件
const createTestFile = () => {
    const testContent = 'This is a test file content ' + new Date().toISOString();
    const localTestFile = path.join(__dirname, 'test.txt');
    fs.writeFileSync(localTestFile, testContent);
    return localTestFile;
};

// 添加超时Promise包装
const withTimeout = (promise, timeout, description) => {
    return Promise.race([
        promise,
        new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`操作超时: ${description}`)), timeout)
        )
    ]);
};

// 测试单个功能
async function testFeature(name, func) {
    console.log(`开始测试: ${name}`);
    try {
        await withTimeout(func(), 30000, name);
        console.log(`✓ ${name} 测试成功`);
        return true;
    } catch (error) {
        console.error(`✗ ${name} 测试失败:`, error);
        return false;
    }
}

// 测试函数
async function runTests() {
    const client = new ScpClientWrapper();
    let localTestFile;
    const remoteTestPath = '/var/services/homes/houzin/test.txt';
    const remoteDir = '/var/services/homes/houzin';

    try {
        console.log('开始测试 SCP 客户端...');
        console.log('系统信息:', process.platform, process.version);

        // 创建测试文件
        localTestFile = createTestFile();
        console.log('测试文件已创建:', localTestFile);

        // 测试连接
        await testFeature('连接测试', async () => {
            console.log('尝试连接到:', config.host);
            await client.connect(config);
        });

        // 获取 SFTP 接口
        let sftp;
        await testFeature('获取SFTP接口', async () => {
            sftp = await client.sftp();
            console.log('SFTP接口获取成功');
        });

        if (!sftp) {
            throw new Error('无法获取SFTP接口');
        }

        // 测试目录列表
        await testFeature('读取目录', async () => {
            const files = await sftp.readdir(remoteDir);
            console.log('目录内容:', files.map(f => f.filename).join(', '));
        });

        // 测试上传文件
        await testFeature('上传文件', async () => {
            const writeStream = sftp.createWriteStream(remoteTestPath);
            const readStream = fs.createReadStream(localTestFile);
            
            await new Promise((resolve, reject) => {
                writeStream.on('finish', resolve);
                writeStream.on('error', reject);
                readStream.on('error', reject);
                readStream.pipe(writeStream);
            });
        });

        // 测试文件状态
        await testFeature('获取文件状态', async () => {
            const stats = await sftp.stat(remoteTestPath);
            console.log('文件信息:', {
                size: stats.size,
                isDirectory: stats.isDirectory()
            });
        });

        // 测试下载文件
        await testFeature('下载文件', async () => {
            const downloadPath = path.join(__dirname, 'test-download.txt');
            const readStream = sftp.createReadStream(remoteTestPath);
            const writeStream = fs.createWriteStream(downloadPath);

            await new Promise((resolve, reject) => {
                readStream.on('end', resolve);
                readStream.on('error', reject);
                writeStream.on('error', reject);
                readStream.pipe(writeStream);
            });

            // 验证文件是否下载成功
            if (fs.existsSync(downloadPath)) {
                fs.unlinkSync(downloadPath);
            }
        });

        // 测试删除文件
        await testFeature('删除远程文件', async () => {
            await sftp.unlink(remoteTestPath);
        });

    } catch (error) {
        console.error('测试过程中发生错误:', error);
        if (error.stack) {
            console.error('错误堆栈:', error.stack);
        }
    } finally {
        // 清理工作
        try {
            if (localTestFile && fs.existsSync(localTestFile)) {
                fs.unlinkSync(localTestFile);
                console.log('本地测试文件已清理');
            }
            client.disconnect();
            console.log('已断开连接');
        } catch (error) {
            console.error('清理过程中发生错误:', error);
        }
    }
}

// 运行测试
console.log('开始运行 SCP 客户端测试...');
console.log('当前工作目录:', process.cwd());
runTests().catch(error => {
    console.error('测试主程序发生错误:', error);
    process.exit(1);
}); 