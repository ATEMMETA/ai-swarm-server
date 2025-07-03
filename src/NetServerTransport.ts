import { ServerTransport } from "@modelcontextprotocol/sdk/server/transport.js";
import { Disposable, Logger } from "@modelcontextprotocol/sdk/common/logging.js";
import * as net from 'net'; // Node.js TCP module

export class NetServerTransport implements ServerTransport {
    private server: net.Server;
    private clients: net.Socket[] = []; // Track connected phone clients
    private logger = new Logger("NetServerTransport");
    private onMessageCallback: (message: any) => Promise<any> = async () => {};
    private onReadyCallback: () => void = () => {};
    private mcpServerInstance: any; // Reference to the MCP server for calling tools

    constructor(port: number, mcpServerInstance: any) {
        this.mcpServerInstance = mcpServerInstance; // Store MCP server instance
        this.server = net.createServer((socket) => {
            this.logger.info(`Phone client connected from ${socket.remoteAddress}:${socket.remotePort}`);
            this.clients.push(socket);

            socket.on('data', async (data) => {
                const message = data.toString();
                this.logger.debug(`Received raw message from client: ${message}`);
                try {
                    const parsedMessage = JSON.parse(message);
                    // This is where the MCP transport needs to decide if it's an MCP message
                    // or a custom message from the phone (like a tool call request for the Node.js agent).
                    // For now, let's assume raw messages are directly processed or routed.

                    // If the phone sends an MCP request, you'd integrate the MCP client part on the phone.
                    // For our current flow, phones send specific tool requests (like "send_telegram_message").
                    
                    // You'll likely need to parse this message to see what the phone wants to do.
                    // Example:
                    if (parsedMessage.type === 'mcp_request') {
                        // Forward to MCP server logic if phones are MCP clients
                        // await this.onMessageCallback(parsedMessage.mcp_payload); // This would be MCP internal message
                        // For now, we'll manually call tools based on phone's message type
                    } else if (parsedMessage.type === 'tool_request') {
                        // Assuming phone sends { type: 'tool_request', tool_id: 'send_telegram_message', args: { chat_id: '...', text: '...' } }
                        const { tool_id, args } = parsedMessage;
                        if (tool_id && args) {
                            try {
                                const toolResult = await this.mcpServerInstance.callTool(tool_id, args);
                                // Send result back to the phone if needed
                                socket.write(JSON.stringify({ type: 'tool_response', tool_id, result: toolResult }) + '\n');
                            } catch (toolError) {
                                socket.write(JSON.stringify({ type: 'tool_response', tool_id, error: toolError.message }) + '\n');
                                this.logger.error(`Error executing tool ${tool_id} for phone:`, toolError);
                            }
                        }
                    } else {
                        // Handle other custom messages from phone
                        this.logger.warn(`Unknown message type from phone:`, parsedMessage);
                    }

                } catch (e) {
                    this.logger.error(`Error parsing message from client: ${e.message}`, data.toString());
                }
            });

            socket.on('end', () => {
                this.logger.info(`Phone client disconnected.`);
                this.clients = this.clients.filter(c => c !== socket);
            });

            socket.on('error', (err) => {
                this.logger.error(`Phone client socket error: ${err.message}`);
                this.clients = this.clients.filter(c => c !== socket);
            });
        });

        this.server.listen(port, () => {
            this.logger.info(`NetServerTransport listening on port ${port}`);
            this.onReadyCallback();
        });
    }

    // Methods required by ServerTransport interface (may not be fully utilized for this specific setup)
    async dispose(): Promise<void> {
        this.server.close();
        this.clients.forEach(c => c.destroy());
        this.logger.info("NetServerTransport disposed.");
    }

    // This method is for when the MCP Server wants to send a message to a client
    // For your setup, you might manually call socket.write() on a specific phone client.
    async sendMessage(message: any): Promise<void> {
        // Find the appropriate client to send the message to (e.g., based on a 'targetPhoneId' in message)
        // For simplicity here, let's just log. In a real scenario, you'd have client management.
        this.logger.warn("sendMessage not fully implemented for specific client targeting in NetServerTransport yet.");
        // Example: If you have a registry of `phoneId -> socket`, you'd use that.
        // this.clients[0]?.write(JSON.stringify(message) + '\n'); // send to first connected client
    }

    // This method is where the MCP Server registers its message handler
    onMessage(callback: (message: any) => Promise<any>): Disposable {
        this.onMessageCallback = callback;
        return { dispose: () => {} };
    }

    onReady(callback: () => void): Disposable {
        this.onReadyCallback = callback;
        return { dispose: () => {} };
    }

    // New method to allow the server to push data to specific phone clients
    // This will be called by your `receive_telegram_message` MCP tool to forward to a phone.
    sendToPhone(phoneId: string, data: any): void {
        // You'll need a map of phoneId to socket to make this truly useful for a swarm.
        // For now, sending to the first connected client:
        if (this.clients.length > 0) {
            this.clients[0].write(JSON.stringify(data) + '\n');
            this.logger.info(`Sent data to phone (first client): ${JSON.stringify(data)}`);
        } else {
            this.logger.warn(`No phone clients connected to send data to.`);
        }
    }
}
