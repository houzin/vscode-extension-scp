import * as Client from 'ssh2-sftp-client';
import { SshClient, SshConfig, SftpClient, SshFileStats } from '../../types/ssh.types';
import * as vscode from 'vscode';

export class SftpClientWrapper implements SshClient {
    private _sftpClient: any;
    private _activeStreams: Set<any> = new Set();
    private _isConnected: boolean = false;
    private readonly CHUNK_SIZE = 1024 * 1024; // 1MB 块大小
    private readonly WINDOW_SIZE = 2 * 1024 * 1024; // 2MB 窗口大小
    private readonly READ_AHEAD_CHUNKS = 8; // 预读8个块

    constructor() {
        this._sftpClient = new Client.default();
        console.log('SftpClientWrapper initialized');
        
        // 设置更大的窗口大小和缓冲区
        if (this._sftpClient.client) {
            this._sftpClient.client.config = {
                ...this._sftpClient.client.config,
                readyTimeout: 30000,
                keepaliveInterval: 10000,
                keepaliveCountMax: 3,
                debug: false
            };
        }
    }

    public async connect(config: SshConfig): Promise<void> {
        const client = this._sftpClient;
        if (client.client && typeof client.client.setMaxListeners === 'function') {
            client.client.setMaxListeners(100);
        }

        try {
            const sftpConfig: any = {
                host: config.host,
                port: config.port,
                username: config.username,
                readyTimeout: config.readyTimeout || 30000,
                algorithms: {
                    cipher: [
                        'aes128-gcm',
                        'aes256-gcm',
                        'aes128-ctr',
                        'aes192-ctr',
                        'aes256-ctr'
                    ]
                },
                compress: 'force', // 强制启用压缩
                debug: false,
                // 添加高级配置
                transport: {
                    windowSize: this.WINDOW_SIZE,
                    packetSize: this.CHUNK_SIZE,
                    disableStatus: true // 禁用状态更新以减少开销
                }
            };

            if (config.authType === 'password' && config.password) {
                sftpConfig.password = config.password;
            } else if (config.authType === 'key') {
                if (config.privateKey) {
                    sftpConfig.privateKey = config.privateKey;
                    if (config.passphrase) {
                        sftpConfig.passphrase = config.passphrase;
                    }
                } else {
                    throw new Error('Private key is required for key authentication');
                }
            } else {
                throw new Error('Invalid authentication configuration');
            }

            await this._sftpClient.connect(sftpConfig);

            if (client.sftp && typeof client.sftp.setMaxListeners === 'function') {
                client.sftp.setMaxListeners(100);
            }

            // 设置更大的窗口大小
            if (client.sftp) {
                client.sftp.windowSize = this.WINDOW_SIZE;
                client.sftp.maxPacketSize = this.CHUNK_SIZE;
            }

            this._isConnected = true;

            client.on('error', (err: Error) => {
                if (err.message.includes('ECONNRESET') || err.message.toLowerCase().includes('subsystem')) {
                    console.error('Connection error:', err);
                    this._isConnected = false;
                    vscode.commands.executeCommand('vscode-extension-scp.disconnected');
                }
            });

        } catch (error: any) {
            this._isConnected = false;
            console.error('Connection failed:', error);
            if (error.message && error.message.toLowerCase().includes('subsystem')) {
                throw new Error('SFTP subsystem not available on the remote server. Please ensure SFTP is properly configured.');
            }
            if (error.message && (
                error.message.toLowerCase().includes('key') ||
                error.message.toLowerCase().includes('authentication failed') ||
                error.message.toLowerCase().includes('auth method none failed') ||
                error.message.toLowerCase().includes('all configured authentication methods failed')
            )) {
                throw new Error(`SSH key authentication failed: ${error.message}`);
            }
            throw error;
        }
    }

    public disconnect(): void {
        // Clean up all active streams
        for (const stream of this._activeStreams) {
            try {
                stream.destroy();
            } catch (error) {
                console.error('Error destroying stream:', error);
            }
        }
        this._activeStreams.clear();
        
        // Disconnect
        if (this._sftpClient) {
            try {
                // Remove all event listeners
                this._sftpClient.removeAllListeners();
                
                // End connection
                this._sftpClient.end();
                
                // Create new client instance
                this._sftpClient = new Client.default();
            } catch (error) {
                console.error('Error ending SFTP client:', error);
            }
        }
        this._isConnected = false;
    }

    public async sftp(): Promise<SftpClient> {
        if (!this._isConnected) {
            throw new Error('Not connected to server');
        }

        return {
            readdir: async (path: string) => {
                try {
                    const timeoutPromise = new Promise((_, reject) => {
                        setTimeout(() => reject(new Error('ETIMEDOUT')), 12000);
                    });
                    
                    const listPromise = this._sftpClient.list(path);
                    const list = await Promise.race([listPromise, timeoutPromise]);
                    
                    return list.map((item: any) => ({
                        filename: item.name,
                        attrs: {
                            isDirectory: () => item.type === 'd',
                            size: item.size,
                            mtime: item.modifyTime
                        }
                    }));
                } catch (error: any) {
                    if (error.message.includes('ECONNRESET') || 
                        error.message.includes('ETIMEDOUT') ||
                        error.message.includes('ENETUNREACH') ||
                        error.message.includes('EHOSTUNREACH') ||
                        error.code === 'ECONNREFUSED' ||
                        error.code === 'ENETUNREACH' ||
                        error.code === 'EHOSTUNREACH') {
                        this._isConnected = false;
                        vscode.commands.executeCommand('vscode-extension-scp.disconnected');
                    }
                    throw error;
                }
            },
            mkdir: async (path: string) => {
                await this._sftpClient.mkdir(path);
            },
            rmdir: async (path: string) => {
                await this._sftpClient.rmdir(path, true);
            },
            unlink: async (path: string) => {
                await this._sftpClient.delete(path);
            },
            rename: async (oldPath: string, newPath: string) => {
                await this._sftpClient.rename(oldPath, newPath);
            },
            createReadStream: (path: string) => {
                // 创建一个 Transform 流来处理数据
                const { Transform } = require('stream');
                const transformStream = new Transform({
                    highWaterMark: this.CHUNK_SIZE * 2,
                    transform(chunk: any, encoding: string, callback: Function) {
                        callback(null, chunk);
                    }
                });

                // 配置 SFTP 读取流
                const stream = this._sftpClient.createReadStream(path, {
                    bufferSize: this.CHUNK_SIZE,
                    autoClose: true,
                    encoding: null,
                    highWaterMark: this.CHUNK_SIZE * 2,
                    readAhead: this.CHUNK_SIZE * this.READ_AHEAD_CHUNKS, // 预读8MB
                    concurrency: 4 // 并行读取
                });

                // 添加到活动流集合
                this._activeStreams.add(stream);
                this._activeStreams.add(transformStream);

                // 错误处理
                const handleError = (err: Error) => {
                    if (err.message.includes('ECONNRESET')) {
                        this._isConnected = false;
                    }
                    this._activeStreams.delete(stream);
                    this._activeStreams.delete(transformStream);
                    transformStream.destroy(err);
                };

                // 连接流
                stream.pipe(transformStream);

                // 事件处理
                stream.once('error', handleError);
                transformStream.once('error', handleError);

                stream.once('end', () => {
                    this._activeStreams.delete(stream);
                });

                transformStream.once('end', () => {
                    this._activeStreams.delete(transformStream);
                });

                // 返回转换流
                return transformStream;
            },
            createWriteStream: (path: string) => {
                const stream = this._sftpClient.createWriteStream(path, {
                    bufferSize: this.CHUNK_SIZE,
                    autoClose: true,
                    encoding: null,
                    highWaterMark: this.CHUNK_SIZE,
                    flags: 'w',
                    mode: 0o644
                });
                
                this._activeStreams.add(stream);
                stream.once('finish', () => {
                    this._activeStreams.delete(stream);
                });
                stream.once('error', (err: Error) => {
                    if (err.message.includes('ECONNRESET')) {
                        this._isConnected = false;
                    }
                    this._activeStreams.delete(stream);
                });
                
                return stream;
            },
            stat: async (path: string) => {
                const stats = await this._sftpClient.stat(path);
                return { 
                    size: stats.size,
                    isDirectory: () => stats.isDirectory
                };
            }
        };
    }
} 