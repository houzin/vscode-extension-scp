export class Warning extends Error {
    type: string;
    
    constructor(message: string) {
        // 确保消息前面加上 "Warning: " 前缀
        super(message.startsWith('Warning: ') ? message : `Warning: ${message}`);
        this.name = 'WARNING';
        this.type = 'warning';
    }
} 