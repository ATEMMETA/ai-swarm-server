import * as net from 'net';
import { ServerTransport } from "@modelcontextprotocol/sdk/server/transport.js";

export class NetServerTransport implements ServerTransport {
  private server: net.Server;
  private clients: Array<net.Socket & { clientId?: string }> = [];
  private onMessageCallback: (message: any) => Promise<any> = async () => {};
  private onReadyCallback: () => void = () => {};
  private mcpServerInstance: any;
  private port: number;
  private messageQueue: any[] = [];
  private transportReady = false;

  constructor(port: number, mcpServerInstance: any) {
    this.port = port;
    this.mcpServerInstance = mcpServerInstance;

    this.server = net.createServer((socket: net.Socket & { clientId?: string }) => {
      console.log(`[NetServerTransport] Phone client connected from ${socket.remoteAddress}:${socket.remotePort}`);

      // Add the client socket without clientId yet
      this.clients.push(socket);

      socket.on('data', async (data) => {
        const rawMessage = data.toString().trim();
        if (!rawMessage) return;

        // Handle client registration message format:
        // { type: "register_client", clientId: "unique-client-id" }
        try {
          const parsedMessage = JSON.parse(rawMessage);
          if (parsedMessage.type === 'register_client' && typeof parsedMessage.clientId === 'string') {
            socket.clientId = parsedMessage.clientId;
            console.log(`[NetServerTransport] Registered client ID: ${socket.clientId}`);
            return;  // Registration handled, ignore further processing for this message
          }

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
            console.warn(`[NetServerTransport] Unknown or unhandled message type from phone:`, parsedMessage);
            // Optionally: await this.onMessageCallback(parsedMessage);
          }

        } catch (e: any) {
          // Handle HTTP health check or non-JSON messages gracefully
          if (rawMessage.startsWith('HEAD /') || rawMessage.startsWith('GET /') || rawMessage.startsWith('POST /')) {
            console.warn(`[NetServerTransport] Received HTTP request on TCP port (likely health check)`);
            socket.write('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
          } else {
            console.error(`[NetServerTransport] Failed to parse message from client: ${e.message}`);
          }
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

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        console.log(`[NetServerTransport] Listening on port ${this.port}`);
        this.transportReady = true;
        this.onReadyCallback();

        // Flush queued messages when server is ready
        this.flushMessageQueue();

        resolve();
      });
    });
  }

  async dispose(): Promise<void> {
    this.server.close();
    this.clients.forEach(c => c.destroy());
    this.clients = [];
    this.transportReady = false;
    this.messageQueue = [];
    console.log("[NetServerTransport] Transport disposed.");
  }

  async sendMessage(message: any): Promise<void> {
    // This generic sendMessage method is not used in your custom TCP clients;
    // Add custom logic here, or use sendToAllPhones/sendToPhone directly.
    console.warn("[NetServerTransport] sendMessage() not implemented for custom TCP clients. Use sendToAllPhones or sendToPhone.");
  }

  onMessage(callback: (message: any) => Promise<any>): net.Disposable {
    this.onMessageCallback = callback;
    return { dispose: () => {} };
  }

  onReady(callback: () => void): net.Disposable {
    this.onReadyCallback = callback;
    return { dispose: () => {} };
  }

  /** Send JSON message stringified + newline to all connected clients */
  sendToAllPhones(data: any): void {
    const msg = JSON.stringify(data) + '\n';
    if (!this.transportReady || this.clients.length === 0) {
      console.warn("[NetServerTransport] No clients or transport not ready. Queuing message.");
      this.messageQueue.push(msg);
      return;
    }
    this.clients.forEach(client => client.write(msg));
    console.log(`[NetServerTransport] Sent message to ${this.clients.length} phone(s)`);
  }

  /** Send JSON message to a specific client by clientId */
  sendToPhone(clientId: string, data: any): void {
    const client = this.clients.find(c => c.clientId === clientId);
    if (!client) {
      console.warn(`[NetServerTransport] Client with ID ${clientId} not found, queuing message.`);
      this.messageQueue.push({ clientId, data });
      return;
    }
    const msg = JSON.stringify(data) + '\n';
    client.write(msg);
    console.log(`[NetServerTransport] Sent message to client ${clientId}`);
  }

  /** Flush queued messages once transport and clients are ready */
  private flushMessageQueue(): void {
    if (!this.transportReady) return;
    console.log(`[NetServerTransport] Flushing message queue of length ${this.messageQueue.length}`);

    const remainingQueue: any[] = [];
    for (const item of this.messageQueue) {
      if (typeof item === 'string') {
        // Broadcast queued message to all phones
        if (this.clients.length > 0) {
          this.clients.forEach(client => client.write(item));
          console.log(`[NetServerTransport] Flushed broadcast message`);
        } else {
          remainingQueue.push(item);
        }
      } else if (item.clientId && item.data) {
        // Targeted message
        const client = this.clients.find(c => c.clientId === item.clientId);
        if (client) {
          client.write(JSON.stringify(item.data) + '\n');
          console.log(`[NetServerTransport] Flushed targeted message to client ${item.clientId}`);
        } else {
          remainingQueue.push(item);
        }
      } else {
        // Unknown format? Retain in queue
        remainingQueue.push(item);
      }
    }
    this.messageQueue = remainingQueue;
  }
}
