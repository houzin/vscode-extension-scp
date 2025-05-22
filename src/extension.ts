import * as vscode from 'vscode';
import { Client } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import { ScpExplorerProvider } from './providers/scp-explorer.provider';

let currentConnection: Client | null = null;

export function activate(context: vscode.ExtensionContext) {
    const scpExplorerProvider = new ScpExplorerProvider(context.extensionUri, context);
    
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ScpExplorerProvider.viewType,
            scpExplorerProvider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        )
    );

    // 註冊所有命令
    const commands = [
        vscode.commands.registerCommand('vscode-extension-scp.openExplorer', () => {
            vscode.commands.executeCommand('scpExplorerView.focus');
        }),
        vscode.commands.registerCommand('vscode-extension-scp.sendToScp', async (uri: vscode.Uri) => {
            // Try to get the file from active editor if no uri provided
            if (!uri) {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor) {
                    uri = activeEditor.document.uri;
                }
            }

            if (!uri) {
                vscode.window.showErrorMessage('Please select a file or folder to send');
                return;
            }

            // Open SCP Explorer view first
            await vscode.commands.executeCommand('scpExplorerView.focus');

            // Notify WebView to prepare for upload
            scpExplorerProvider.prepareForUpload(uri.fsPath);
        })
    ];

    context.subscriptions.push(...commands);

    // 连接到服务器
    let connectCommand = vscode.commands.registerCommand('vscode-extension-scp.connect', async () => {
        const host = await vscode.window.showInputBox({
            prompt: 'Enter server address',
            placeHolder: 'e.g. example.com'
        });
        if (!host) return;

        const username = await vscode.window.showInputBox({
            prompt: 'Enter username',
            placeHolder: 'e.g. root'
        });
        if (!username) return;

        const password = await vscode.window.showInputBox({
            prompt: 'Enter password',
            password: true
        });
        if (!password) return;

        const client = new Client();
        
        client.on('ready', () => {
            currentConnection = client;
            vscode.window.showInformationMessage(`Successfully connected to ${host}`);
        });

        client.on('error', (err) => {
            vscode.window.showErrorMessage(`Connection error: ${err.message}`);
        });

        client.connect({
            host: host,
            username: username,
            password: password
        });
    });

    // 上传文件
    let uploadCommand = vscode.commands.registerCommand('vscode-extension-scp.upload', async () => {
        if (!currentConnection) {
            vscode.window.showErrorMessage('Please connect to server first');
            return;
        }

        const fileUris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false
        });

        if (!fileUris || fileUris.length === 0) return;

        const remotePath = await vscode.window.showInputBox({
            prompt: 'Enter remote target path',
            placeHolder: 'e.g. /home/user/'
        });
        if (!remotePath) return;

        const filePath = fileUris[0].fsPath;
        const fileName = path.basename(filePath);

        currentConnection.sftp((err, sftp) => {
            if (err) {
                vscode.window.showErrorMessage(`SFTP error: ${err.message}`);
                return;
            }

            sftp.fastPut(filePath, `${remotePath}/${fileName}`, (err) => {
                if (err) {
                    vscode.window.showErrorMessage(`Upload failed: ${err.message}`);
                } else {
                    vscode.window.showInformationMessage('File uploaded successfully');
                }
            });
        });
    });

    // 下载文件
    let downloadCommand = vscode.commands.registerCommand('vscode-extension-scp.download', async () => {
        if (!currentConnection) {
            vscode.window.showErrorMessage('Please connect to server first');
            return;
        }

        const remotePath = await vscode.window.showInputBox({
            prompt: 'Enter remote file path',
            placeHolder: 'e.g. /home/user/file.txt'
        });
        if (!remotePath) return;

        const localPath = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false
        });

        if (!localPath || localPath.length === 0) return;

        const fileName = path.basename(remotePath);
        const targetPath = path.join(localPath[0].fsPath, fileName);

        currentConnection.sftp((err, sftp) => {
            if (err) {
                vscode.window.showErrorMessage(`SFTP error: ${err.message}`);
                return;
            }

            sftp.fastGet(remotePath, targetPath, (err) => {
                if (err) {
                    vscode.window.showErrorMessage(`Download failed: ${err.message}`);
                } else {
                    vscode.window.showInformationMessage('File downloaded successfully');
                }
            });
        });
    });

    // 注册断开连接命令
    let disconnectCommand = vscode.commands.registerCommand('vscode-extension-scp.disconnected', () => {
        // 通知 WebView 连接已断开
        scpExplorerProvider.notifyDisconnected();
    });

    context.subscriptions.push(connectCommand, uploadCommand, downloadCommand, disconnectCommand);
}

export function deactivate() {
    if (currentConnection) {
        currentConnection.end();
        currentConnection = null;
    }
} 