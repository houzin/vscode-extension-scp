export interface SshConfig {
    host: string;
    port: number;
    username: string;
    authType: 'password' | 'key';
    password?: string;
    privateKey?: string | Buffer;
    passphrase?: string;
    readyTimeout?: number;
}

export interface SshFileStats {
    filename: string;
    attrs: {
        isDirectory: () => boolean;
        size: number;
        mtime: number;
    };
}

export interface SshClient {
    connect(config: SshConfig): Promise<void>;
    disconnect(): void;
    sftp(): Promise<SftpClient>;
}

export interface SftpClient {
    readdir(path: string): Promise<SshFileStats[]>;
    mkdir(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    unlink(path: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    createReadStream(path: string): NodeJS.ReadableStream;
    createWriteStream(path: string): NodeJS.WritableStream;
    stat(path: string): Promise<{ size: number; isDirectory: () => boolean }>;
} 