import * as net from 'net';
import { ServerTransport } from "@modelcontextprotocol/sdk/server/transport.js";

export class NetServerTransport implements ServerTransport {
    private server: net.Server;
    private clients: net.Socket[] = [];
    private onMessageCallback: (message: any) => Promise<any> = async () => {};
    private onReadyCallback: () => void = () => {};
    private mcpServerInstance: any;
    private port: number; // Store the port as a class property

    constructor(port: number, mcpServerInstance: any) {
        this.port = port; // Store the port here
        this.mcpServerInstance = mcpServerInstance;
        this.server = net.createServer((socket) => {
            console.log(`[NetServerTransport] Phone client connected from ${socket.remoteAddress}:${socket.remotePort}`);
            this.clients.push(socket);

            socket.on('data', async (data) => {
                const message = data.toString().trim();
                if (!message) return;
                console.log(`[NetServerTransport] Received raw message from client: ${message}`);
                try {
                    const parsedMessage = JSON.parse(message);

                    if (parsedMessage.type === 'tool_request') {
                        const { tool_id, args } = parsedMessage;
                        if (tool_id && args) {
                            try {
                                const toolResult = await this.mcpServerInstance.callTool(tool_id, args);
                                socket.write(JSON.stringify({ type: 'tool_response', tool_id, result: toolResult }) + '\n');
                            } catch (toolError: any) {
                                socket.write(JSON.stringify({ type: 'tool_response', tool_id, error: toolError.message }) + '\n');
                                console.error(`[NetServerTransport] Error executing tool ${tool_id} for phone:`, toolError);
                            }
                        }
                    } else {
                        console.warn(`[NetServerTransport] Unknown or custom message type from phone:`, parsedMessage);
                    }

                } catch (e: any) {
                    console.error(`[NetServerTransport] Error parsing message from client: ${e.message}`, data.toString());
                }
            });

            socket.on('end', () => {
                console.log(`[NetServerTransport] Phone client disconnected.`);
                this.clients = this.clients.filter(c => c !== socket);
            });

            socket.on('error', (err) => {
                console.error(`[NetServerTransport] Phone client socket error: ${err.message}`);
                this.clients = this.clients.filter(c => c !== socket);
            });
        });
    }

    // ADD THIS NEW METHOD
    async start(): Promise<void> {
        return new Promise((resolve) => {
            this.server.listen(this.port, () => { // Use the stored port
                console.log(`[NetServerTransport] NetServerTransport listening on port ${this.port}`);
                this.onReadyCallback();
                resolve();
            });
        });
    }

    async dispose(): Promise<void> {
        this.server.close();
        this.clients.forEach(c => c.destroy());
        console.log("NetServerTransport disposed.");
    }

    async sendMessage(message: any): Promise<void> {
        console.warn("[NetServerTransport] sendMessage (MCP Transport method) not implemented for custom TCP clients.");
    }

    onMessage(callback: (message: any) => Promise<any>): net.Disposable {
        this.onMessageCallback = callback;
        return { dispose: () => {} };
    }

    onReady(callback: () => void): net.Disposable {
        this.onReadyCallback = callback;
        return { dispose: () => {} };
    }

    sendToAllPhones(data: any): void {
        const messageToSend = JSON.stringify(data) + '\n';
        if (this.clients.length > 0) {
            this.clients.forEach(client => {
                client.write(messageToSend);
            });
            console.log(`[NetServerTransport] Sent message to ${this.clients.length} phone(s): ${JSON.stringify(data)}`);
        } else {
            console.warn(`[NetServerTransport] No phone clients connected to send data to.`);
        }
    }

    sendToPhone(phoneId: string, data: any): void {
        this.sendToAllPhones(data);
    }
}
