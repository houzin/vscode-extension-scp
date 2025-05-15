import * as vscode from 'vscode';
import { Client } from 'ssh2';
import * as path from 'path';
import * as fs from 'fs';
import * as util from 'util';

export class ScpExplorerProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'scpExplorerView';
    private _view?: vscode.WebviewView;
    private _client: Client | null = null;
    private _currentPath: string = '/';

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) { }

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

        const styleContent = `
            body {
                padding: 10px;
                color: var(--vscode-foreground);
                font-family: var(--vscode-font-family);
            }
            .form-group {
                margin-bottom: 10px;
            }
            input {
                width: 100%;
                padding: 4px;
                margin: 2px 0;
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border);
            }
            button {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 4px 8px;
                cursor: pointer;
                margin: 5px 0;
            }
            button:hover {
                background: var(--vscode-button-hoverBackground);
            }
            .file-list {
                margin-top: 10px;
                border: 1px solid var(--vscode-input-border);
            }
            .file-item {
                padding: 4px;
                cursor: pointer;
                display: flex;
                align-items: center;
            }
            .file-item:hover {
                background: var(--vscode-list-hoverBackground);
            }
            .file-icon {
                margin-right: 5px;
            }
            #status {
                margin: 10px 0;
                padding: 5px;
            }
            .error {
                color: var(--vscode-errorForeground);
            }
            .toolbar {
                margin: 10px 0;
            }
            .dialog-overlay {
                display: none;
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.5);
                z-index: 1000;
            }
            .dialog {
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: var(--vscode-editor-background);
                padding: 15px;
                border: 1px solid var(--vscode-input-border);
                z-index: 1001;
            }
            .dialog-buttons {
                margin-top: 10px;
                text-align: right;
            }
            .dialog-buttons button {
                margin-left: 5px;
            }
            .path-navigator {
                margin: 10px 0;
                padding: 5px;
                background: var(--vscode-input-background);
                border: 1px solid var(--vscode-input-border);
                display: flex;
                align-items: center;
                overflow-x: auto;
                white-space: nowrap;
            }
            .path-part {
                display: inline-flex;
                align-items: center;
                cursor: pointer;
                padding: 2px 4px;
                border-radius: 3px;
            }
            .path-part:hover {
                background: var(--vscode-list-hoverBackground);
            }
            .path-separator {
                margin: 0 4px;
                color: var(--vscode-descriptionForeground);
            }
            .current-path {
                font-weight: bold;
                color: var(--vscode-editor-foreground);
            }
            .context-menu {
                position: fixed;
                background: var(--vscode-editor-background);
                border: 1px solid var(--vscode-input-border);
                padding: 5px 0;
                z-index: 1000;
                box-shadow: 0 2px 5px rgba(0, 0, 0, 0.2);
            }
            .context-menu-item {
                padding: 5px 15px;
                cursor: pointer;
            }
            .context-menu-item:hover {
                background: var(--vscode-list-hoverBackground);
            }
            .file-item.selected {
                background: var(--vscode-list-activeSelectionBackground);
                color: var(--vscode-list-activeSelectionForeground);
            }
            .file-item.multi-selected {
                background: var(--vscode-list-inactiveSelectionBackground);
                color: var(--vscode-list-inactiveSelectionForeground);
            }
            .confirm-dialog {
                background: var(--vscode-editor-background);
                padding: 15px;
                border: 1px solid var(--vscode-input-border);
                max-width: 400px;
                word-break: break-word;
            }
            .confirm-dialog-buttons {
                margin-top: 15px;
                text-align: right;
            }
            .confirm-dialog-buttons button {
                margin-left: 10px;
            }
            .split-view {
                display: flex;
                gap: 10px;
                margin-top: 10px;
            }
            .file-pane {
                flex: 1;
                display: flex;
                flex-direction: column;
                min-width: 0;
            }
            .pane-title {
                font-weight: bold;
                padding: 5px;
                background: var(--vscode-sideBar-background);
                border: 1px solid var(--vscode-input-border);
                margin-bottom: 5px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .file-list {
                flex: 1;
                overflow: auto;
                border: 1px solid var(--vscode-input-border);
                margin-top: 0;
            }
            .path-navigator {
                margin: 5px 0;
            }
            .transfer-buttons {
                display: flex;
                flex-direction: column;
                justify-content: center;
                gap: 5px;
                padding: 10px 0;
            }
            .transfer-buttons button {
                width: 30px;
                height: 30px;
                padding: 0;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .progress-overlay {
                display: none;
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.5);
                z-index: 2000;
                align-items: center;
                justify-content: center;
            }
            .progress-dialog {
                background: var(--vscode-editor-background);
                padding: 20px;
                border-radius: 5px;
                min-width: 300px;
            }
            .progress-bar {
                width: 100%;
                height: 20px;
                background: var(--vscode-input-background);
                border: 1px solid var(--vscode-input-border);
                border-radius: 10px;
                overflow: hidden;
                margin: 10px 0;
            }
            .progress-fill {
                height: 100%;
                width: 0;
                background: var(--vscode-progressBar-background);
                transition: width 0.3s ease;
            }
            .progress-text {
                text-align: center;
                margin: 5px 0;
            }
            .empty-message {
                padding: 20px;
                text-align: center;
                color: var(--vscode-descriptionForeground);
            }
        `;

        const progressHtml = `
            <div class="progress-overlay" id="progressOverlay">
                <div class="progress-dialog">
                    <div class="progress-text" id="progressText">正在傳輸...</div>
                    <div class="progress-bar">
                        <div class="progress-fill" id="progressFill"></div>
                    </div>
                    <div class="progress-text" id="progressPercentage">0%</div>
                </div>
            </div>
        `;

        const scriptContent = `
            const progressOverlay = document.getElementById('progressOverlay');
            const progressText = document.getElementById('progressText');
            const progressFill = document.getElementById('progressFill');
            const progressPercentage = document.getElementById('progressPercentage');
            
            let activeTransfers = new Map();

            // 上傳按鈕點擊事件
            document.getElementById('uploadBtn').addEventListener('click', () => {
                const selectedFiles = Array.from(localSelectedItems).map(item => {
                    const itemPath = document.querySelector('[data-name="' + item + '"]').dataset.path;
                    return itemPath;
                });

                if (selectedFiles.length === 0) {
                    vscode.postMessage({
                        type: 'error',
                        message: '請選擇要上傳的文件'
                    });
                    return;
                }

                vscode.postMessage({
                    type: 'upload',
                    localPaths: selectedFiles,
                    remotePath: remotePath
                });

                progressOverlay.style.display = 'flex';
                progressText.textContent = '正在上傳文件...';
            });

            // 下載按鈕點擊事件
            document.getElementById('downloadBtn').addEventListener('click', () => {
                const selectedFiles = Array.from(remoteSelectedItems).map(item => {
                    const itemPath = document.querySelector('[data-name="' + item + '"]').dataset.path;
                    return itemPath;
                });

                if (selectedFiles.length === 0) {
                    vscode.postMessage({
                        type: 'error',
                        message: '請選擇要下載的文件'
                    });
                    return;
                }

                vscode.postMessage({
                    type: 'download',
                    remotePaths: selectedFiles,
                    localPath: localPath
                });

                progressOverlay.style.display = 'flex';
                progressText.textContent = '正在下載文件...';
            });

            // 在消息處理器中添加進度相關的處理
            window.addEventListener('message', event => {
                const message = event.data;
                switch (message.type) {
                    case 'transferProgress':
                        const { fileName, progress, direction } = message;
                        activeTransfers.set(fileName, progress);
                        
                        // 計算總進度
                        const totalProgress = Array.from(activeTransfers.values())
                            .reduce((sum, value) => sum + value, 0) / activeTransfers.size;
                        
                        progressFill.style.width = totalProgress + '%';
                        progressPercentage.textContent = Math.round(totalProgress) + '%';
                        progressText.textContent = '正在' + (direction === 'upload' ? '上傳' : '下載') + ': ' + fileName;
                        break;

                    case 'transferComplete':
                        activeTransfers.clear();
                        progressOverlay.style.display = 'none';
                        refreshCurrentView();
                        break;
                }
            });
        `;

        webviewView.webview.html = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>SCP Explorer</title>
                <style>${styleContent}</style>
            </head>
            <body>
                <div class="connection-form">
                    <input type="text" id="host" placeholder="主機地址 (例如: example.com)" value="">
                    <input type="text" id="port" placeholder="端口 (默認: 22)" value="22">
                    <input type="text" id="username" placeholder="用戶名" value="">
                    <input type="password" id="password" placeholder="密碼" value="">
                    <button id="connectBtn">連接</button>
                </div>
                <div id="status"></div>

                <div class="split-view">
                    <!-- 本地文件面板 -->
                    <div class="file-pane">
                        <div class="pane-title">
                            本地文件
                            <div class="toolbar">
                                <button id="localNewFolderBtn" title="新建資料夾">📁+</button>
                                <button id="localRefreshBtn" title="刷新">🔄</button>
                                <button id="localDeleteBtn" title="刪除">🗑️</button>
                            </div>
                        </div>
                        <div id="localPathNavigator" class="path-navigator"></div>
                        <div id="localFileList" class="file-list"></div>
                    </div>

                    <!-- 傳輸按鈕 -->
                    <div class="transfer-buttons">
                        <button id="uploadBtn" title="上傳">➡️</button>
                        <button id="downloadBtn" title="下載">⬅️</button>
                    </div>

                    <!-- 遠程文件面板 -->
                    <div class="file-pane">
                        <div class="pane-title">
                            遠程文件
                            <div class="toolbar">
                                <button id="remoteNewFolderBtn" title="新建資料夾">📁+</button>
                                <button id="remoteRefreshBtn" title="刷新">🔄</button>
                                <button id="remoteDeleteBtn" title="刪除">🗑️</button>
                            </div>
                        </div>
                        <div id="remotePathNavigator" class="path-navigator"></div>
                        <div id="remoteFileList" class="file-list"></div>
                    </div>
                </div>

                <!-- 添加對話框 -->
                <div id="newFolderDialog" class="dialog-overlay">
                    <div class="dialog">
                        <div class="form-group">
                            <input type="text" id="newFolderName" placeholder="請輸入資料夾名稱">
                        </div>
                        <div class="dialog-buttons">
                            <button id="cancelNewFolder">取消</button>
                            <button id="confirmNewFolder">確定</button>
                        </div>
                    </div>
                </div>

                <!-- 添加右鍵菜單 -->
                <div id="contextMenu" class="context-menu" style="display: none">
                    <div class="context-menu-item" id="contextMenuDelete">刪除</div>
                </div>

                <!-- 添加確認對話框 -->
                <div id="confirmDialog" class="dialog-overlay" style="display: none">
                    <div class="confirm-dialog">
                        <div id="confirmMessage"></div>
                        <div class="confirm-dialog-buttons">
                            <button id="confirmCancel">取消</button>
                            <button id="confirmOk">確定</button>
                        </div>
                    </div>
                </div>

                ${progressHtml}

                <script>
                    (function() {
                        const vscode = acquireVsCodeApi();
                        let localPath = '/';
                        let remotePath = '/';
                        let localSelectedItems = new Set();
                        let remoteSelectedItems = new Set();
                        let lastLocalSelectedIndex = -1;
                        let lastRemoteSelectedIndex = -1;
                        const contextMenu = document.getElementById('contextMenu');
                        const confirmDialog = document.getElementById('confirmDialog');
                        
                        function log(message) {
                            vscode.postMessage({ type: 'log', message });
                        }
                        
                        function showStatus(message, isError = false) {
                            const status = document.getElementById('status');
                            status.textContent = message;
                            status.className = isError ? 'error' : '';
                            log(message);
                        }

                        // 獲取上級目錄路徑
                        function getParentPath(currentPath) {
                            if (currentPath === '/' || currentPath === '') {
                                return '/';
                            }
                            // 移除結尾的斜線
                            const path = currentPath.endsWith('/') ? currentPath.slice(0, -1) : currentPath;
                            const lastSlashIndex = path.lastIndexOf('/');
                            if (lastSlashIndex <= 0) {
                                return '/';
                            }
                            return path.slice(0, lastSlashIndex) || '/';
                        }
                        
                        // 連接按鈕點擊事件
                        document.getElementById('connectBtn').onclick = function() {
                            const host = document.getElementById('host').value;
                            const port = document.getElementById('port').value;
                            const username = document.getElementById('username').value;
                            const password = document.getElementById('password').value;
                            
                            if (!host || !username || !password) {
                                showStatus('請填寫所有必要信息', true);
                                return;
                            }
                            
                            showStatus('正在連接...');
                            vscode.postMessage({
                                type: 'connect',
                                data: { host, port, username, password }
                            });
                        };
                        
                        // 顯示新建資料夾對話框
                        function showNewFolderDialog(isLocal) {
                            const dialog = document.getElementById('newFolderDialog');
                            const input = document.getElementById('newFolderName');
                            dialog.style.display = 'block';
                            input.value = '';
                            input.focus();
                            
                            // 存储当前操作的类型（本地/远程）
                            dialog.setAttribute('data-is-local', isLocal.toString());
                        }

                        // 隱藏新建資料夾對話框
                        function hideNewFolderDialog() {
                            document.getElementById('newFolderDialog').style.display = 'none';
                        }

                        // 新建資料夾按鈕點擊事件
                        document.getElementById('localNewFolderBtn').onclick = () => {
                            showNewFolderDialog(true);
                        };
                        
                        document.getElementById('remoteNewFolderBtn').onclick = () => {
                            showNewFolderDialog(false);
                        };

                        // 確認新建資料夾
                        document.getElementById('confirmNewFolder').onclick = function() {
                            const dialog = document.getElementById('newFolderDialog');
                            const isLocal = dialog.getAttribute('data-is-local') === 'true';
                            const folderName = document.getElementById('newFolderName').value.trim();
                            const currentPath = isLocal ? localPath : remotePath;
                            
                            if (folderName) {
                                vscode.postMessage({
                                    type: 'createFolder',
                                    path: currentPath,
                                    folderName: folderName,
                                    isLocal: isLocal
                                });
                                hideNewFolderDialog();
                            } else {
                                showStatus('請輸入資料夾名稱', true);
                            }
                        };

                        // 取消新建資料夾
                        document.getElementById('cancelNewFolder').onclick = hideNewFolderDialog;

                        // 按 Enter 確認
                        document.getElementById('newFolderName').onkeyup = function(e) {
                            if (e.key === 'Enter') {
                                document.getElementById('confirmNewFolder').click();
                            } else if (e.key === 'Escape') {
                                hideNewFolderDialog();
                            }
                        };
                        
                        // 更新本地路徑導航欄
                        function updateLocalPathNavigator() {
                            const navigator = document.getElementById('localPathNavigator');
                            updatePathNavigator(navigator, localPath, (path) => {
                                localPath = path;
                                updateLocalFileList();
                            });
                        }

                        // 更新遠程路徑導航欄
                        function updateRemotePathNavigator() {
                            const navigator = document.getElementById('remotePathNavigator');
                            updatePathNavigator(navigator, remotePath, (path) => {
                                remotePath = path;
                                vscode.postMessage({
                                    type: 'listFiles',
                                    path: remotePath
                                });
                            });
                        }

                        // 通用路徑導航欄更新函數
                        function updatePathNavigator(navigator, currentPath, onClick) {
                            const parts = currentPath.split('/').filter(p => p);
                            let html = '<span class="path-part" data-path="/">/</span>';
                            let fullPath = '';
                            
                            parts.forEach((part, index) => {
                                fullPath += '/' + part;
                                html += '<span class="path-separator">/</span>';
                                html += '<span class="path-part' + 
                                    (index === parts.length - 1 ? ' current-path' : '') + 
                                    '" data-path="' + fullPath + '">' + 
                                    part + '</span>';
                            });
                            
                            navigator.innerHTML = html;
                            
                            const pathParts = navigator.getElementsByClassName('path-part');
                            for (let i = 0; i < pathParts.length; i++) {
                                const el = pathParts[i];
                                el.onclick = function() {
                                    const path = this.getAttribute('data-path');
                                    if (path) {
                                        onClick(path);
                                    }
                                };
                            }
                        }

                        // 更新本地文件列表
                        function updateLocalFileList() {
                            vscode.postMessage({
                                type: 'listLocalFiles',
                                path: localPath
                            });
                        }

                        // 顯示確認對話框
                        function showConfirmDialog(message, onConfirm) {
                            document.getElementById('confirmMessage').textContent = message;
                            confirmDialog.style.display = 'block';
                            
                            document.getElementById('confirmOk').onclick = () => {
                                confirmDialog.style.display = 'none';
                                onConfirm();
                            };
                            
                            document.getElementById('confirmCancel').onclick = () => {
                                confirmDialog.style.display = 'none';
                            };
                        }
                        
                        // 隱藏右鍵菜單
                        function hideContextMenu() {
                            contextMenu.style.display = 'none';
                        }
                        
                        // 顯示右鍵菜單
                        function showContextMenu(x, y) {
                            contextMenu.style.display = 'block';
                            contextMenu.style.left = x + 'px';
                            contextMenu.style.top = y + 'px';
                        }
                        
                        // 選擇項目
                        function selectItem(item, isMultiSelect, selectedItems, container) {
                            const index = Array.from(container.children).indexOf(item);
                            
                            if (!isMultiSelect) {
                                // 單選模式：清除所有選擇
                                selectedItems.clear();
                                container.querySelectorAll('.file-item').forEach(el => {
                                    el.classList.remove('selected', 'multi-selected');
                                });
                                selectedItems.add(item);
                                item.classList.add('selected');
                                lastSelectedIndex = index;
                            } else if (event.shiftKey && lastSelectedIndex !== -1) {
                                // Shift 多選：選擇範圍
                                const items = Array.from(container.children);
                                const start = Math.min(lastSelectedIndex, index);
                                const end = Math.max(lastSelectedIndex, index);
                                
                                items.forEach((el, i) => {
                                    if (i >= start && i <= end) {
                                        selectedItems.add(el);
                                        el.classList.add('multi-selected');
                                    }
                                });
                            } else {
                                // Ctrl 多選：切換選擇狀態
                                if (selectedItems.has(item)) {
                                    selectedItems.delete(item);
                                    item.classList.remove('multi-selected');
                                } else {
                                    selectedItems.add(item);
                                    item.classList.add('multi-selected');
                                }
                                lastSelectedIndex = index;
                            }
                        }

                        // 刪除選中的項目
                        function deleteSelectedItems(isLocal) {
                            const selectedSet = isLocal ? localSelectedItems : remoteSelectedItems;
                            const currentPath = isLocal ? localPath : remotePath;
                            
                            if (selectedSet.size === 0) {
                                showStatus('請先選擇要刪除的項目', true);
                                return;
                            }
                            
                            const items = Array.from(selectedSet).map(item => ({
                                name: item.getAttribute('data-name'),
                                isDirectory: item.getAttribute('data-is-directory') === 'true'
                            }));
                            
                            const message = items.length === 1
                                ? '確定要刪除' + (items[0].isDirectory ? '目錄' : '文件') + ' "' + items[0].name + '" 嗎？'
                                : '確定要刪除選中的 ' + items.length + ' 個項目嗎？';
                            
                            showConfirmDialog(message, () => {
                                items.forEach(item => {
                                    const itemPath = currentPath.endsWith('/')
                                        ? currentPath + item.name
                                        : currentPath + '/' + item.name;
                                    
                                    vscode.postMessage({
                                        type: 'delete',
                                        path: itemPath,
                                        isDirectory: item.isDirectory,
                                        isLocal: isLocal
                                    });
                                });
                            });
                        }

                        // 工具欄按鈕事件
                        document.getElementById('localDeleteBtn').onclick = () => deleteSelectedItems(true);
                        document.getElementById('remoteDeleteBtn').onclick = () => deleteSelectedItems(false);

                        // 修改右鍵菜單點擊處理
                        document.getElementById('contextMenuDelete').onclick = () => {
                            // 判断当前操作的是本地还是远程文件列表
                            const isLocal = document.activeElement?.closest('#localFileList') !== null;
                            deleteSelectedItems(isLocal);
                            hideContextMenu();
                        };

                        // 添加鍵盤快捷鍵
                        document.addEventListener('keydown', (e) => {
                            if (e.key === 'Delete') {
                                // 判断当前焦点在哪个文件列表
                                const isLocal = document.activeElement?.closest('#localFileList') !== null;
                                deleteSelectedItems(isLocal);
                            }
                        });
                        
                        // 點擊空白處取消選擇
                        document.addEventListener('click', (e) => {
                            if (!e.target.closest('.file-item') && !contextMenu.contains(e.target)) {
                                selectedItems.clear();
                                document.querySelectorAll('.file-item').forEach(el => {
                                    el.classList.remove('selected', 'multi-selected');
                                });
                            }
                            hideContextMenu();
                        });
                        
                        // 修改文件列表生成代碼
                        function updateFileList(files, container, selectedItems) {
                            container.innerHTML = '';
                            selectedItems.clear();
                            
                            if (files.length === 0) {
                                const emptyMessage = document.createElement('div');
                                emptyMessage.className = 'empty-message';
                                emptyMessage.textContent = '此資料夾為空';
                                container.appendChild(emptyMessage);
                                return;
                            }
                            
                            files.forEach(file => {
                                const item = document.createElement('div');
                                item.className = 'file-item';
                                const icon = file.isDirectory ? '📁' : '📄';
                                item.innerHTML = '<span class="file-icon">' + icon + '</span>' + file.name;
                                
                                item.setAttribute('data-name', file.name);
                                item.setAttribute('data-is-directory', file.isDirectory);
                                
                                // 左鍵點擊
                                item.onclick = (event) => {
                                    if (file.isDirectory && !event.ctrlKey && !event.shiftKey) {
                                        // 如果是目錄且不是多選模式，則進入目錄
                                        const newPath = container.id === 'localFileList' ? localPath : remotePath;
                                        const nextPath = newPath.endsWith('/')
                                            ? newPath + file.name
                                            : newPath + '/' + file.name;
                                            
                                        if (container.id === 'localFileList') {
                                            localPath = nextPath;
                                            updateLocalFileList();
                                        } else {
                                            remotePath = nextPath;
                                            vscode.postMessage({
                                                type: 'listFiles',
                                                path: nextPath
                                            });
                                        }
                                    } else {
                                        // 否則選擇項目
                                        selectItem(item, event.ctrlKey || event.shiftKey, selectedItems, container);
                                    }
                                };
                                
                                // 右鍵菜單
                                item.oncontextmenu = (e) => {
                                    e.preventDefault();
                                    if (!selectedItems.has(item)) {
                                        selectItem(item, false, selectedItems, container);
                                    }
                                    showContextMenu(e.pageX, e.pageY);
                                };
                                
                                container.appendChild(item);
                            });
                        }
                        
                        // 修改連接成功的處理
                        window.addEventListener('message', event => {
                            const message = event.data;
                            
                            switch (message.type) {
                                case 'connected':
                                    showStatus('已連接');
                                    updateLocalFileList();
                                    vscode.postMessage({
                                        type: 'listFiles',
                                        path: remotePath
                                    });
                                    break;
                                
                                case 'error':
                                    showStatus(message.message, true);
                                    break;
                                
                                case 'localFileList':
                                    updateLocalPathNavigator();
                                    updateFileList(message.files, document.getElementById('localFileList'), localSelectedItems);
                                    break;
                                    
                                case 'fileList':
                                    updateRemotePathNavigator();
                                    updateFileList(message.files, document.getElementById('remoteFileList'), remoteSelectedItems);
                                    break;
                                    
                                case 'folderCreated':
                                    showStatus('資料夾創建成功');
                                    // 重新加載當前目錄
                                    vscode.postMessage({
                                        type: 'listFiles',
                                        path: remotePath
                                    });
                                    break;
                                    
                                case 'deleted':
                                    showStatus('刪除成功');
                                    vscode.postMessage({
                                        type: 'listFiles',
                                        path: remotePath
                                    });
                                    break;
                                    
                                case 'transferProgress':
                                    const { fileName, progress, direction } = message;
                                    activeTransfers.set(fileName, progress);
                                    
                                    // 計算總進度
                                    const totalProgress = Array.from(activeTransfers.values())
                                        .reduce((sum, value) => sum + value, 0) / activeTransfers.size;
                                    
                                    progressFill.style.width = totalProgress + '%';
                                    progressPercentage.textContent = Math.round(totalProgress) + '%';
                                    progressText.textContent = '正在' + (direction === 'upload' ? '上傳' : '下載') + ': ' + fileName;
                                    break;
                                    
                                case 'transferComplete':
                                    activeTransfers.clear();
                                    progressOverlay.style.display = 'none';
                                    refreshCurrentView();
                                    break;
                            }
                        });
                        
                        // 初始化完成
                        log('WebView 已初始化');
                    })();
                </script>
            </body>
            </html>
        `;

        // 監聽 WebView 消息
        webviewView.webview.onDidReceiveMessage(async message => {
            console.log('收到 WebView 消息:', message);
            try {
                switch (message.type) {
                    case 'log':
                        console.log('[WebView]', message.message);
                        break;
                        
                    case 'connect':
                        console.log('處理連接請求');
                        await this.connect(message.data);
                        break;
                        
                    case 'listFiles':
                        console.log('處理列表請求:', message.path);
                        await this.listFiles(message.path);
                        break;
                    case 'createFolder':
                        console.log('處理創建資料夾請求:', message.path, message.folderName);
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
                                message: '文件上傳成功'
                            });
                        } catch (error) {
                            console.error('上傳文件時發生錯誤:', error);
                            webviewView.webview.postMessage({
                                type: 'error',
                                message: error instanceof Error ? error.message : '上傳文件失敗'
                            });
                        }
                        break;
                    case 'download':
                        try {
                            await this.downloadFiles(message.remotePaths, message.localPath);
                            webviewView.webview.postMessage({
                                type: 'success',
                                message: '文件下載成功'
                            });
                        } catch (error) {
                            console.error('下載文件時發生錯誤:', error);
                            webviewView.webview.postMessage({
                                type: 'error',
                                message: error instanceof Error ? error.message : '下載文件失敗'
                            });
                        }
                        break;
                }
            } catch (error) {
                console.error('處理消息時發生錯誤:', error);
                webviewView.webview.postMessage({
                    type: 'error',
                    message: error instanceof Error ? error.message : '發生未知錯誤'
                });
            }
        });
    }

    private async connect(data: { host: string, port: string, username: string, password: string }) {
        // 如果已經有連接，先關閉
        if (this._client) {
            this._client.end();
            this._client = null;
        }

        return new Promise((resolve, reject) => {
            const client = new Client();
            
            client.on('ready', () => {
                this._client = client;
                this._view?.webview.postMessage({ type: 'connected' });
                resolve(true);
            });

            client.on('error', (err) => {
                console.error('SSH 連接錯誤:', err);
                reject(err);
            });

            client.connect({
                host: data.host,
                port: parseInt(data.port) || 22,
                username: data.username,
                password: data.password,
                readyTimeout: 20000
            });
        });
    }

    private async listFiles(remotePath: string) {
        if (!this._client) {
            throw new Error('未連接到服務器');
        }

        return new Promise((resolve, reject) => {
            this._client!.sftp((err, sftp) => {
                if (err) {
                    reject(err);
                    return;
                }

                sftp.readdir(remotePath, (err, list) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    const files = list.map(item => ({
                        name: item.filename,
                        isDirectory: item.attrs.isDirectory(),
                        size: item.attrs.size,
                        modifyTime: item.attrs.mtime * 1000
                    }));

                    console.log('遠程文件列表:', files); // 添加调试日志

                    this._view?.webview.postMessage({
                        type: 'fileList',
                        files: files
                    });
                    resolve(true);
                });
            });
        });
    }

    private async createFolder(parentPath: string, folderName: string, isLocal: boolean) {
        if (isLocal) {
            const fullPath = path.join(parentPath, folderName);
            await util.promisify(fs.mkdir)(fullPath);
            this._view?.webview.postMessage({
                type: 'folderCreated',
                isLocal: true
            });
        } else {
            if (!this._client) {
                throw new Error('未連接到服務器');
            }

            return new Promise((resolve, reject) => {
                this._client!.sftp((err, sftp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    const fullPath = parentPath === '/' 
                        ? '/' + folderName 
                        : parentPath + '/' + folderName;
                    
                    sftp.mkdir(fullPath, (err) => {
                        if (err) {
                            reject(err);
                            return;
                        }

                        this._view?.webview.postMessage({
                            type: 'folderCreated',
                            isLocal: false
                        });
                        resolve(true);
                    });
                });
            });
        }
    }

    private async deleteItem(path: string, isDirectory: boolean, isLocal: boolean) {
        if (isLocal) {
            const deleteFunc = isDirectory ? fs.rmdir : fs.unlink;
            await util.promisify(deleteFunc)(path);
            this._view?.webview.postMessage({
                type: 'deleted',
                isLocal: true
            });
        } else {
            if (!this._client) {
                throw new Error('未連接到服務器');
            }

            return new Promise((resolve, reject) => {
                this._client!.sftp((err, sftp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    const deleteFunc = isDirectory ? sftp.rmdir.bind(sftp) : sftp.unlink.bind(sftp);
                    deleteFunc(path, (err) => {
                        if (err) {
                            reject(err);
                            return;
                        }

                        this._view?.webview.postMessage({
                            type: 'deleted',
                            isLocal: false
                        });
                        resolve(true);
                    });
                });
            });
        }
    }

    private async listLocalFiles(localPath: string) {
        try {
            const readdir = util.promisify(fs.readdir);
            const stat = util.promisify(fs.stat);
            
            // 验证和规范化路径
            if (localPath === '/') {
                // 在 Windows 上，使用当前驱动器根目录
                localPath = process.cwd().split(path.sep)[0] + '\\';
            }

            // Windows 系统文件和目录列表
            const systemFiles = new Set([
                'hiberfil.sys',
                'pagefile.sys',
                'swapfile.sys',
                'Recovery',
                'System Volume Information',
                'DumpStack.log'
            ]);
            
            const files = await readdir(localPath);
            const fileStats = await Promise.all(
                files
                    .filter(name => !systemFiles.has(name)) // 过滤掉系统文件
                    .map(async (name) => {
                        try {
                            const fullPath = path.join(localPath, name);
                            const stats = await stat(fullPath);
                            return {
                                name: name, // 修改为与远程文件列表相同的属性名
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

            // 过滤掉无法访问的文件
            const validFiles = fileStats.filter(file => file !== null);

            console.log('本地文件列表:', validFiles); // 添加调试日志

            this._view?.webview.postMessage({
                type: 'localFileList',
                files: validFiles
            });
        } catch (error) {
            console.error('讀取本地目錄失敗:', error);
            this._view?.webview.postMessage({
                type: 'error',
                message: error instanceof Error ? error.message : '讀取本地目錄失敗'
            });
        }
    }

    private async uploadFiles(localPaths: string[], remotePath: string) {
        if (!this._client) {
            throw new Error('未連接到服務器');
        }

        return new Promise((resolve, reject) => {
            this._client!.sftp((err, sftp) => {
                if (err) {
                    reject(err);
                    return;
                }

                let completedTransfers = 0;
                const totalTransfers = localPaths.length;
                
                for (const localPath of localPaths) {
                    const fileName = path.basename(localPath);
                    const remoteFilePath = path.join(remotePath, fileName).replace(/\\/g, '/');
                    
                    // 獲取文件大小
                    const stats = fs.statSync(localPath);
                    let transferred = 0;

                    const stream = sftp.createWriteStream(remoteFilePath);
                    const fileStream = fs.createReadStream(localPath);

                    stream.on('close', () => {
                        completedTransfers++;
                        if (completedTransfers === totalTransfers) {
                            this._view?.webview.postMessage({
                                type: 'transferComplete',
                                direction: 'upload'
                            });
                            resolve(true);
                        }
                    });

                    fileStream.on('data', (chunk: Buffer) => {
                        transferred += chunk.length;
                        const progress = (transferred / stats.size) * 100;
                        this._view?.webview.postMessage({
                            type: 'transferProgress',
                            fileName: fileName,
                            progress: progress,
                            direction: 'upload'
                        });
                    });

                    fileStream.pipe(stream);
                }
            });
        });
    }

    private async downloadFiles(remotePaths: string[], localPath: string) {
        if (!this._client) {
            throw new Error('未連接到服務器');
        }

        return new Promise((resolve, reject) => {
            this._client!.sftp((err, sftp) => {
                if (err) {
                    reject(err);
                    return;
                }

                let completedTransfers = 0;
                const totalTransfers = remotePaths.length;

                for (const remotePath of remotePaths) {
                    const fileName = path.basename(remotePath);
                    const localFilePath = path.join(localPath, fileName);

                    sftp.stat(remotePath, (err, stats) => {
                        if (err) {
                            reject(err);
                            return;
                        }

                        let transferred = 0;
                        const stream = fs.createWriteStream(localFilePath);
                        const fileStream = sftp.createReadStream(remotePath);

                        stream.on('close', () => {
                            completedTransfers++;
                            if (completedTransfers === totalTransfers) {
                                this._view?.webview.postMessage({
                                    type: 'transferComplete',
                                    direction: 'download'
                                });
                                resolve(true);
                            }
                        });

                        fileStream.on('data', (chunk: Buffer) => {
                            transferred += chunk.length;
                            const progress = (transferred / stats.size) * 100;
                            this._view?.webview.postMessage({
                                type: 'transferProgress',
                                fileName: fileName,
                                progress: progress,
                                direction: 'download'
                            });
                        });

                        fileStream.pipe(stream);
                    });
                }
            });
        });
    }
} 