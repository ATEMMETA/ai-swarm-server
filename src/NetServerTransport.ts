// Replace this line:
// import { Disposable, Logger } from "@modelcontextprotocol/sdk/common/logging.js";

// Try this instead:
import { Disposable } from '@modelcontextprotocol/sdk/common/logging.js'; // Keep Disposable for the interface
import { Logger } from '@modelcontextprotocol/sdk/common/logging.js'; // Confirming the path is correct based on SDK
// Or, if Logger is a default export or needs specific import:
// import Logger from '@modelcontextprotocol/sdk/common/logging.js';
// Or, if it's from a higher level:
// import { Logger } from '@modelcontextprotocol/sdk/dist/esm/common/logging.js'; // Still seems suspicious if not explicitly exported.

// Let's assume the previous path was correct, but maybe `tsx` struggles with `.js` extensions in imports.
// Try removing the .js:
// import { Disposable, Logger } from "@modelcontextprotocol/sdk/common/logging"; // No .js
// This usually works with `tsx` and TypeScript.


import * as net from 'net';

export class NetServerTransport implements ServerTransport {
    private server: net.Server;
    private clients: net.Socket[] = []; // Track connected phone clients
    private logger = new Logger("NetServerTransport");
    private onMessageCallback: (message: any) => Promise<any> = async () => {};
    private onReadyCallback: () => void = () => {};
    private mcpServerInstance: any;

    constructor(port: number, mcpServerInstance: any) {
        this.mcpServerInstance = mcpServerInstance;
        this.server = net.createServer((socket) => {
            this.logger.info(`Phone client connected from ${socket.remoteAddress}:${socket.remotePort}`);
            this.clients.push(socket);

            socket.on('data', async (data) => {
                const message = data.toString().trim(); // Trim whitespace, especially newline
                if (!message) return; // Ignore empty messages
                this.logger.debug(`Received raw message from client: ${message}`);
                try {
                    const parsedMessage = JSON.parse(message);

                    if (parsedMessage.type === 'tool_request') {
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
                        // Handle other custom messages from phone (e.g., phone's status, capabilities)
                        this.logger.warn(`Unknown or custom message type from phone:`, parsedMessage);
                        // You could still trigger an MCP tool here if you define one for incoming phone data.
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

    async dispose(): Promise<void> {
        this.server.close();
        this.clients.forEach(c => c.destroy());
        this.logger.info("NetServerTransport disposed.");
    }

    // This MCP ServerTransport method might not be used if the phone is a custom TCP client
    async sendMessage(message: any): Promise<void> {
        this.logger.warn("sendMessage (MCP Transport method) not implemented for custom TCP clients.");
        // This method is for when the MCP server wants to send *MCP protocol messages* to its clients.
        // For your setup, phones are custom TCP clients making tool requests, not full MCP clients yet.
        // You'll use `sendToAllPhones` below to push data to phones.
    }

    onMessage(callback: (message: any) => Promise<any>): Disposable {
        this.onMessageCallback = callback;
        return { dispose: () => {} };
    }

    onReady(callback: () => void): Disposable {
        this.onReadyCallback = callback;
        return { dispose: () => {} };
    }

    // Custom method to send data to all connected phone clients
    // This will be called by your `receive_telegram_message` MCP tool.
    sendToAllPhones(data: any): void {
        const messageToSend = JSON.stringify(data) + '\n';
        if (this.clients.length > 0) {
            this.clients.forEach(client => {
                client.write(messageToSend);
            });
            this.logger.info(`Sent message to ${this.clients.length} phone(s): ${JSON.stringify(data)}`);
        } else {
            this.logger.warn(`No phone clients connected to send data to.`);
        }
    }

    // Optional: If you later implement phone-specific routing
    sendToPhone(phoneId: string, data: any): void {
        // You'd need a map: Map<string, net.Socket> phoneIdToSocket;
        // const targetSocket = this.phoneIdToSocket.get(phoneId);
        // if (targetSocket) {
        //     targetSocket.write(JSON.stringify(data) + '\n');
        //     this.logger.info(`Sent data to phone ${phoneId}: ${JSON.stringify(data)}`);
        // } else {
        //     this.logger.warn(`Phone ${phoneId} not found or not connected.`);
        // }
        this.sendToAllPhones(data); // Fallback for now
    }
}
