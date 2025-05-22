import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import { Readable } from 'stream';
import { SshClient, SftpClient } from '../types/ssh.types';
import { FileItem, TransferProgress } from '../types';
import { Warning } from '../types/errors';
import * as os from 'os';

export class FileService {
    private readonly systemFiles = new Set([
        'hiberfil.sys',
        'pagefile.sys',
        'swapfile.sys',
        'Recovery',
        'System Volume Information',
        'DumpStack.log'
    ]);

    private _isCancelled: boolean = false;

    public cancelTransfer() {
        this._isCancelled = true;
    }

    private resetCancelFlag() {
        this._isCancelled = false;
    }

    // 添加路径标准化函数
    private normalizeRemotePath(inputPath: string): string {
        // 将Windows路径分隔符转换为Unix风格
        let normalized = inputPath.replace(/\\/g, '/');
        // 确保不会出现多个连续的斜杠
        normalized = normalized.replace(/\/+/g, '/');
        return normalized;
    }

    private normalizeLocalPath(inputPath: string): string {
        // 在Windows上保持原有的路径格式，在其他系统上转换为对应格式
        return process.platform === 'win32' ? inputPath : inputPath.replace(/\\/g, '/');
    }

    private normalizeWindowsPath(inputPath: string): string {
        // 移除开头的斜杠
        inputPath = inputPath.replace(/^\/+/, '');

        // 如果是驱动器路径，确保格式正确
        if (inputPath.match(/^[A-Za-z]:/)) {
            // 获取驱动器号和路径部分
            const driveLetter = inputPath.substring(0, 2);
            const pathPart = inputPath.substring(2);
            // 规范化路径分隔符
            return driveLetter + '\\' + pathPart.replace(/[\\\/]+/g, '\\').replace(/^\\/, '');
        }

        return inputPath.replace(/\//g, '\\');
    }

    private sanitizePath(inputPath: string): string {
        if (process.platform === 'win32') {
            // 处理以斜杠开头的Windows路径（如 "/C:/path"）
            if (inputPath.match(/^\/[A-Za-z]:/)) {
                inputPath = inputPath.substring(1);
            }
            return this.normalizeWindowsPath(inputPath);
        }
        return inputPath;
    }

    private async getWindowsDrives(): Promise<FileItem[]> {
        const drives: FileItem[] = [];
        // 获取所有可用的Windows驱动器
        for (let i = 65; i <= 90; i++) {  // A-Z
            const driveLetter = String.fromCharCode(i);
            const drivePath = `${driveLetter}:\\`;
            try {
                await fs.promises.access(drivePath);
                drives.push({
                    name: `${driveLetter}:`,
                    isDirectory: true,
                    size: 0,
                    modifyTime: Date.now()
                });
            } catch (error) {
                // 驱动器不存在或无法访问，跳过
                continue;
            }
        }
        return drives;
    }

    public async listLocalFiles(localPath: string): Promise<FileItem[]> {
        const readdir = util.promisify(fs.readdir);
        const stat = util.promisify(fs.stat);
        
        try {
            // 清理和标准化路径
            localPath = this.sanitizePath(localPath);
            
            if (process.platform === 'win32') {
                // 如果是空字符串，表示要列出驱动器
                if (!localPath) {
                    return await this.getWindowsDrives();
                }
                
                // 确保有效的Windows路径
                if (!localPath.match(/^[A-Za-z]:\\/)) {
                    throw new Error(`Invalid Windows path format: ${localPath}`);
                }
            }

            const files = await readdir(localPath);
            const fileStats = await Promise.all(
                files
                    .filter(name => !this.systemFiles.has(name))
                    .map(async (name) => {
                        try {
                            const fullPath = path.join(localPath, name);
                            const stats = await stat(fullPath);
                            return {
                                name,
                                isDirectory: stats.isDirectory(),
                                size: stats.size,
                                modifyTime: stats.mtimeMs
                            };
                        } catch (error: any) {
                            if (error.code !== 'EPERM' && error.code !== 'EBUSY') {
                                console.warn(`無法訪問文件 ${name}:`, error);
                            }
                            return null;
                        }
                    })
            );

            return fileStats.filter((file): file is FileItem => file !== null);
        } catch (error: any) {
            console.error(`列出文件失敗: ${error.message}`);
            throw error;
        }
    }

    public async listRemoteFiles(client: SshClient, remotePath: string): Promise<{ files: FileItem[], actualPath: string }> {
        const sftp = await client.sftp();
        try {
            const list = await sftp.readdir(remotePath);
            return {
                files: list.map(item => ({
                    name: item.filename,
                    isDirectory: item.attrs.isDirectory(),
                    size: item.attrs.size,
                    modifyTime: item.attrs.mtime * 1000
                })),
                actualPath: remotePath
            };
        } catch (error: any) {
            if (error.message.includes('No such file')) {
                // 如果目录不存在，返回根目录的内容
                console.warn(`目錄 ${remotePath} 不存在，返回根目錄`);
                const rootList = await sftp.readdir('/');
                return {
                    files: rootList.map(item => ({
                        name: item.filename,
                        isDirectory: item.attrs.isDirectory(),
                        size: item.attrs.size,
                        modifyTime: item.attrs.mtime * 1000
                    })),
                    actualPath: '/'
                };
            }
            throw error;
        }
    }

    public async uploadFiles(
        client: SshClient,
        localPaths: string[],
        remotePath: string,
        onProgress: (progress: TransferProgress) => void
    ): Promise<void> {
        this.resetCancelFlag();
        const sftp = await client.sftp();
        
        try {
            // 串行处理每个文件
            for (const fullLocalPath of localPaths) {
                if (this._isCancelled) {
                    throw new Warning('Transfer cancelled');
                }
                // 标准化本地路径
                let normalizedLocalPath = fullLocalPath;
                if (process.platform === 'win32') {
                    normalizedLocalPath = normalizedLocalPath.replace(/^\/+/, '');
                    if (normalizedLocalPath.match(/^[A-Za-z]:/)) {
                        normalizedLocalPath = this.normalizeWindowsPath(normalizedLocalPath);
                    }
                }

                if (!fs.existsSync(normalizedLocalPath)) {
                    throw new Warning(`File does not exist: ${normalizedLocalPath}`);
                }

                const stats = fs.statSync(normalizedLocalPath);
                if (stats.isDirectory()) {
                    await this.uploadDirectory(sftp, normalizedLocalPath, remotePath, onProgress);
                } else {
                    await this.uploadSingleFile(sftp, normalizedLocalPath, remotePath, onProgress);
                }
            }
        } catch (error: any) {
            console.error('Error uploading files:', error);
            if (error instanceof Warning) {
                throw error;
            }
            throw new Warning(`Failed to upload files: ${error.message}`);
        }
    }

    private async uploadDirectory(
        sftp: SftpClient,
        localDirPath: string,
        remotePath: string,
        onProgress: (progress: TransferProgress) => void
    ): Promise<void> {
        const dirName = path.basename(localDirPath);
        const remoteDirPath = path.join(remotePath, dirName).replace(/\\/g, '/');
        
        // 检查远程路径状态
        try {
            const stats = await sftp.stat(remoteDirPath);
            if (!stats.isDirectory()) {
                throw new Error(`A file with the same name already exists at the target path: ${remoteDirPath}`);
            }
        } catch (error: any) {
            // 如果目录不存在，尝试创建
            try {
                console.log('Creating remote directory:', remoteDirPath);
                await sftp.mkdir(remoteDirPath);
                console.log('Remote directory created successfully');
            } catch (mkdirError: any) {
                console.error('Failed to create remote directory:', mkdirError);
                throw mkdirError;
            }
        }

        // 读取本地目录内容
        const items = await fs.promises.readdir(localDirPath);
        
        // 串行处理目录中的每个项目
        for (const item of items) {
            let localItemPath = path.join(localDirPath, item);
            if (process.platform === 'win32') {
                localItemPath = this.normalizeWindowsPath(localItemPath);
            }
            const stats = await fs.promises.stat(localItemPath);
            
            if (stats.isDirectory()) {
                await this.uploadDirectory(sftp, localItemPath, remoteDirPath, onProgress);
            } else {
                await this.uploadSingleFile(sftp, localItemPath, remoteDirPath, onProgress);
            }
        }
    }

    private async uploadSingleFile(
        sftp: SftpClient,
        fullLocalPath: string,
        remotePath: string,
        onProgress: (progress: TransferProgress) => void
    ): Promise<void> {
        const fileName = path.basename(fullLocalPath);
        const remoteFilePath = this.normalizeRemotePath(path.join(remotePath, fileName));
        
        // 检查远程文件是否存在
        try {
            const stats = await sftp.stat(remoteFilePath);
            if (stats.isDirectory()) {
                throw new Warning(`A directory with the same name already exists at the target path: ${remoteFilePath}`);
            }
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }

        const stats = fs.statSync(fullLocalPath);
        let transferred = 0;

        const stream = sftp.createWriteStream(remoteFilePath);
        const fileStream = fs.createReadStream(fullLocalPath);

        await new Promise<void>((resolve, reject) => {
            stream.on('close', () => {
                onProgress({
                    fileName,
                    progress: 100,
                    direction: 'upload'
                });
                resolve();
            });

            stream.on('error', (err) => {
                console.error(`上傳文件 ${fileName} 時發生錯誤:`, err);
                reject(err);
            });

            fileStream.on('data', (chunk: Buffer) => {
                if (this._isCancelled) {
                    (fileStream as Readable).destroy();
                    stream.end();
                    reject(new Warning('Transfer cancelled by user'));
                    return;
                }
                transferred += chunk.length;
                const progress = (transferred / stats.size) * 100;
                onProgress({
                    fileName,
                    progress,
                    direction: 'upload'
                });
            });

            fileStream.on('error', (err) => {
                console.error(`讀取文件 ${fileName} 時發生錯誤:`, err);
                reject(err);
            });

            fileStream.pipe(stream);
        });
    }

    public async downloadFiles(
        client: SshClient,
        remotePaths: string[],
        localPath: string,
        onProgress: (progress: TransferProgress) => void
    ): Promise<void> {
        this.resetCancelFlag();
        const sftp = await client.sftp();

        // 标准化本地路径
        if (process.platform === 'win32') {
            localPath = this.normalizeWindowsPath(localPath);
        }

        try {
            // 串行处理每个文件
            for (const fullRemotePath of remotePaths) {
                if (this._isCancelled) {
                    throw new Error('Transfer cancelled');
                }
                const stats = await sftp.stat(fullRemotePath);
                if (stats.isDirectory()) {
                    await this.downloadDirectory(sftp, fullRemotePath, localPath, onProgress);
                } else {
                    await this.downloadSingleFile(sftp, fullRemotePath, localPath, onProgress);
                }
            }
        } catch (error) {
            console.error('Error downloading files:', error);
            throw error;
        }
    }

    private async downloadDirectory(
        sftp: SftpClient,
        remoteDirPath: string,
        localPath: string,
        onProgress: (progress: TransferProgress) => void
    ): Promise<void> {
        const dirName = path.basename(remoteDirPath);
        let localDirPath = path.join(localPath, dirName);
        
        // 标准化本地路径
        if (process.platform === 'win32') {
            localDirPath = this.normalizeWindowsPath(localDirPath);
        }
        
        // 确保本地目录存在
        await this.ensureLocalDirectoryExists(localDirPath);

        // 读取远程目录内容
        const items = await sftp.readdir(remoteDirPath);
        
        // 串行处理目录中的每个项目
        for (const item of items) {
            const remoteItemPath = path.posix.join(remoteDirPath, item.filename);
            const stats = await sftp.stat(remoteItemPath);
            
            if (stats.isDirectory()) {
                await this.downloadDirectory(sftp, remoteItemPath, localDirPath, onProgress);
            } else {
                await this.downloadSingleFile(sftp, remoteItemPath, localDirPath, onProgress);
            }
        }
    }

    private async downloadSingleFile(
        sftp: SftpClient,
        fullRemotePath: string,
        localPath: string,
        onProgress: (progress: TransferProgress) => void
    ): Promise<void> {
        const fileName = path.basename(fullRemotePath);
        let normalizedLocalPath = path.join(localPath, fileName);
        
        // 标准化本地路径
        if (process.platform === 'win32') {
            normalizedLocalPath = this.normalizeWindowsPath(normalizedLocalPath);
        }
        
        // 检查本地文件是否存在
        try {
            const stats = await fs.promises.stat(normalizedLocalPath);
            if (stats.isDirectory()) {
                throw new Warning(`A directory with the same name already exists at the target path: ${normalizedLocalPath}`);
            }
        } catch (error: any) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }

        const stats = await sftp.stat(fullRemotePath);
        let transferred = 0;

        const stream = fs.createWriteStream(normalizedLocalPath);
        const fileStream = sftp.createReadStream(fullRemotePath);

        await new Promise<void>((resolve, reject) => {
            stream.on('close', () => {
                onProgress({
                    fileName,
                    progress: 100,
                    direction: 'download'
                });
                resolve();
            });

            stream.on('error', (err) => {
                console.error(`下載文件 ${fileName} 時發生錯誤:`, err);
                reject(err);
            });

            fileStream.on('data', (chunk: Buffer) => {
                if (this._isCancelled) {
                    (fileStream as Readable).destroy();
                    stream.end();
                    reject(new Warning('Transfer cancelled by user'));
                    return;
                }
                transferred += chunk.length;
                const progress = (transferred / stats.size) * 100;
                onProgress({
                    fileName,
                    progress,
                    direction: 'download'
                });
            });

            fileStream.on('error', (err) => {
                console.error(`讀取遠程文件 ${fileName} 時發生錯誤:`, err);
                reject(err);
            });

            fileStream.pipe(stream);
        });
    }

    public async createLocalFolder(parentPath: string, folderName: string): Promise<void> {
        try {
            // 标准化父路径
            if (process.platform === 'win32') {
                parentPath = this.normalizeWindowsPath(parentPath);
            }

            // 清理文件夹名称
            folderName = folderName.replace(/[\\\/]/g, '');

            // 构建完整路径
            const fullPath = path.join(parentPath, folderName);

            try {
                await fs.promises.mkdir(fullPath, { recursive: true });
            } catch (error: any) {
                // 检查是否是路径已存在的错误
                if (error.code === 'EEXIST') {
                    throw new Warning(`Folder creation failed: Path already exists`);
                }
                throw error;
            }
        } catch (error: any) {
            if (error instanceof Warning) {
                throw error;
            }
            console.error(`創建本地文件夾失敗: ${error.message}`);
            throw error;
        }
    }

    public async createFolder(client: SshClient, parentPath: string, folderName: string): Promise<void> {
        const sftp = await client.sftp();
        // 远程路径使用正斜杠
        parentPath = parentPath.replace(/\\/g, '/');
        const fullPath = parentPath === '/' 
            ? '/' + folderName 
            : path.posix.join(parentPath, folderName);
        
        try {
            await sftp.mkdir(fullPath);
        } catch (error: any) {
            // 检查是否是路径已存在的错误
            if (error.message && (
                error.message.includes('already exists') ||
                error.message.includes('exists as a file') ||
                error.message.includes('File exists')
            )) {
                throw new Warning(`Folder creation failed: ${error.message}`);
            }
            console.error(`創建遠程文件夾失敗: ${error.message}`);
            throw error;
        }
    }

    private async ensureLocalDirectoryExists(dirPath: string): Promise<void> {
        if (process.platform === 'win32') {
            dirPath = this.normalizeWindowsPath(dirPath);
            
            // 检查是否是有效的Windows路径
            if (!/^[A-Za-z]:\\/.test(dirPath)) {
                throw new Error(`Invalid Windows path: ${dirPath}`);
            }
        }

        try {
            await fs.promises.mkdir(dirPath, { recursive: true });
        } catch (error: any) {
            if (error.code === 'EINVAL') {
                console.error(`Invalid path format: ${dirPath}`);
                throw new Warning(`Invalid path format: ${dirPath}`);
            }
            throw new Warning(`Failed to create directory: ${error.message}`);
        }
    }

    public async deleteLocalItem(path: string, isDirectory: boolean): Promise<void> {
        // 标准化Windows路径
        if (process.platform === 'win32') {
            path = this.normalizeWindowsPath(path);
        }

        if (isDirectory) {
            await this.recursiveDeleteLocal(path);
        } else {
            await fs.promises.unlink(path);
        }
    }

    private async recursiveDeleteLocal(dirPath: string): Promise<void> {
        // 标准化Windows路径
        if (process.platform === 'win32') {
            dirPath = this.normalizeWindowsPath(dirPath);
        }

        const items = await fs.promises.readdir(dirPath);

        // 串行删除每个文件和目录
        for (const item of items) {
            let itemPath = path.join(dirPath, item);
            
            // 标准化Windows路径
            if (process.platform === 'win32') {
                itemPath = this.normalizeWindowsPath(itemPath);
            }

            const stats = await fs.promises.stat(itemPath);
            
            if (stats.isDirectory()) {
                await this.recursiveDeleteLocal(itemPath);
            } else {
                await fs.promises.unlink(itemPath);
            }
        }

        // 删除空目录
        await fs.promises.rmdir(dirPath);
    }

    public async deleteItem(client: SshClient, path: string, isDirectory: boolean): Promise<void> {
        this.resetCancelFlag();
        const sftp = await client.sftp();
        
        // 远程路径使用正斜杠
        path = path.replace(/\\\\/g, '/');
        
        try {
            if (this._isCancelled) {
                throw new Error('Delete operation cancelled');
            }

            if (isDirectory) {
                // 使用 rmdir 的递归删除功能
                await sftp.rmdir(path);
            } else {
                await sftp.unlink(path);
            }
        } catch (error: any) {
            if (this._isCancelled) {
                throw new Error('Delete operation cancelled');
            }
            console.error('Error deleting remote item:', error);
            throw error;
        }
    }

    public async renameLocalItem(oldPath: string, newPath: string): Promise<void> {
        try {
            // 标准化路径
            if (process.platform === 'win32') {
                oldPath = this.normalizeWindowsPath(oldPath);
                newPath = this.normalizeWindowsPath(newPath);
            }

            // 检查目标路径是否已存在
            try {
                const stats = await fs.promises.stat(newPath);
                throw new Warning(`A file or directory already exists at the target path: ${newPath}`);
            } catch (error: any) {
                if (error.code !== 'ENOENT') {
                    throw error;
                }
            }

            // 执行重命名
            await fs.promises.rename(oldPath, newPath);
        } catch (error: any) {
            if (error instanceof Warning) {
                throw error;
            }
            console.error(`重命名失敗: ${error.message}`);
            throw error;
        }
    }

    public async renameRemoteItem(client: SshClient, oldPath: string, newPath: string): Promise<void> {
        const sftp = await client.sftp();
        try {
            // 标准化远程路径
            oldPath = this.normalizeRemotePath(oldPath);
            newPath = this.normalizeRemotePath(newPath);

            // 检查目标路径是否已存在
            try {
                await sftp.stat(newPath);
                throw new Warning(`A file or directory already exists at the target path: ${newPath}`);
            } catch (error: any) {
                if (error.code !== 'ENOENT') {
                    throw error;
                }
            }

            // 执行重命名
            await sftp.rename(oldPath, newPath);
        } catch (error: any) {
            if (error instanceof Warning) {
                throw error;
            }
            console.error(`重命名遠程文件失敗: ${error.message}`);
            throw error;
        }
    }
} 