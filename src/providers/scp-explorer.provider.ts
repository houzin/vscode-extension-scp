import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SshService } from '../services/ssh.service';
import { FileService } from '../services/file.service';
import { ConnectionData, TransferProgress } from '../types';
import { Warning } from '../types/errors';

interface SavedConnection {
    id: string;
    name: string;
    host: string;
    port: string;
    username: string;
    password?: string; // Optional, required for password authentication
    authType: 'password' | 'key'; // Authentication type
    privateKeyPath?: string; // Optional, required for key authentication
    passphrase?: string; // Optional, key passphrase
}

// Extend ConnectionData type
interface ExtendedConnectionData extends ConnectionData {
    type: 'password' | 'key';
    privateKeyPath?: string;
    passphrase?: string;
}

export class ScpExplorerProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'scpExplorerView';
    private _view?: vscode.WebviewView;
    private _sshService: SshService;
    private _fileService: FileService;
    private _currentPath: string = '/';
    private _enableHeartbeat: boolean = true;
    private _context: vscode.ExtensionContext;
    private _isHeartbeatChecking: boolean = false; // 添加心跳检测状态标志

    constructor(
        private readonly _extensionUri: vscode.Uri,
        context: vscode.ExtensionContext
    ) {
        this._sshService = new SshService();
        this._fileService = new FileService();
        this._context = context;
    }

    // Get saved connections
    private async getSavedConnections(): Promise<SavedConnection[]> {
        return this._context.globalState.get<SavedConnection[]>('savedConnections', []);
    }

    // Save new connection
    private async saveConnection(connection: SavedConnection): Promise<void> {
        const connections = await this.getSavedConnections();
        connections.push(connection);
        await this._context.globalState.update('savedConnections', connections);
    }

    // Update existing connection
    private async updateConnection(connection: SavedConnection): Promise<void> {
        const connections = await this.getSavedConnections();
        const index = connections.findIndex(c => c.id === connection.id);
        if (index !== -1) {
            connections[index] = connection;
            await this._context.globalState.update('savedConnections', connections);
        }
    }

    // Delete connection
    private async deleteConnection(id: string): Promise<void> {
        const connections = await this.getSavedConnections();
        const filtered = connections.filter(c => c.id !== id);
        await this._context.globalState.update('savedConnections', filtered);
    }

    public notifyDisconnected() {
        this._view?.webview.postMessage({ type: 'disconnected' });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        // Read HTML template
        const htmlPath = path.join(this._extensionUri.fsPath, 'src', 'templates', 'explorer.html');
        const cssPath = path.join(this._extensionUri.fsPath, 'src', 'styles', 'explorer.css');
        const jsPath = path.join(this._extensionUri.fsPath, 'src', 'scripts', 'explorer.js');

        const htmlContent = fs.readFileSync(htmlPath, 'utf8');
        const cssContent = fs.readFileSync(cssPath, 'utf8');
        const jsContent = fs.readFileSync(jsPath, 'utf8');

        // Replace resource paths
        const htmlWithResources = htmlContent
            .replace('styles/explorer.css', webviewView.webview.asWebviewUri(vscode.Uri.file(cssPath)).toString())
            .replace('scripts/explorer.js', webviewView.webview.asWebviewUri(vscode.Uri.file(jsPath)).toString());

        webviewView.webview.html = htmlWithResources;

        // Send heartbeat status to WebView after it's ready
        setTimeout(() => {
            console.log('Sending heartbeat status:', this._enableHeartbeat);
            this._view?.webview.postMessage({ 
                type: 'heartbeatStatus', 
                enabled: this._enableHeartbeat 
            });
        }, 1000);

        // Send saved connection list to WebView after it's ready
        setTimeout(async () => {
            const connections = await this.getSavedConnections();
            this._view?.webview.postMessage({ 
                type: 'savedConnections', 
                connections 
            });
        }, 1000);

        // Listen for WebView messages
        webviewView.webview.onDidReceiveMessage(async message => {
            console.log('Received WebView message:', message);
            try {
                switch (message.type) {
                    case 'log':
                        console.log('[WebView]', message.message);
                        // Send heartbeat status to WebView after receiving WebView initialization message
                        if (message.message === 'WebView initialized') {
                            console.log('WebView initialized, sending heartbeat status:', this._enableHeartbeat);
                            this._view?.webview.postMessage({ 
                                type: 'heartbeatStatus', 
                                enabled: this._enableHeartbeat 
                            });
                        }
                        break;
                        
                    case 'browsePrivateKey':
                        // Get user home directory
                        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
                        const defaultSshDir = path.join(homeDir, '.ssh');
                        
                        // Common key file names
                        const commonKeyNames = [
                            'id_rsa',
                            'id_ed25519',
                            'id_ecdsa',
                            'id_dsa',
                            'identity'
                        ];

                        try {
                            // Check if .ssh directory exists
                            await vscode.workspace.fs.stat(vscode.Uri.file(defaultSshDir));
                        } catch (error) {
                            // Create .ssh directory if it doesn't exist
                            await vscode.workspace.fs.createDirectory(vscode.Uri.file(defaultSshDir));
                        }

                        const result = await vscode.window.showOpenDialog({
                            canSelectFiles: true,
                            canSelectFolders: false,
                            canSelectMany: false,
                            title: 'Select SSH Private Key File',
                            defaultUri: vscode.Uri.file(defaultSshDir),
                            filters: {
                                'SSH Private Keys': ['*'],  // No restriction on extension, as private key files usually don't have extensions
                            },
                            openLabel: 'Select Private Key File'
                        });
                        
                        if (result && result[0]) {
                            // Check if a public key file was selected
                            if (result[0].fsPath.endsWith('.pub')) {
                                this._view?.webview.postMessage({
                                    type: 'error',
                                    message: 'Please select a private key file, not a public key file (.pub)'
                                });
                                return;
                            }

                            // Check file permissions (Unix-like systems only)
                            if (process.platform !== 'win32') {
                                try {
                                    const stats = await vscode.workspace.fs.stat(result[0]);
                                    // vscode.FilePermission is a number
                                    const mode = (stats.permissions || 0) & 0o777;
                                    // Check if file permissions are too open
                                    if (mode > 0o600) {
                                        const answer = await vscode.window.showWarningMessage(
                                            'Private key file permissions are too open. It is recommended to change them to 600. Continue anyway?',
                                            { modal: true },
                                            'Continue', 'Cancel'
                                        );
                                        if (answer !== 'Continue') {
                                            return;
                                        }
                                    }
                                } catch (error) {
                                    console.error('Error checking file permissions:', error);
                                }
                            }

                            this._view?.webview.postMessage({
                                type: 'privateKeySelected',
                                path: result[0].fsPath
                            });
                        }
                        break;

                    case 'connect':
                        console.log('Processing connection request');
                        await this.connect(message.data);
                        break;
                        
                    case 'listFiles':
                        console.log('Processing list request:', message.path);
                        await this.listFiles(message.path);
                        break;
                    case 'createFolder':
                        console.log('Processing create folder request:', message.path, message.folderName);
                        await this.createFolder(message.path, message.folderName, message.isLocal);
                        break;
                    case 'delete':
                        await this.deleteItem(message.path, message.isDirectory, message.isLocal);
                        break;
                    case 'listLocalFiles':
                        await this.listLocalFiles(message.path);
                        break;
                    case 'upload':
                        try {
                            await this.uploadFiles(message.localPaths, message.remotePath);
                            webviewView.webview.postMessage({
                                type: 'success',
                                message: 'File upload successful'
                            });
                        } catch (error) {
                            console.error('Error uploading files:', error);
                            webviewView.webview.postMessage({
                                type: 'error',
                                message: error instanceof Error ? error.message : 'File upload failed'
                            });
                        }
                        break;
                    case 'download':
                        try {
                            await this.downloadFiles(message.remotePaths, message.localPath);
                            webviewView.webview.postMessage({
                                type: 'success',
                                message: 'File download successful'
                            });
                        } catch (error) {
                            console.error('Error downloading files:', error);
                            webviewView.webview.postMessage({
                                type: 'error',
                                message: error instanceof Error ? error.message : 'File download failed'
                            });
                        }
                        break;
                    case 'rename':
                        try {
                            if (message.isLocal) {
                                await this._fileService.renameLocalItem(message.oldPath, message.newPath);
                            } else {
                                const client = this._sshService.getClient();
                                await this._fileService.renameRemoteItem(client, message.oldPath, message.newPath);
                            }
                            this._view?.webview.postMessage({
                                type: 'renamed',
                                isLocal: message.isLocal
                            });
                        } catch (error: any) {
                            this._view?.webview.postMessage({
                                type: 'error',
                                message: error.message
                            });
                        }
                        break;
                    case 'showError':
                        vscode.window.showErrorMessage(message.message);
                        break;
                    case 'heartbeat':
                        console.log('Received heartbeat request, enabled:', this._enableHeartbeat);
                        if (this._enableHeartbeat && !this._isHeartbeatChecking) {
                            try {
                                this._isHeartbeatChecking = true;
                                const client = this._sshService.getClient();
                                if (!client) throw new Error('Not connected');
                                await this._fileService.listRemoteFiles(client, this._currentPath || '/');
                                console.log('Heartbeat check passed');
                                webviewView.webview.postMessage({ type: 'heartbeatOk' });
                            } catch (e) {
                                console.error('Heartbeat check failed:', e);
                                webviewView.webview.postMessage({ type: 'heartbeatFail' });
                            } finally {
                                this._isHeartbeatChecking = false;
                            }
                        }
                        break;
                    case 'disconnect':
                        try {
                            await this._sshService.disconnect();
                        } catch (e) {}
                        webviewView.webview.postMessage({ type: 'disconnected' });
                        break;
                    case 'cancelTransfer':
                        console.log('Cancelling transfer');
                        this._fileService.cancelTransfer();
                        break;
                    case 'saveConnection':
                        await this.saveConnection(message.connection);
                        const connections = await this.getSavedConnections();
                        webviewView.webview.postMessage({
                            type: 'savedConnections',
                            connections,
                            success: true,
                            isUpdate: false,
                            savedConnection: message.connection
                        });
                        break;
                    case 'updateConnection':
                        await this.updateConnection(message.connection);
                        webviewView.webview.postMessage({
                            type: 'savedConnections',
                            connections: await this.getSavedConnections(),
                            success: true,
                            isUpdate: true
                        });
                        break;
                    case 'deleteConnection':
                        await this.deleteConnection(message.id);
                        webviewView.webview.postMessage({
                            type: 'savedConnections',
                            connections: await this.getSavedConnections(),
                            success: true,
                            isDelete: true
                        });
                        break;
                }
            } catch (error) {
                console.error('Error processing message:', error);
                webviewView.webview.postMessage({
                    type: 'error',
                    message: error instanceof Error ? error.message : 'Unknown error occurred'
                });
            }
        });
    }

    private async connect(data: ExtendedConnectionData) {
        try {
            // Default to SFTP client
            data.clientType = 'sftp-client';
            
            // Verify private key file exists if using key authentication
            if (data.type === 'key' && data.privateKeyPath) {
                try {
                    await vscode.workspace.fs.stat(vscode.Uri.file(data.privateKeyPath));
                } catch (error) {
                    throw new Error('Private key file does not exist or is not accessible');
                }
            }
            
            await this._sshService.connect(data);
            // Get the final client type used
            const clientType = this._sshService.getClientType();
            this._view?.webview.postMessage({ 
                type: 'connected',
                clientType: clientType // Send client type to frontend
            });
        } catch (error: any) {
            // Check if it's an SFTP subsystem error
            if (error.message && error.message.toLowerCase().includes('subsystem')) {
                const answer = await vscode.window.showWarningMessage(
                    'SFTP is not available. Would you like to switch to SCP mode (using scp -O for optimized copy)?',
                    { modal: true },  // Modal dialog will be shown in the center of the window
                    'Yes (Use SCP)',
                    'No'
                );
                
                if (answer === 'Yes (Use SCP)') {
                    // Switch to SCP mode and reconnect
                    data.clientType = 'scp-client';
                    await this._sshService.connect(data);
                    const clientType = this._sshService.getClientType();
                    this._view?.webview.postMessage({ 
                        type: 'connected',
                        clientType: clientType
                    });
                    return;
                }
            }
            
            this._view?.webview.postMessage({
                type: 'error',
                message: error.message
            });
            throw error;
        }
    }

    private async listFiles(remotePath: string) {
        const client = this._sshService.getClient();
        const result = await this._fileService.listRemoteFiles(client, remotePath);
        this._currentPath = result.actualPath;
        this._view?.webview.postMessage({
            type: 'fileList',
            files: result.files,
            path: result.actualPath
        });
    }

    private async listLocalFiles(localPath: string) {
        const files = await this._fileService.listLocalFiles(localPath);
        this._view?.webview.postMessage({
            type: 'localFileList',
            files: files
        });
    }

    private async createFolder(parentPath: string, folderName: string, isLocal: boolean) {
        try {
            if (isLocal) {
                await this._fileService.createLocalFolder(parentPath, folderName);
                this._view?.webview.postMessage({
                    type: 'folderCreated',
                    isLocal: true
                });
            } else {
                const client = this._sshService.getClient();
                await this._fileService.createFolder(client, parentPath, folderName);
                this._view?.webview.postMessage({
                    type: 'folderCreated',
                    isLocal: false
                });
            }
        } catch (error: any) {
            throw error;

            // this._view?.webview.postMessage({
            //     type: 'error',
            //     message: error.message
            // });
        }
    }

    private async deleteItem(path: string, isDirectory: boolean, isLocal: boolean) {
        if (isLocal) {
            await this._fileService.deleteLocalItem(path, isDirectory);
            this._view?.webview.postMessage({
                type: 'deleted',
                isLocal: true
            });
        } else {
            const client = this._sshService.getClient();
            await this._fileService.deleteItem(client, path, isDirectory);
            this._view?.webview.postMessage({
                type: 'deleted',
                isLocal: false
            });
        }
    }

    private async uploadFiles(localPaths: string[], remotePath: string) {
        const client = this._sshService.getClient();
        await this._fileService.uploadFiles(
            client,
            localPaths,
            remotePath,
            (progress: TransferProgress) => {
                this._view?.webview.postMessage({
                    type: 'transferProgress',
                    ...progress
                });
            }
        );
        this._view?.webview.postMessage({
            type: 'transferComplete',
            direction: 'upload'
        });
    }

    private async downloadFiles(remotePaths: string[], localPath: string) {
        try {
            const client = this._sshService.getClient();
            await this._fileService.downloadFiles(
                client,
                remotePaths,
                localPath,
                (progress: TransferProgress) => {
                    this._view?.webview.postMessage({
                        type: 'transferProgress',
                        ...progress
                    });
                }
            );
            this._view?.webview.postMessage({
                type: 'transferComplete',
                direction: 'download'
            });
        } catch (error: any) {
            this._view?.webview.postMessage({
                type: 'error',
                message: error.message
            });
        }
    }

    public async prepareForUpload(localPath: string) {
        // 等待 this._view 準備就緒
        const maxAttempts = 50; // 最多等待 5 秒 (50 * 100ms)
        let attempts = 0;
        
        while (!this._view && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }

        if (!this._view) {
            vscode.window.showErrorMessage('SCP Explorer view is not initialized');
            return;
        }

        await new Promise(resolve => setTimeout(resolve, 500));

        // Notify WebView to prepare for upload
        this._view.webview.postMessage({
            type: 'prepareUpload',
            localPath: localPath
        });
    }
} 