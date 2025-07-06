import * as net from 'net';
import { ServerTransport } from "@modelcontextprotocol/sdk/server/transport.js";

// You will likely need to import McpServer if it's not already, for the mcpServerInstance type.
// Assuming your mcpServerInstance is an instance of McpServer
// import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'; // <--- ADD THIS IF NOT ALREADY THERE

export class NetServerTransport implements ServerTransport {
    private server: net.Server;
    private clients: net.Socket[] = []; // You use an array for clients
    private onMessageCallback: (message: any) => Promise<any> = async () => {};
    private onReadyCallback: () => void = () => {};
    private mcpServerInstance: any; // Make sure this type is correct, ideally McpServer
    private port: number;

    constructor(port: number, mcpServerInstance: any) {
        this.port = port;
        this.mcpServerInstance = mcpServerInstance;
        this.server = net.createServer((socket) => {
            console.log(`[NetServerTransport] Phone client connected from ${socket.remoteAddress}:${socket.remotePort}`);
            this.clients.push(socket);

            socket.on('data', async (data) => {
                const rawMessage = data.toString().trim(); // Capture raw message for logging
                if (!rawMessage) return; // Use rawMessage instead of message here
                console.log(`[NetServerTransport] Received raw message from client: ${rawMessage}`);

                try {
                    const parsedMessage = JSON.parse(rawMessage); // Try parsing the raw message

                    // Your existing MCP tool_request handling logic
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
                        // If it's a valid JSON but not a recognized tool_request, maybe process it via onMessageCallback
                        // or log as unknown. Your current code logs as warn.
                        console.warn(`[NetServerTransport] Unknown or custom message type from phone:`, parsedMessage);
                        // If you intend for other MCP messages to be handled by onMessageCallback:
                        // await this.onMessageCallback(parsedMessage);
                    }

                } catch (e: any) {
                    // --- START OF NEW HTTP ERROR HANDLING ---
                    // If parsing fails, check if it's an HTTP request (HEAD, GET, POST)
                    if (rawMessage.startsWith('HEAD /') || rawMessage.startsWith('GET /') || rawMessage.startsWith('POST /')) {
                        console.warn(`[NetServerTransport] Received unexpected HTTP request on TCP port. This is likely a health check or misconfigured client.`);
                        // Send a minimal HTTP 200 OK response to satisfy the health checker
                        socket.write('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
                    } else {
                        // Log other non-JSON parsing errors
                        console.error(`[NetServerTransport] Error parsing message from client: ${e.message} on raw data: "${rawMessage.substring(0, 100)}..."`);
                    }
                    // --- END OF NEW HTTP ERROR HANDLING ---
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

    // This method is correctly implemented in your current code
    async start(): Promise<void> {
        return new Promise((resolve) => {
            this.server.listen(this.port, () => {
                console.log(`[NetServerTransport] NetServerTransport listening on port ${this.port}`);
                this.onReadyCallback();
                resolve();
            });
        });
    }

    // Your existing dispose method
    async dispose(): Promise<void> {
        this.server.close();
        this.clients.forEach(c => c.destroy());
        console.log("NetServerTransport disposed.");
    }

    // Your existing sendMessage method (from ServerTransport interface)
    async sendMessage(message: any): Promise<void> {
        console.warn("[NetServerTransport] sendMessage (MCP Transport method) not implemented for custom TCP clients. Use sendToAllPhones or sendToPhone.");
    }

    // Your existing onMessage callback registration
    onMessage(callback: (message: any) => Promise<any>): net.Disposable {
        this.onMessageCallback = callback;
        return { dispose: () => {} };
    }

    // Your existing onReady callback registration
    onReady(callback: () => void): net.Disposable {
        this.onReadyCallback = callback;
        return { dispose: () => {} };
    }

    // Your existing sendToAllPhones method
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

    // Your existing sendToPhone method
    sendToPhone(phoneId: string, data: any): void {
        // You might want to implement logic here to find a specific client by phoneId
        // For now, it just calls sendToAllPhones, which is fine if that's the current behavior.
        this.sendToAllPhones(data);
    }
}
