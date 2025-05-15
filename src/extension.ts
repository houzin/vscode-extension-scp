import * as vscode from 'vscode';
import { Client } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import { ScpExplorerProvider } from './ScpExplorerProvider';

let currentConnection: Client | null = null;

export function activate(context: vscode.ExtensionContext) {
    const scpExplorerProvider = new ScpExplorerProvider(context.extensionUri);
    
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ScpExplorerProvider.viewType, scpExplorerProvider)
    );

    // 註冊打開文件瀏覽器的命令
    let openExplorerCommand = vscode.commands.registerCommand('vscode-extension-scp.openExplorer', () => {
        vscode.commands.executeCommand('scp-explorer.focus');
    });

    context.subscriptions.push(openExplorerCommand);

    // 连接到服务器
    let connectCommand = vscode.commands.registerCommand('vscode-extension-scp.connect', async () => {
        const host = await vscode.window.showInputBox({
            prompt: '输入服务器地址',
            placeHolder: '例如: example.com'
        });
        if (!host) return;

        const username = await vscode.window.showInputBox({
            prompt: '输入用户名',
            placeHolder: '例如: root'
        });
        if (!username) return;

        const password = await vscode.window.showInputBox({
            prompt: '输入密码',
            password: true
        });
        if (!password) return;

        const client = new Client();
        
        client.on('ready', () => {
            currentConnection = client;
            vscode.window.showInformationMessage(`成功连接到 ${host}`);
        });

        client.on('error', (err) => {
            vscode.window.showErrorMessage(`连接错误: ${err.message}`);
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
            vscode.window.showErrorMessage('请先连接到服务器');
            return;
        }

        const fileUris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false
        });

        if (!fileUris || fileUris.length === 0) return;

        const remotePath = await vscode.window.showInputBox({
            prompt: '输入远程目标路径',
            placeHolder: '例如: /home/user/'
        });
        if (!remotePath) return;

        const filePath = fileUris[0].fsPath;
        const fileName = path.basename(filePath);

        currentConnection.sftp((err, sftp) => {
            if (err) {
                vscode.window.showErrorMessage(`SFTP错误: ${err.message}`);
                return;
            }

            sftp.fastPut(filePath, `${remotePath}/${fileName}`, (err) => {
                if (err) {
                    vscode.window.showErrorMessage(`上传失败: ${err.message}`);
                } else {
                    vscode.window.showInformationMessage('文件上传成功');
                }
            });
        });
    });

    // 下载文件
    let downloadCommand = vscode.commands.registerCommand('vscode-extension-scp.download', async () => {
        if (!currentConnection) {
            vscode.window.showErrorMessage('请先连接到服务器');
            return;
        }

        const remotePath = await vscode.window.showInputBox({
            prompt: '输入远程文件路径',
            placeHolder: '例如: /home/user/file.txt'
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
                vscode.window.showErrorMessage(`SFTP错误: ${err.message}`);
                return;
            }

            sftp.fastGet(remotePath, targetPath, (err) => {
                if (err) {
                    vscode.window.showErrorMessage(`下载失败: ${err.message}`);
                } else {
                    vscode.window.showInformationMessage('文件下载成功');
                }
            });
        });
    });

    context.subscriptions.push(connectCommand, uploadCommand, downloadCommand);
}

export function deactivate() {
    if (currentConnection) {
        currentConnection.end();
        currentConnection = null;
    }
} 