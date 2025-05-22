export interface FileItem {
    name: string;
    isDirectory: boolean;
    size: number;
    modifyTime: number;
}

export interface ConnectionData {
    host: string;
    port: string;
    username: string;
    type: 'password' | 'key';
    password?: string;
    privateKeyPath?: string;
    passphrase?: string;
    clientType?: 'sftp-client' | 'scp-client';
}

export interface TransferProgress {
    fileName: string;
    progress: number;
    direction: 'upload' | 'download';
} 