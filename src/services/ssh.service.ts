import { ConnectionData } from '../types';
import { SshClient, SshConfig } from '../types/ssh.types';
import { SftpClientWrapper } from './ssh/sftp-client-wrapper';
import { ScpClientWrapper } from './ssh/scp-client-wrapper';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export type SshClientType = 'sftp-client' | 'scp-client';

export class SshService {
    private _client: SshClient | null = null;
    private _clientType: SshClientType;

    constructor(clientType: SshClientType = 'sftp-client') {
        this._clientType = clientType;
        this._client = this.createClient(clientType);
    }

    private createClient(type: SshClientType): SshClient {
        return type === 'sftp-client' 
            ? new SftpClientWrapper()
            : new ScpClientWrapper();
    }

    private async validatePrivateKeyFile(privateKeyPath: string): Promise<void> {
        // 檢查文件是否存在
        if (!fs.existsSync(privateKeyPath)) {
            throw new Error(`Private key file does not exist: ${privateKeyPath}`);
        }

        // 檢查是否為公鑰文件
        if (privateKeyPath.endsWith('.pub')) {
            throw new Error('Please select a private key file, not a public key file (.pub)');
        }

        // 檢查文件權限（僅在 Unix 系統上）
        if (process.platform !== 'win32') {
            try {
                const stats = fs.statSync(privateKeyPath);
                const mode = stats.mode & 0o777;
                if (mode > 0o600) {
                    const answer = await vscode.window.showWarningMessage(
                        'Private key file permissions are too open. It is recommended to change them to 600. Continue anyway?',
                        { modal: true },
                        'Continue', 'Cancel'
                    );
                    if (answer !== 'Continue') {
                        throw new Error('Operation cancelled due to insecure key file permissions');
                    }
                }
            } catch (error: any) {
                if (error.message.includes('Operation cancelled')) {
                    throw error;
                }
                throw new Error(`Failed to check key file permissions: ${error.message}`);
            }
        }

        // 檢查文件格式
        try {
            const keyContent = fs.readFileSync(privateKeyPath, 'utf8');
            if (!keyContent.includes('BEGIN') || !keyContent.includes('PRIVATE KEY')) {
                throw new Error('Invalid private key format. File should be in PEM format');
            }
        } catch (error: any) {
            if (error.message.includes('Invalid private key format')) {
                throw error;
            }
            throw new Error(`Failed to read private key file: ${error.message}`);
        }
    }

    public async connect(data: ConnectionData): Promise<void> {
        // 在连接新服务器前，确保完全断开旧连接
        this.disconnect();
        
        // 如果指定了新的clientType，则更新
        if (data.clientType && data.clientType !== this._clientType) {
            this._clientType = data.clientType;
        }
        
        const config: SshConfig = {
            host: data.host,
            port: parseInt(data.port) || 22,
            username: data.username,
            authType: data.type || 'password',
            readyTimeout: 12000
        };

        // 根据认证类型设置相应的认证信息
        if (config.authType === 'password') {
            if (!data.password) {
                throw new Error('Password is required for password authentication');
            }
            config.password = data.password;
        } else if (config.authType === 'key') {
            if (!data.privateKeyPath) {
                throw new Error('Private key path is required for key authentication');
            }

            // 驗證私鑰文件
            await this.validatePrivateKeyFile(data.privateKeyPath);

            try {
                // 讀取私鑰文件內容
                config.privateKey = fs.readFileSync(data.privateKeyPath);
                // 如果提供了密碼短語，則添加
                if (data.passphrase) {
                    config.passphrase = data.passphrase;
                }
            } catch (error: any) {
                throw new Error(`Failed to read private key file: ${error?.message || 'Unknown error'}`);
            }
        } else {
            throw new Error('Unsupported authentication type');
        }

        // 创建新的客户端实例
        this._client = this.createClient(this._clientType);
        await this._client.connect(config);
    }

    public getClient(): SshClient {
        if (!this._client) {
            throw new Error('Client not initialized');
        }
        return this._client;
    }

    public getClientType(): SshClientType {
        return this._clientType;
    }

    public disconnect(): void {
        if (this._client) {
            this._client.disconnect();
            // 强制清理客户端实例
            this._client = null;
        }
    }
} 