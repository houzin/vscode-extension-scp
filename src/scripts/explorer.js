(function() {
    const vscode = acquireVsCodeApi();
    let localPath = '/';
    let remotePath = '/';
    let localSelectedItems = new Set();
    let remoteSelectedItems = new Set();
    let lastLocalSelectedIndex = -1;
    let lastRemoteSelectedIndex = -1;
    let pendingPrepareUploadPath = null; // 新增暫存變數

    // Path utilities
    const path = {
        basename: function(filepath) {
            return filepath.split(/[\\/]/).pop();
        },
        dirname: function(filepath) {
            // 先將所有反斜線替換為斜線
            let unixPath = filepath.replace(/\\/g, '/');
            // 取得目錄部分
            let dir = unixPath.substring(0, unixPath.lastIndexOf('/'));
            // 如果是 Windows 路徑（如 d:/xxx），確保以 / 開頭
            if (/^[a-zA-Z]:/.test(dir)) {
                dir = '/' + dir;
            }
            // 保證最後有 /
            if (!dir.endsWith('/')) {
                dir += '/';
            }
            return dir;
        }
    };

    const contextMenu = document.getElementById('contextMenu');
    const confirmDialog = document.getElementById('confirmDialog');
    const progressOverlay = document.getElementById('progressOverlay');
    const progressText = document.getElementById('progressText');
    const progressFill = document.getElementById('progressFill');
    const progressPercentage = document.getElementById('progressPercentage');
    const cancelTransferBtn = document.getElementById('cancelTransferBtn');
    
    let activeTransfers = new Map();
    let heartbeatTimer = null;
    let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'error'
    let enableHeartbeat = false; // Enable/disable heartbeat
    let currentConnection = null;
    const connectionForm = document.querySelector('.connection-form');
    const savedConnectionsList = document.getElementById('savedConnections');

    function log(message) {
        vscode.postMessage({ type: 'log', message });
    }
    
    function showToast(message, isError = false, isWarning = false) {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.className = 'toast' + (isError ? ' error' : isWarning ? ' warning' : '');
        if (!document.querySelector('style#toast-styles')) {
            const style = document.createElement('style');
            style.id = 'toast-styles';
            style.textContent = `
                .toast.warning {
                    background-color: #fff3cd;
                    color: #856404;
                    border-color: #ffeeba;
                }
            `;
            document.head.appendChild(style);
        }
        toast.style.display = 'block';
        setTimeout(() => {
            toast.style.display = 'none';
        }, 2500);
    }

    function showStatus(message, isError = false, isWarning = false) {
        showToast(message, isError, isWarning);
        log(message);
    }

    function setStatus(text, statusType) {
        const status = document.getElementById('status');
        const dot = status.querySelector('.status-dot');
        status.className = '';
        dot.className = 'status-dot ' + (statusType || 'disconnected');
        status.textContent = '';
        status.appendChild(dot);
        status.append('' + text);
        if (statusType === 'error') status.className = 'error';
    }

    function updateConnectBtn() {
        const btn = document.getElementById('connectBtn');
        btn.classList.remove('status-connected', 'status-connecting', 'status-disconnected', 'status-error');
        btn.disabled = false;

        switch (connectionStatus) {
            case 'connected':
                btn.textContent = '🟢 Disconnect';
                btn.classList.add('status-connected');
                break;
            case 'connecting':
                btn.textContent = '🟡 Connecting...';
                btn.classList.add('status-connecting');
                btn.disabled = true;
                break;
            case 'error':
                btn.textContent = '🔴 Connection Failed';
                btn.classList.add('status-error');
                break;
            default:
                btn.textContent = '🔴 Connect';
                btn.classList.add('status-disconnected');
        }
    }

    function setStatusBtn(status) {
        connectionStatus = status;
        updateConnectBtn();
    }

    // Get parent directory path
    function getParentPath(currentPath) {
        if (currentPath === '/' || currentPath === '') {
            return '/';
        }
        const path = currentPath.endsWith('/') ? currentPath.slice(0, -1) : currentPath;
        const lastSlashIndex = path.lastIndexOf('/');
        if (lastSlashIndex <= 0) {
            return '/';
        }
        return path.slice(0, lastSlashIndex) || '/';
    }
    
    // Connect button click event
    document.getElementById('connectBtn').onclick = function() {
        if (connectionStatus === 'connected') {
            // Disconnect
            stopHeartbeat();
            handleDisconnect();
            vscode.postMessage({ type: 'disconnect' });
            // Clear remote file list
            return;
        }
        // 只要不是 connected，點擊都能嘗試連線
        const host = document.getElementById('host').value;
        const port = document.getElementById('port').value;
        const username = document.getElementById('username').value;
        const useKeyAuth = document.getElementById('useKeyAuth').checked;
        
        let authData;
        if (useKeyAuth) {
            const privateKeyPath = document.getElementById('privateKeyPath').value;
            const keyPassphrase = document.getElementById('keyPassphrase').value;
            if (!privateKeyPath) {
                showToast('Please select a private key file', true);
                return;
            }
            authData = {
                type: 'key',
                privateKeyPath,
                passphrase: keyPassphrase
            };
        } else {
            const password = document.getElementById('password').value;
            if (!password) {
                showToast('Please enter password', true);
                return;
            }
            authData = {
                type: 'password',
                password
            };
        }

        if (!host || !username) {
            showToast('Please fill in the required connection information', true);
            return;
        }

        setStatusBtn('connecting');
        vscode.postMessage({
            type: 'connect',
            data: { 
                host, 
                port, 
                username,
                ...authData
            }
        });
    };

    // 添加认证方式切换事件
    document.getElementById('useKeyAuth').onchange = function() {
        const passwordAuth = document.getElementById('passwordAuth');
        const keyAuth = document.getElementById('keyAuth');
        if (this.checked) {
            passwordAuth.style.display = 'none';
            keyAuth.style.display = 'block';
        } else {
            passwordAuth.style.display = 'block';
            keyAuth.style.display = 'none';
        }
    };

    // 添加浏览私钥文件按钮事件
    document.getElementById('browseKeyBtn').onclick = function() {
        vscode.postMessage({
            type: 'browsePrivateKey'
        });
    };

    // 顯示新建資料夾對話框
    function showNewFolderDialog(isLocal) {
        const dialog = document.getElementById('newFolderDialog');
        const input = document.getElementById('newFolderName');
        dialog.style.display = 'block';
        input.value = '';
        input.focus();
        dialog.setAttribute('data-is-local', isLocal.toString());
    }

    // 隱藏新建資料夾對話框
    function hideNewFolderDialog() {
        document.getElementById('newFolderDialog').style.display = 'none';
    }

    // 新建資料夾按鈕點擊事件
    document.getElementById('localNewFolderBtn').onclick = () => showNewFolderDialog(true);
    document.getElementById('remoteNewFolderBtn').onclick = () => showNewFolderDialog(false);

    // 確認新建資料夾
    document.getElementById('confirmNewFolder').onclick = function() {
        const dialog = document.getElementById('newFolderDialog');
        const isLocal = dialog.getAttribute('data-is-local') === 'true';
        const folderName = document.getElementById('newFolderName').value.trim();
        const currentPath = isLocal ? localPath : remotePath;
        
        if (folderName) {
            if (!isLocal) {
                // 顯示進度條
                progressOverlay.style.display = 'flex';
                progressText.textContent = 'Creating remote folder...';
                progressFill.style.width = '0%';
                progressPercentage.textContent = '0%';
            }
            
            vscode.postMessage({
                type: 'createFolder',
                path: currentPath,
                folderName: folderName,
                isLocal: isLocal
            });
            hideNewFolderDialog();
        } else {
            showStatus('Please enter a folder name', true);
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

    // 更新路徑導航欄
    function updatePathNavigator(navigator, currentPath, onClick) {
        const parts = currentPath.split('/').filter(p => p);
        let html = '';
        let fullPath = '';
        html = '<span class="path-part' + (parts.length === 0 ? ' current-path' : '') + '" data-path="/">/</span>';
        parts.forEach((part, index) => {
            fullPath += '/' + part;
            // 只有第二層（index > 0）才加分隔符號
            if (index > 0) {
                html += '<span class="path-separator">/</span>';
            }
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

    // 更新本地文件列表
    function updateLocalFileList() {
        console.log('Refreshing local file list');
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
        const scrollX = window.scrollX || window.pageXOffset;
        const scrollY = window.scrollY || window.pageYOffset;
        
        // 获取视窗大小
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        // 获取菜单大小
        const menuWidth = contextMenu.offsetWidth;
        const menuHeight = contextMenu.offsetHeight;
        
        // 计算菜单位置，确保不会超出视窗
        let menuX = x - scrollX;
        let menuY = y - scrollY;
        
        // 如果菜单会超出右边界，向左偏移
        if (menuX + menuWidth > viewportWidth) {
            menuX = viewportWidth - menuWidth;
        }
        
        // 如果菜单会超出下边界，向上偏移
        if (menuY + menuHeight > viewportHeight) {
            menuY = viewportHeight - menuHeight;
        }
        
        contextMenu.style.display = 'block';
        contextMenu.style.left = menuX + 'px';
        contextMenu.style.top = menuY + 'px';
    }

    // 選擇項目
    function selectItem(item, isMultiSelect, selectedItems, container) {
        const index = Array.from(container.children).indexOf(item);
        
        if (!isMultiSelect) {
            selectedItems.clear();
            container.querySelectorAll('.file-item').forEach(el => {
                el.classList.remove('selected', 'multi-selected');
            });
            selectedItems.add(item);
            item.classList.add('selected');
            lastSelectedIndex = index;
        } else if (event.shiftKey && lastSelectedIndex !== -1) {
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
            showStatus('Please select items to delete', true);
            return;
        }
        
        const items = Array.from(selectedSet).map(item => ({
            name: item.getAttribute('data-name'),
            isDirectory: item.getAttribute('data-is-directory') === 'true'
        }));
        
        const message = items.length === 1
            ? 'Are you sure you want to delete ' + (items[0].isDirectory ? 'the folder' : 'the file') + ' "' + items[0].name + '"?'
            : 'Are you sure you want to delete the selected ' + items.length + ' items?';
        
        showConfirmDialog(message, () => {
            // Show progress overlay
            progressOverlay.style.display = 'flex';
            progressText.textContent = 'Preparing to delete...';
            progressFill.style.width = '0%';
            progressPercentage.textContent = '0%';

            // Reset delete completion counter
            window.deleteCompletedCount = 0;
            window.totalDeleteItems = items.length;

            items.forEach((item, index) => {
                const itemPath = currentPath.endsWith('/')
                    ? currentPath + item.name
                    : currentPath + '/' + item.name;
                
                vscode.postMessage({
                    type: 'delete',
                    path: itemPath,
                    isDirectory: item.isDirectory,
                    isLocal: isLocal,
                    totalItems: items.length,
                    currentIndex: index,
                    currentItem: item.name
                });
            });
        });
    }

    // 工具欄按鈕事件
    document.getElementById('localDeleteBtn').onclick = () => deleteSelectedItems(true);
    document.getElementById('remoteDeleteBtn').onclick = () => deleteSelectedItems(false);
    
    // 添加刷新按鈕事件
    document.getElementById('localRefreshBtn').onclick = () => {
        console.log('刷新本地文件列表');
        updateLocalFileList();
    };
    
    document.getElementById('remoteRefreshBtn').onclick = () => {
        console.log('Refreshing remote file list');
        vscode.postMessage({
            type: 'listFiles',
            path: remotePath
        });
    };

    // 右鍵菜單點擊處理
    document.getElementById('contextMenuDelete').onclick = () => {
        // 判斷當前操作的是本地還是遠程文件列表
        const isLocal = document.activeElement?.closest('#localFileList') !== null || 
                       document.querySelector('#localFileList .file-item.selected') !== null;
        deleteSelectedItems(isLocal);
        hideContextMenu();
    };

    // 上傳按鈕點擊事件
    document.getElementById('uploadBtn').addEventListener('click', () => {
        console.log('上傳按鈕點擊');
        const selectedFiles = Array.from(localSelectedItems).map(item => {
            const fileName = item.getAttribute('data-name');
            // 如果路径以驱动器号开头（如 C:），则使用 Windows 路径格式
            if (localPath.match(/^[A-Za-z]:/)) {
                // 确保移除开头的斜杠，并使用正确的路径分隔符
                const cleanPath = localPath.replace(/^\/+/, '').replace(/\//g, '\\');
                return cleanPath + (cleanPath.endsWith('\\') ? '' : '\\') + fileName;
            } else {
                // 其他情况使用 Unix 路径格式
                return localPath.endsWith('/') ? localPath + fileName : localPath + '/' + fileName;
            }
        });

        if (selectedFiles.length === 0) {
            vscode.postMessage({
                type: 'error',
                message: 'Please select files to upload'
            });
            return;
        }

        console.log('Selected files for upload:', selectedFiles); // 添加日志

        // 顯示進度條
        progressOverlay.style.display = 'flex';
        progressText.textContent = 'Preparing to upload...';
        progressFill.style.width = '0%';
        progressPercentage.textContent = '0%';

        vscode.postMessage({
            type: 'upload',
            localPaths: selectedFiles,
            remotePath: remotePath,
            totalFiles: selectedFiles.length
        });
    });

    // 下載按鈕點擊事件
    document.getElementById('downloadBtn').addEventListener('click', () => {
        console.log('下載按鈕點擊');
        const selectedFiles = Array.from(remoteSelectedItems).map(item => {
            const fileName = item.getAttribute('data-name');
            // 使用字符串操作來處理路徑
            return remotePath.endsWith('/') ? remotePath + fileName : remotePath + '/' + fileName;
        });

        if (selectedFiles.length === 0) {
            vscode.postMessage({
                type: 'error',
                message: 'Please select files to download'
            });
            return;
        }

        vscode.postMessage({
            type: 'download',
            remotePaths: selectedFiles,
            localPath: localPath
        });

        progressOverlay.style.display = 'flex';
        progressText.textContent = 'Downloading files...';
    });

    // 更新文件列表
    function updateFileList(files, container, selectedItems) {
        container.innerHTML = '';
        
        // 加入 .. 回上層目錄
        const isLocal = container.id === 'localFileList';
        const currentPath = isLocal ? localPath : remotePath;
        if (currentPath !== '/') {
            const upItem = document.createElement('div');
            upItem.className = 'file-item';
            upItem.innerHTML = '<span class="file-icon">⬆️</span>..';
            upItem.onclick = () => {
                if (isLocal) {
                    localPath = getParentPath(localPath);
                    updateLocalFileList();
                } else {
                    remotePath = getParentPath(remotePath);
                    vscode.postMessage({
                        type: 'listFiles',
                        path: remotePath
                    });
                }
            };
            container.appendChild(upItem);
        }

        if (files.length === 0) {
            const emptyMessage = document.createElement('div');
            emptyMessage.className = 'empty-message';
            emptyMessage.textContent = 'This folder is empty';
            container.appendChild(emptyMessage);
            return;
        }
        
        files.forEach(file => {
            const item = document.createElement('div');
            item.className = 'file-item';
            const icon = file.isDirectory ? '📁' : '📄';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'file-checkbox';
            
            item.innerHTML = '<span class="file-icon">' + icon + '</span>' + file.name;
            item.insertBefore(checkbox, item.firstChild);
            
            item.setAttribute('data-name', file.name);
            item.setAttribute('data-is-directory', file.isDirectory);

            // 根據 selectedItems 決定 checkbox 狀態
            checkbox.checked = selectedItems.has(item);

            // 點擊checkbox：只切換該行選取，不影響其他
            checkbox.onclick = (e) => {
                e.stopPropagation();
                if (selectedItems.has(item)) {
                    selectedItems.delete(item);
                    item.classList.remove('selected', 'multi-selected');
                    checkbox.checked = false;
                } else {
                    selectedItems.add(item);
                    item.classList.add('multi-selected');
                    checkbox.checked = true;
                }
            };

            // 點擊行：單選/多選（ctrl/shift），並同步checkbox
            item.onclick = (event) => {
                if (file.isDirectory && !event.ctrlKey && !event.shiftKey && event.target !== checkbox) {
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
                    selectItem(item, event.ctrlKey || event.shiftKey, selectedItems, container);
                    // 重新同步所有checkbox狀態
                    container.querySelectorAll('.file-item').forEach(el => {
                        const cb = el.querySelector('.file-checkbox');
                        if (cb) cb.checked = selectedItems.has(el);
                    });
                }
            };

            item.oncontextmenu = (e) => {
                e.preventDefault();
                if (!selectedItems.has(item)) {
                    selectItem(item, false, selectedItems, container);
                    checkbox.checked = true;
                }
                showContextMenu(e.pageX, e.pageY);
            };

            container.appendChild(item);
        });
    }

    // 添加鍵盤快捷鍵
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Delete') {
            const isLocal = document.activeElement?.closest('#localFileList') !== null;
            deleteSelectedItems(isLocal);
        }
    });

    // 點擊空白處取消選擇
    document.addEventListener('click', (e) => {
        // 排除刪除按鈕和確認對話框的點擊
        if (!e.target.closest('.file-item') && 
            !contextMenu.contains(e.target) && 
            !e.target.closest('#localDeleteBtn') && 
            !e.target.closest('#remoteDeleteBtn') &&
            !e.target.closest('#confirmDialog')) {
            localSelectedItems.clear();
            remoteSelectedItems.clear();
            document.querySelectorAll('.file-item').forEach(el => {
                el.classList.remove('selected', 'multi-selected');
                // 將 checkbox 的 checked 屬性設為 false
                const checkbox = el.querySelector('.file-checkbox');
                if (checkbox) {
                    checkbox.checked = false;
                }
            });
        }
        hideContextMenu();
    });

    // 顯示重命名對話框
    function showRenameDialog(isLocal) {
        const dialog = document.getElementById('renameDialog');
        const input = document.getElementById('newFileName');
        const selectedSet = isLocal ? localSelectedItems : remoteSelectedItems;
        
        if (selectedSet.size !== 1) {
            showStatus('Please select one item to rename', true);
            return;
        }

        const selectedItem = Array.from(selectedSet)[0];
        const oldName = selectedItem.getAttribute('data-name');
        
        dialog.style.display = 'block';
        input.value = oldName;
        input.focus();
        input.select();
        
        // 存儲當前操作的信息
        dialog.setAttribute('data-is-local', isLocal.toString());
        dialog.setAttribute('data-old-name', oldName);
    }

    // 隱藏重命名對話框
    function hideRenameDialog() {
        document.getElementById('renameDialog').style.display = 'none';
    }

    // 重命名按鈕點擊事件
    document.getElementById('contextMenuRename').onclick = () => {
        const isLocal = document.activeElement?.closest('#localFileList') !== null || 
                       document.querySelector('#localFileList .file-item.selected') !== null;
        showRenameDialog(isLocal);
        hideContextMenu();
    };

    // 確認重命名
    document.getElementById('confirmRename').onclick = function() {
        const dialog = document.getElementById('renameDialog');
        const isLocal = dialog.getAttribute('data-is-local') === 'true';
        const oldName = dialog.getAttribute('data-old-name');
        const newName = document.getElementById('newFileName').value.trim();
        const currentPath = isLocal ? localPath : remotePath;
        
        if (!newName) {
            showStatus('Please enter a new file name', true);
            return;
        }
        
        if (newName === oldName) {
            hideRenameDialog();
            return;
        }

        const oldPath = currentPath.endsWith('/') 
            ? currentPath + oldName 
            : currentPath + '/' + oldName;
        
        const newPath = currentPath.endsWith('/') 
            ? currentPath + newName 
            : currentPath + '/' + newName;

        vscode.postMessage({
            type: 'rename',
            oldPath: oldPath,
            newPath: newPath,
            isLocal: isLocal
        });

        hideRenameDialog();
    };

    // 取消重命名
    document.getElementById('cancelRename').onclick = hideRenameDialog;

    // 按 Enter 確認重命名
    document.getElementById('newFileName').onkeyup = function(e) {
        if (e.key === 'Enter') {
            document.getElementById('confirmRename').click();
        } else if (e.key === 'Escape') {
            hideRenameDialog();
        }
    };

    function startHeartbeat() {
        // 只在连接成功且启用心跳时启动
        console.log('Starting heartbeat, status:', connectionStatus, 'enabled:', enableHeartbeat);
        if (connectionStatus === 'connected' && enableHeartbeat) {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            heartbeatTimer = setInterval(() => {
                console.log('Sending heartbeat request');
                vscode.postMessage({ type: 'heartbeat' });
            }, 10000); // 每10秒檢查一次
        }
    }

    function stopHeartbeat() {
        console.log('Stopping heartbeat');
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
    }

    // 添加取消传输的事件处理
    cancelTransferBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'cancelTransfer' });
        progressOverlay.style.display = 'none';
        activeTransfers.clear();
        showToast('Transfer cancelled');
    });

    // Render saved connections list
    function renderSavedConnections(connections) {
        savedConnectionsList.innerHTML = '';
        connections.forEach(conn => {
            const item = document.createElement('div');
            item.className = 'connection-item' + (currentConnection?.id === conn.id ? ' active' : '');
            item.innerHTML = `
                <div class="connection-item-info">
                    <div class="connection-item-name">${conn.name}</div>
                    <div class="connection-item-details">${conn.username}@${conn.host}:${conn.port}</div>
                </div>
                <div class="connection-item-actions">
                    <button class="icon-button delete-btn" title="Delete Connection">
                        <svg class="icon"><use xlink:href="#icon-trash"></use></svg>
                    </button>
                </div>
            `;
            
            // Click connection item
            item.onclick = (e) => {
                if (e.target.closest('.delete-btn')) {
                    showConfirmDeleteDialog(conn.id);
                    e.stopPropagation();
                    return;
                }
                selectConnection(conn);
            };
            
            savedConnectionsList.appendChild(item);
        });
    }

    // 更新保存按钮文本
    function updateSaveButtonText() {
        const saveBtn = document.getElementById('saveConnectionBtn');
        saveBtn.textContent = currentConnection ? 'Update Connection' : 'Save Connection';
    }

    // 显示新建连接表单
    document.getElementById('newConnectionBtn').onclick = () => {
        currentConnection = null;
        connectionForm.style.display = 'block';
        document.getElementById('connectionName').value = '';
        document.getElementById('host').value = '';
        document.getElementById('port').value = '22';
        document.getElementById('username').value = '';
        document.getElementById('password').value = '';
        
        // 取消所有连接项的选中状态
        document.querySelectorAll('.connection-item').forEach(item => {
            item.classList.remove('active');
        });
        
        updateSaveButtonText();
    };

    // Select connection
    function selectConnection(connection) {
        currentConnection = connection;
        document.getElementById('connectionName').value = connection.name;
        document.getElementById('host').value = connection.host;
        document.getElementById('port').value = connection.port;
        document.getElementById('username').value = connection.username;
        
        const useKeyAuth = connection.authType === 'key';
        document.getElementById('useKeyAuth').checked = useKeyAuth;
        
        if (useKeyAuth) {
            document.getElementById('privateKeyPath').value = connection.privateKeyPath || '';
            document.getElementById('keyPassphrase').value = connection.passphrase || '';
            document.getElementById('passwordAuth').style.display = 'none';
            document.getElementById('keyAuth').style.display = 'block';
        } else {
            document.getElementById('password').value = connection.password || '';
            document.getElementById('passwordAuth').style.display = 'block';
            document.getElementById('keyAuth').style.display = 'none';
        }
        
        connectionForm.style.display = 'block';
        
        // 更新UI状态
        document.querySelectorAll('.connection-item').forEach(item => {
            item.classList.toggle('active', 
                item.querySelector('.connection-item-name').textContent === connection.name);
        });
        
        updateSaveButtonText();
    }

    // 保存连接
    document.getElementById('saveConnectionBtn').onclick = () => {
        const useKeyAuth = document.getElementById('useKeyAuth').checked;
        const newConnection = {
            id: currentConnection?.id || Date.now().toString(),
            name: document.getElementById('connectionName').value,
            host: document.getElementById('host').value,
            port: document.getElementById('port').value,
            username: document.getElementById('username').value,
            authType: useKeyAuth ? 'key' : 'password'
        };

        if (useKeyAuth) {
            newConnection.privateKeyPath = document.getElementById('privateKeyPath').value;
            newConnection.passphrase = document.getElementById('keyPassphrase').value;
        } else {
            newConnection.password = document.getElementById('password').value;
        }

        if (!newConnection.name || !newConnection.host || !newConnection.username) {
            showToast('Please fill in the required connection information', true);
            return;
        }

        // 检查是否已存在相同的连接信息
        const existingConnection = Array.from(savedConnectionsList.children).some(item => {
            const nameEl = item.querySelector('.connection-item-name');
            const detailsEl = item.querySelector('.connection-item-details');
            if (!nameEl || !detailsEl) return false;

            const name = nameEl.textContent;
            const details = detailsEl.textContent; // 格式为 "username@host:port"
            const [username, hostPort] = details.split('@');
            const [host, port] = hostPort.split(':');

            return name === newConnection.name &&
                   host === newConnection.host &&
                   port === newConnection.port &&
                   username === newConnection.username;
        });

        if (existingConnection && !currentConnection) {
            showToast('Connection with the same information already exists', true);
            return;
        }

        vscode.postMessage({
            type: currentConnection ? 'updateConnection' : 'saveConnection',
            connection: newConnection
        });
    };

    // 显示编辑连接对话框
    function showEditConnectionDialog(connection) {
        const dialog = document.getElementById('connectionDialog');
        dialog.style.display = 'block';
        
        document.getElementById('editConnectionName').value = connection.name;
        document.getElementById('editHost').value = connection.host;
        document.getElementById('editPort').value = connection.port;
        document.getElementById('editUsername').value = connection.username;
        document.getElementById('editPassword').value = connection.password;
        
        dialog.setAttribute('data-connection-id', connection.id);
    }

    // 显示确认删除对话框
    function showConfirmDeleteDialog(connectionId) {
        const dialog = document.getElementById('confirmDeleteDialog');
        dialog.setAttribute('data-connection-id', connectionId);
        dialog.style.display = 'block';
    }

    // 删除连接按钮点击事件
    document.getElementById('deleteConnectionBtn').onclick = () => {
        const connectionDialog = document.getElementById('connectionDialog');
        const id = connectionDialog.getAttribute('data-connection-id');
        showConfirmDeleteDialog(id);
    };

    // 确认删除
    document.getElementById('confirmDelete').onclick = () => {
        const dialog = document.getElementById('confirmDeleteDialog');
        const id = dialog.getAttribute('data-connection-id');
        
        vscode.postMessage({
            type: 'deleteConnection',
            id
        });
        
        // 关闭所有对话框
        dialog.style.display = 'none';
        document.getElementById('connectionDialog').style.display = 'none';
        
        if (currentConnection?.id === id) {
            currentConnection = null;
            connectionForm.style.display = 'none';
        }
    };

    // 取消删除
    document.getElementById('cancelDelete').onclick = () => {
        document.getElementById('confirmDeleteDialog').style.display = 'none';
    };

    // 取消编辑
    document.getElementById('cancelEditConnection').onclick = () => {
        document.getElementById('connectionDialog').style.display = 'none';
    };

    // 断开连接时的处理
    function handleDisconnect() {
        connectionStatus = 'disconnected';
        updateConnectBtn();
        showToast('Disconnected');
    }

    // 在连接成功后的处理
    function handleConnected() {
        connectionStatus = 'connected';
        updateConnectBtn();
        showToast('Connected successfully');
    }

    // Initialize local file list on startup
    function initializeLocalFiles() {
        updateLocalPathNavigator();
        updateLocalFileList();
    }

    // 根據 localFilePath 自動選取 local file
    function selectLocalFileByPath(localFilePath) {
        pendingPrepareUploadPath = null;
                
        // Update local path navigation to file directory
        const localDir = path.dirname(localFilePath);
        localPath = localDir;
        updateLocalFileList();

        // Small delay to wait for file list update
        setTimeout(() => {
            // Find and select the file
            const fileName = path.basename(localFilePath);
            const fileItems = document.querySelectorAll('#localFileList .file-item');
            fileItems.forEach(item => {
                if (item.getAttribute('data-name') === fileName) {
                    // Clear other selections
                    localSelectedItems.clear();
                    document.querySelectorAll('#localFileList .file-item').forEach(el => {
                        el.classList.remove('selected', 'multi-selected');
                        const checkbox = el.querySelector('.file-checkbox');
                        if (checkbox) {
                            checkbox.checked = false;
                        }
                    });

                    // Select this file
                    localSelectedItems.add(item);
                    item.classList.add('selected');
                    const checkbox = item.querySelector('.file-checkbox');
                    if (checkbox) {
                        checkbox.checked = true;
                    }

                    // Ensure file is visible
                    item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            });
        }, 300); 

    }

    // 監聽消息
    window.addEventListener('message', event => {
        const message = event.data;
        console.log('Received message:', message.type, message);
        
        switch (message.type) {
            case 'heartbeatStatus':
                console.log('Received heartbeat status:', message.enabled);
                enableHeartbeat = message.enabled;
                // 如果心跳包被禁用，停止当前的心跳
                if (!enableHeartbeat) {
                    stopHeartbeat();
                } else if (connectionStatus === 'connected') {
                    // 如果心跳包被启用且已连接，启动心跳
                    startHeartbeat();
                }
                break;

            case 'connected':
                handleConnected();
                // 显示连接类型
                const clientType = message.clientType || 'sftp-client';
                const clientTypeText = clientType === 'sftp-client' ? 
                    'SFTP' : 
                    'SCP (Optimized Copy Mode)';
                showToast(`Connected using ${clientTypeText}`);
                updateLocalFileList();
                vscode.postMessage({
                    type: 'listFiles',
                    path: remotePath
                });
                startHeartbeat();
                // --- 若有 pendingPrepareUploadPath，則執行選取 ---
                if (pendingPrepareUploadPath) {
                    setTimeout(() => {
                        selectLocalFileByPath(pendingPrepareUploadPath);
                    }, 200);
                }
                break;
            
            case 'heartbeatOk':
                // 連線正常，不動作
                break;
            
            case 'heartbeatFail':
                setStatusBtn('error');
                showToast('Connection lost, please reconnect', true);
                stopHeartbeat(); // 心跳失败时停止
                document.getElementById('remoteFileList').innerHTML = '';
                document.getElementById('remotePathNavigator').innerHTML = '';
                
                // 清理所有进行中的操作
                // 隐藏进度条
                progressOverlay.style.display = 'none';
                // 清理传输状态
                activeTransfers.clear();
                // 重置删除计数器
                window.deleteCompletedCount = 0;
                window.totalDeleteItems = 0;
                // 隐藏所有对话框
                document.getElementById('newFolderDialog').style.display = 'none';
                document.getElementById('renameDialog').style.display = 'none';
                document.getElementById('confirmDialog').style.display = 'none';
                
                const emptyMsg2 = document.createElement('div');
                emptyMsg2.className = 'empty-message';
                emptyMsg2.textContent = 'Please connect first';
                document.getElementById('remoteFileList').appendChild(emptyMsg2);
                break;
            
            case 'error':
                progressOverlay.style.display = 'none';
                // Check if message starts with "Warning: "
                if (message.message && message.message.startsWith('Warning: ')) {
                    showToast(message.message.substring(9), false, true); // Remove "Warning: " prefix
                } else {
                    setStatusBtn('error');
                    stopHeartbeat();
                    showToast(message.message, true);
                }
                break;
            
            case 'warning':
                progressOverlay.style.display = 'none';
                showToast(message.message, false, true);
                break;
            
            case 'localFileList':
                updateLocalPathNavigator();
                updateFileList(message.files, document.getElementById('localFileList'), localSelectedItems);
                break;
                
            case 'fileList':
                if (message.path) {
                    remotePath = message.path;
                }
                updateRemotePathNavigator();
                updateFileList(message.files, document.getElementById('remoteFileList'), remoteSelectedItems);
                break;
                
            case 'folderCreated':
                progressOverlay.style.display = 'none';
                showToast('Folder created successfully');
                if (message.isLocal) {
                    updateLocalFileList();
                } else {
                    vscode.postMessage({
                        type: 'listFiles',
                        path: remotePath
                    });
                }
                break;
                
            case 'deleteProgress':
                const { currentIndex, totalItems, currentItem } = message;
                const deleteProgress = (currentIndex / totalItems) * 100;
                progressFill.style.width = deleteProgress + '%';
                progressPercentage.textContent = Math.round(deleteProgress) + '%';
                progressText.textContent = `Deleting: ${currentItem} (${currentIndex + 1}/${totalItems})`;
                break;
                
            case 'deleted':
                // Increment delete completion counter
                window.deleteCompletedCount = (window.deleteCompletedCount || 0) + 1;
                
                // Check if all files have been deleted
                if (window.deleteCompletedCount >= window.totalDeleteItems) {
                    progressOverlay.style.display = 'none';
                    showToast('Items deleted successfully');
                    
                    // Clear selections
                    if (message.isLocal) {
                        localSelectedItems.clear();
                        document.querySelectorAll('#localFileList .file-item').forEach(el => {
                            el.classList.remove('selected', 'multi-selected');
                            const checkbox = el.querySelector('.file-checkbox');
                            if (checkbox) {
                                checkbox.checked = false;
                            }
                        });
                        updateLocalFileList();
                    } else {
                        remoteSelectedItems.clear();
                        document.querySelectorAll('#remoteFileList .file-item').forEach(el => {
                            el.classList.remove('selected', 'multi-selected');
                            const checkbox = el.querySelector('.file-checkbox');
                            if (checkbox) {
                                checkbox.checked = false;
                            }
                        });
                        vscode.postMessage({
                            type: 'listFiles',
                            path: remotePath
                        });
                    }
                }
                break;
                
            case 'transferProgress':
                const { fileName, progress, direction } = message;
                activeTransfers.set(fileName, progress);
                
                const totalProgress = Array.from(activeTransfers.values())
                    .reduce((sum, value) => sum + value, 0) / activeTransfers.size;
                
                progressFill.style.width = totalProgress + '%';
                progressPercentage.textContent = Math.round(totalProgress) + '%';
                progressText.textContent = (direction === 'upload' ? 'Uploading' : 'Downloading') + ': ' + fileName;
                break;
                
            case 'transferComplete':
                activeTransfers.clear();
                progressOverlay.style.display = 'none';
                updateLocalFileList();
                // Add delay
                setTimeout(() => {
                    vscode.postMessage({
                        type: 'listFiles',
                        path: remotePath
                    });
                }, 600);
                showToast('Transfer completed successfully');
                break;
            
            case 'renamed':
                showToast('Renamed successfully');
                if (message.isLocal) {
                    updateLocalFileList();
                } else {
                    vscode.postMessage({
                        type: 'listFiles',
                        path: remotePath
                    });
                }
                break;
            
            case 'disconnected':
                handleDisconnect();
                showToast('Disconnected from server');
                stopHeartbeat();
                document.getElementById('remoteFileList').innerHTML = '';
                document.getElementById('remotePathNavigator').innerHTML = '';
                const emptyMsg = document.createElement('div');
                emptyMsg.className = 'empty-message';
                emptyMsg.textContent = 'Please connect first';
                document.getElementById('remoteFileList').appendChild(emptyMsg);
                break;
            
            case 'createFolderProgress':
                const { folderName: creatingFolder, progress: folderProgress } = message;
                progressFill.style.width = folderProgress + '%';
                progressPercentage.textContent = Math.round(folderProgress) + '%';
                progressText.textContent = `Creating folder: ${creatingFolder}`;
                break;
                
            case 'uploadProgress':
                const { 
                    fileName: uploadingFile, 
                    progress: fileProgress, 
                    currentFile, 
                    totalFiles 
                } = message;
                const uploadTotalProgress = ((currentFile - 1 + fileProgress) / totalFiles) * 100;
                progressFill.style.width = uploadTotalProgress + '%';
                progressPercentage.textContent = Math.round(uploadTotalProgress) + '%';
                progressText.textContent = `Uploading: ${uploadingFile} (${currentFile}/${totalFiles})`;
                break;
            
            case 'savedConnections':
                console.log('Processing saved connections:', message);
                renderSavedConnections(message.connections);
                if (message.success) {
                    console.log('Showing success notification');
                    if (message.isUpdate) {
                        showToast('Connection settings updated successfully');
                    } else if (message.isDelete) {
                        showToast('Connection deleted successfully');
                        currentConnection = null;
                    } else {
                        showToast('Connection settings saved successfully');
                        // Set current connection to the newly saved one
                        if (message.savedConnection) {
                            currentConnection = message.savedConnection;
                        }
                    }
                    updateSaveButtonText();
                } else {
                    console.log('Operation was not successful');
                }
                break;

            case 'privateKeySelected':
                document.getElementById('privateKeyPath').value = message.path;
                break;

            case 'prepareUpload':
                const localFilePath = message.localPath;
                // --- 若尚未連接，暫存起來 ---
                if (connectionStatus !== 'connected') {
                    pendingPrepareUploadPath = localFilePath;
                    showToast('Please connect first, then the file will be selected automatically');
                    break;
                }
                else{
                    selectLocalFileByPath(localFilePath);
                }
                break;
        }
    });

    // Initialization complete
    log('WebView initialized');
    // Initialize local files immediately
    initializeLocalFiles();
})(); 