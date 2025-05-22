import { SshClient, SshConfig, SftpClient, SshFileStats } from '../../types/ssh.types';
import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Readable, Writable } from 'stream';
import { Client } from 'ssh2';

const execAsync = promisify(exec);

export class ScpClientWrapper implements SshClient {
    private _config?: SshConfig;
    private _activeStreams: Set<any> = new Set();
    private _isConnected: boolean = false;
    private _sftpClient: any;

    constructor() {
        this._sftpClient = new Client();
        console.log('ScpClientWrapper initialized');
    }

    private async withRetry<T>(
        operation: () => Promise<T>,
        operationName: string,
        retryCount = 3,
        retryDelay = 2000
    ): Promise<T> {
        for (let attempt = 1; attempt <= retryCount; attempt++) {
            try {
                return await operation();
            } catch (error: any) {
                console.error(`${operationName} attempt ${attempt} failed:`, error.message);
                
                if (attempt === retryCount) {
                    throw error;
                }
                
                if (error.message.includes('Connection closed') || 
                    error.message.includes('kex_exchange_identification') ||
                    error.message.includes('Connection reset') ||
                    error.message.includes('read: Connection reset by peer')) {
                    
                    const delay = retryDelay * Math.pow(2, attempt - 1);
                    console.log(`Waiting ${delay}ms before retry ${attempt + 1}...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
                
                throw error;
            }
        }
        throw new Error(`${operationName} failed after ${retryCount} attempts`);
    }

    private async execCommand(cmd: string, description: string): Promise<string> {
        const sshOptions = [
            'StrictHostKeyChecking=no',
            'ConnectTimeout=30',
            'ServerAliveInterval=60',
            'ServerAliveCountMax=3',
            'TCPKeepAlive=yes'
        ].map(opt => `-o "${opt}"`).join(' ');

        if (cmd.includes('ssh ')) {
            cmd = cmd.replace('ssh ', `ssh ${sshOptions} `);
        } else if (cmd.includes('scp ')) {
            cmd = cmd.replace('scp ', `scp ${sshOptions} `);
        }

        console.log(`Executing command (${description}):`, cmd);
        try {
            const { stdout, stderr } = await execAsync(cmd);
            if (stderr) {
                console.warn(`Command warning (${description}):`, stderr);
            }
            return stdout;
        } catch (error) {
            console.error(`Command failed (${description}):`, error);
            throw error;
        }
    }

    private getAuthCommand(): string {
        if (!this._config) {
            throw new Error('Configuration not initialized');
        }

        if (this._config.authType === 'password' && this._config.password) {
            return `sshpass -p "${this._config.password}"`;
        } else if (this._config.authType === 'key' && this._config.privateKey) {
            // Create temporary key file
            const tempKeyPath = path.join(os.tmpdir(), `ssh-key-${Date.now()}`);
            fs.writeFileSync(tempKeyPath, this._config.privateKey, { mode: 0o600 });
            
            const identityOption = this._config.passphrase 
                ? `"sshpass -p '${this._config.passphrase}' ssh-add ${tempKeyPath} && ssh-add -l && rm ${tempKeyPath} && "`
                : `-i "${tempKeyPath}"`;
            
            return identityOption;
        }
        throw new Error('Invalid authentication configuration');
    }

    public async connect(config: SshConfig): Promise<void> {
        try {
            console.log('Attempting to connect to server:', config.host);
            
            const sshOptions = [
                'StrictHostKeyChecking=no',
                'ConnectTimeout=30',
                'ServerAliveInterval=60',
                'ServerAliveCountMax=3',
                'TCPKeepAlive=yes'
            ].map(opt => `-o "${opt}"`).join(' ');

            let sshTestCmd: string;
            if (config.authType === 'password' && config.password) {
                sshTestCmd = `sshpass -p "${config.password}" ssh -p ${config.port} ${sshOptions} ${config.username}@${config.host} "echo Connection test"`;
            } else if (config.authType === 'key' && config.privateKey) {
                const tempKeyPath = path.join(os.tmpdir(), `ssh-key-${Date.now()}`);
                fs.writeFileSync(tempKeyPath, config.privateKey, { mode: 0o600 });
                
                if (config.passphrase) {
                    sshTestCmd = `sshpass -p "${config.passphrase}" ssh-add ${tempKeyPath} && ssh-add -l && ssh -p ${config.port} ${sshOptions} ${config.username}@${config.host} "echo Connection test" && rm ${tempKeyPath}`;
                } else {
                    sshTestCmd = `ssh -i "${tempKeyPath}" -p ${config.port} ${sshOptions} ${config.username}@${config.host} "echo Connection test" && rm ${tempKeyPath}`;
                }
            } else {
                throw new Error('Invalid authentication configuration');
            }
            
            await this.withRetry(
                () => this.execCommand(sshTestCmd, 'SSH Connection Test'),
                'SSH Connection Test'
            );
            
            this._config = config;
            this._isConnected = true;
            console.log('Connection successful');
        } catch (error: any) {
            this._isConnected = false;
            console.error('Connection failed:', error);
            if (error.message.includes('command not found')) {
                if (error.message.includes('sshpass')) {
                    throw new Error('sshpass command not found. Please install:\nWindows: scoop install sshpass\nLinux: sudo apt-get install sshpass\nmacOS: brew install esolitos/ipa/sshpass');
                }
                throw new Error('ssh or scp command not found in system');
            }
            throw error;
        }
    }

    public disconnect(): void {
        // 清理所有活动的流
        for (const stream of this._activeStreams) {
            try {
                stream.destroy();
            } catch (error) {
                console.error('Error destroying stream:', error);
            }
        }
        this._activeStreams.clear();
        this._isConnected = false;
    }

    public async sftp(): Promise<SftpClient> {
        if (!this._isConnected || !this._config) {
            throw new Error('未连接到服务器');
        }

        const config = this._config;
        const sshOptions = [
            'StrictHostKeyChecking=no',
            'ConnectTimeout=30',
            'ServerAliveInterval=60',
            'ServerAliveCountMax=3',
            'TCPKeepAlive=yes'
        ].map(opt => `-o "${opt}"`).join(' ');

        let sshBaseCmd: string;
        let scpBaseCmd: string;

        if (config.authType === 'password' && config.password) {
            sshBaseCmd = `sshpass -p "${config.password}" ssh -p ${config.port} ${sshOptions} ${config.username}@${config.host}`;
            scpBaseCmd = `sshpass -p "${config.password}" scp -O -P ${config.port} ${sshOptions}`;
        } else if (config.authType === 'key' && config.privateKey) {
            const tempKeyPath = path.join(os.tmpdir(), `ssh-key-${Date.now()}`);
            fs.writeFileSync(tempKeyPath, config.privateKey, { mode: 0o600 });
            
            if (config.passphrase) {
                sshBaseCmd = `sshpass -p "${config.passphrase}" ssh-add ${tempKeyPath} && ssh -p ${config.port} ${sshOptions} ${config.username}@${config.host}`;
                scpBaseCmd = `sshpass -p "${config.passphrase}" ssh-add ${tempKeyPath} && scp -O -P ${config.port} ${sshOptions}`;
            } else {
                sshBaseCmd = `ssh -i "${tempKeyPath}" -p ${config.port} ${sshOptions} ${config.username}@${config.host}`;
                scpBaseCmd = `scp -i "${tempKeyPath}" -O -P ${config.port} ${sshOptions}`;
            }
        } else {
            throw new Error('无效的认证配置');
        }

        return {
            readdir: async (remotePath: string) => {
                const escapedPath = remotePath.replace(/(["'$\\])/g, '\\$1');
                const cmd = `${sshBaseCmd} "ls -la '${escapedPath}'"`;
                const { stdout } = await this.withRetry(
                    () => execAsync(cmd),
                    `List directory: ${remotePath}`
                );
                const lines = stdout.split('\n').slice(1);
                
                return lines
                    .filter(line => line.trim())
                    .map(line => {
                        const parts = line.split(/\s+/);
                        const isDir = line.startsWith('d');
                        const size = parseInt(parts[4]);
                        const name = parts.slice(8).join(' ');
                        
                        return {
                            filename: name,
                            attrs: {
                                isDirectory: () => isDir,
                                size: size,
                                mtime: Math.floor(Date.now() / 1000)
                            }
                        } as SshFileStats;
                    })
                    .filter(item => item.filename !== '.' && item.filename !== '..');
            },

            mkdir: async (remotePath: string) => {
                const escapedPath = remotePath.replace(/(["'$\\])/g, '\\$1');
                const cmd = `${sshBaseCmd} "mkdir -p '${escapedPath}'"`;
                await this.withRetry(
                    () => execAsync(cmd),
                    `Create directory: ${remotePath}`
                );
            },

            rmdir: async (remotePath: string) => {
                const escapedPath = remotePath.replace(/(["'$\\])/g, '\\$1');
                const cmd = `${sshBaseCmd} "rm -rf '${escapedPath}'"`;
                await this.withRetry(
                    () => execAsync(cmd),
                    `Remove directory: ${remotePath}`
                );
            },

            unlink: async (remotePath: string) => {
                const escapedPath = remotePath.replace(/(["'$\\])/g, '\\$1');
                const cmd = `${sshBaseCmd} "rm -f '${escapedPath}'"`;
                await this.withRetry(
                    () => execAsync(cmd),
                    `Delete file: ${remotePath}`
                );
            },

            rename: async (oldPath: string, newPath: string) => {
                const escapedOldPath = oldPath.replace(/(["'$\\])/g, '\\$1');
                const escapedNewPath = newPath.replace(/(["'$\\])/g, '\\$1');
                const cmd = `${sshBaseCmd} "mv '${escapedOldPath}' '${escapedNewPath}'"`;
                await this.withRetry(
                    () => execAsync(cmd),
                    `Rename file: ${oldPath} to ${newPath}`
                );
            },

            createReadStream: (remotePath: string) => {
                const tempFile = path.join(os.tmpdir(), `scp-download-${Date.now()}`);
                const escapedPath = remotePath.replace(/(['"&\\$\s])/g, '\\$1');
                const cmd = `${scpBaseCmd} ${config.username}@${config.host}:"${escapedPath}" "${tempFile}"`;
                
                const stream = new Readable({
                    read() {}
                }) as unknown as NodeJS.ReadableStream;

                this._activeStreams.add(stream);

                execAsync(cmd).then(() => {
                    const fileStream = fs.createReadStream(tempFile);
                    fileStream.on('data', (chunk) => {
                        stream.emit('data', chunk);
                    });
                    fileStream.on('end', () => {
                        fs.unlink(tempFile, () => {});
                        stream.emit('end');
                        this._activeStreams.delete(stream);
                    });
                    fileStream.on('error', (err) => {
                        console.error('Error reading temporary file:', err);
                        stream.emit('error', err);
                        fs.unlink(tempFile, () => {});
                        this._activeStreams.delete(stream);
                    });
                }).catch(err => {
                    console.error('Error downloading file:', err);
                    stream.emit('error', err);
                    this._activeStreams.delete(stream);
                    fs.unlink(tempFile, () => {});
                });

                return stream;
            },

            createWriteStream: (remotePath: string) => {
                const tempFile = path.join(os.tmpdir(), `scp-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
                const stream = fs.createWriteStream(tempFile);
                
                this._activeStreams.add(stream);

                stream.on('finish', async () => {
                    try {
                        // Ensure remote directory exists
                        const remoteDir = path.dirname(remotePath);
                        const escapedDir = remoteDir.replace(/(["'$\\])/g, '\\$1');
                        const mkdirCmd = `${sshBaseCmd} "mkdir -p '${escapedDir}'"`;
                        
                        await this.withRetry(
                            () => execAsync(mkdirCmd),
                            `Create remote directory: ${remoteDir}`
                        );

                        // Upload file
                        const escapedPath = remotePath.replace(/(["'$\\])/g, '\\$1');
                        const cmd = `${scpBaseCmd} "${tempFile}" "${config.username}@${config.host}:'${escapedPath}'"`;
                        
                        await this.withRetry(
                            () => execAsync(cmd),
                            `Upload file: ${remotePath}`
                        );

                        fs.unlink(tempFile, () => {});
                        this._activeStreams.delete(stream);
                    } catch (err) {
                        stream.emit('error', err);
                        this._activeStreams.delete(stream);
                        fs.unlink(tempFile, () => {});
                    }
                });

                return stream;
            },

            stat: async (remotePath: string) => {
                try {
                    const escapedPath = remotePath.replace(/(["'$\\])/g, '\\$1');
                    const cmd = `${sshBaseCmd} "stat --format='%s %F' '${escapedPath}'"`;
                    const { stdout } = await this.withRetry(
                        () => execAsync(cmd),
                        `Get file stats: ${remotePath}`
                    );
                    
                    const [size, type] = stdout.trim().split(' ');
                    return {
                        size: parseInt(size),
                        isDirectory: () => type.includes('directory')
                    };
                } catch (error: any) {
                    // Ensure error contains ENOENT code
                    error.code = 'ENOENT';
                    throw error;
                }
            }
        };
    }
} 