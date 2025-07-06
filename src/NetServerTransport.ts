import * as net from 'net'; // <--- ADD THIS LINE at the top
import { ServerTransport } from "@modelcontextprotocol/sdk/server/transport.js"; // This import is crucial for the interface
// Remove or comment out: import { Disposable, Logger } from "@modelcontextprotocol/sdk/common/logging.js";
// Also remove the direct import for Disposable, as it's not needed for your implementation.
// The `ServerTransport` interface you implement might have a `Disposable` method, but you don't need to import the Disposable *type* directly from that problematic path.

// --- Import Logger from a more stable path if available, or just use console.log ---
// If the SDK provides a public Logger from a different path (e.g., `@modelcontextprotocol/sdk/logger.js`), use that.
// Otherwise, just use console.log, it's simpler and avoids the module resolution issue.

export class NetServerTransport implements ServerTransport {
    private server: net.Server;
    private clients: net.Socket[] = []; // Track connected phone clients
    // private logger = new Logger("NetServerTransport"); // Remove this line
    private onMessageCallback: (message: any) => Promise<any> = async () => {};
    private onReadyCallback: () => void = () => {};
    private mcpServerInstance: any; // Keep this

    constructor(port: number, mcpServerInstance: any) {
        this.mcpServerInstance = mcpServerInstance;
        this.server = net.createServer((socket) => {
            console.log(`[NetServerTransport] Phone client connected from ${socket.remoteAddress}:${socket.remotePort}`); // Use console.log
            this.clients.push(socket);

            socket.on('data', async (data) => {
                const message = data.toString().trim();
                if (!message) return;
                console.log(`[NetServerTransport] Received raw message from client: ${message}`); // Use console.log
                try {
                    const parsedMessage = JSON.parse(message);

                    if (parsedMessage.type === 'tool_request') {
                        const { tool_id, args } = parsedMessage;
                        if (tool_id && args) {
                            try {
                                const toolResult = await this.mcpServerInstance.callTool(tool_id, args);
                                socket.write(JSON.stringify({ type: 'tool_response', tool_id, result: toolResult }) + '\n');
                            } catch (toolError: any) { // Add : any for error type
                                socket.write(JSON.stringify({ type: 'tool_response', tool_id, error: toolError.message }) + '\n');
                                console.error(`[NetServerTransport] Error executing tool ${tool_id} for phone:`, toolError); // Use console.error
                            }
                        }
                    } else {
                        console.warn(`[NetServerTransport] Unknown or custom message type from phone:`, parsedMessage); // Use console.warn
                    }

                } catch (e: any) { // Add : any for error type
                    console.error(`[NetServerTransport] Error parsing message from client: ${e.message}`, data.toString()); // Use console.error
                }
            });

            socket.on('end', () => {
                console.log(`[NetServerTransport] Phone client disconnected.`); // Use console.log
                this.clients = this.clients.filter(c => c !== socket);
            });

            socket.on('error', (err) => {
                console.error(`[NetServerTransport] Phone client socket error: ${err.message}`); // Use console.error
                this.clients = this.clients.filter(c => c !== socket);
            });
        });

        this.server.listen(port, () => {
            console.log(`[NetServerTransport] NetServerTransport listening on port ${port}`); // Use console.log
            this.onReadyCallback();
        });
    }

    async dispose(): Promise<void> {
        this.server.close();
        this.clients.forEach(c => c.destroy());
        console.log("NetServerTransport disposed."); // Use console.log
    }

    async sendMessage(message: any): Promise<void> {
        console.warn("[NetServerTransport] sendMessage (MCP Transport method) not implemented for custom TCP clients."); // Use console.warn
    }

    onMessage(callback: (message: any) => Promise<any>): net.Disposable { // Change Disposable to net.Disposable
        this.onMessageCallback = callback;
        return { dispose: () => {} };
    }

    onReady(callback: () => void): net.Disposable { // Change Disposable to net.Disposable
        this.onReadyCallback = callback;
        return { dispose: () => {} };
    }

    sendToAllPhones(data: any): void {
        const messageToSend = JSON.stringify(data) + '\n';
        if (this.clients.length > 0) {
            this.clients.forEach(client => {
                client.write(messageToSend);
            });
            console.log(`[NetServerTransport] Sent message to ${this.clients.length} phone(s): ${JSON.stringify(data)}`); // Use console.log
        } else {
            console.warn(`[NetServerTransport] No phone clients connected to send data to.`); // Use console.warn
        }
    }

    sendToPhone(phoneId: string, data: any): void {
        this.sendToAllPhones(data);
    }
}
