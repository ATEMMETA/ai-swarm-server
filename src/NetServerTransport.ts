import * as net from 'net';
import { ServerTransport } from "@modelcontextprotocol/sdk/server/transport.js";

/**
 * Extending net.Socket to optionally hold clientId for identification.
 */
type TcpClient = net.Socket & { clientId?: string };

export class NetServerTransport implements ServerTransport {
  private server: net.Server;
  private clients: TcpClient[] = [];
  private onMessageCallback: (message: any) => Promise<any> = async () => {};
  private onReadyCallback: () => void = () => {};
  private mcpServerInstance: any;
  private port: number;
  private messageQueue: Array<string | { clientId: string; data: any }> = [];
  private transportReady = false;

  /** Map MCP userId to clientId */
  private userClientMap: Map<string, string> = new Map();

  constructor(port: number, mcpServerInstance: any) {
    this.port = port;
    this.mcpServerInstance = mcpServerInstance;

    this.server = net.createServer((socket: TcpClient) => {
      console.log(`[NetServerTransport] Client connected from ${socket.remoteAddress}:${socket.remotePort}`);
      this.clients.push(socket);

      socket.on('data', async (data) => {
        const rawMessage = data.toString().trim();
        if (!rawMessage) return;

        try {
          const parsedMessage = JSON.parse(rawMessage);

          // Handle client registration with unique clientId
          if (parsedMessage.type === 'register_client' && typeof parsedMessage.clientId === 'string') {
            socket.clientId = parsedMessage.clientId;
            console.log(`[NetServerTransport] Registered clientId: ${socket.clientId}`);
            return;
          }

          // Handle mapping of MCP userId to clientId if included (optional)
          if (parsedMessage.type === 'user_client_map' && parsedMessage.userId && parsedMessage.clientId) {
            this.userClientMap.set(parsedMessage.userId, parsedMessage.clientId);
            console.log(`[NetServerTransport] Mapped userId ${parsedMessage.userId} to clientId ${parsedMessage.clientId}`);
            return;
          }

          if (parsedMessage.type === 'tool_request') {
            const { tool_id, args } = parsedMessage;
            if (tool_id && args) {
              try {
                const toolResult = await this.mcpServerInstance.callTool(tool_id, args);
                socket.write(JSON.stringify({ type: 'tool_response', tool_id, result: toolResult }) + '\n');
              } catch (toolError: any) {
                socket.write(JSON.stringify({ type: 'tool_response', tool_id, error: toolError.message }) + '\n');
                console.error(`[NetServerTransport] Error executing tool ${tool_id} for client ${socket.clientId || 'unknown'}:`, toolError);
              }
            }
          } else {
            console.warn(`[NetServerTransport] Unknown message type from client ${socket.clientId || 'unknown'}:`, parsedMessage);
            // Optionally, forward unhandled messages for custom handling
            // await this.onMessageCallback(parsedMessage);
          }

        } catch (e: any) {
          // Check for basic HTTP requests for health checks and reply 200 OK
          if (rawMessage.startsWith('HEAD /') || rawMessage.startsWith('GET /') || rawMessage.startsWith('POST /')) {
            socket.write('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
          } else {
            console.error(`[NetServerTransport] Error parsing message: ${e.message} - Raw: ${rawMessage.substring(0, 100)}`);
          }
        }
      });

      socket.on('end', () => {
        console.log(`[NetServerTransport] Client ${socket.clientId || ''} disconnected.`);
        this.clients = this.clients.filter(c => c !== socket);

        // Remove clientId mapping if any
        if (socket.clientId) {
          for (const [userId, clientId] of this.userClientMap.entries()) {
            if (clientId === socket.clientId) {
              this.userClientMap.delete(userId);
              console.log(`[NetServerTransport] Removed mapping userId ${userId} -> clientId ${clientId}`);
              break;
            }
          }
        }
      });

      socket.on('error', (err) => {
        console.error(`[NetServerTransport] Client socket error: ${err.message}`);
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
    this.userClientMap.clear();
    console.log("[NetServerTransport] Disposed.");
  }

  async sendMessage(message: any): Promise<void> {
    console.warn("[NetServerTransport] sendMessage() not implemented, use sendToPhone or sendToAllPhones.");
  }

  onMessage(callback: (message: any) => Promise<any>): net.Disposable {
    this.onMessageCallback = callback;
    return { dispose: () => {} };
  }

  onReady(callback: () => void): net.Disposable {
    this.onReadyCallback = callback;
    return { dispose: () => {} };
  }

  /** Broadcast message to all connected clients or queue if not ready */
  sendToAllPhones(data: any): void {
    const msg = JSON.stringify(data) + '\n';
    if (!this.transportReady || this.clients.length === 0) {
      console.warn("[NetServerTransport] Transport not ready or no clients - queuing message.");
      this.messageQueue.push(msg);
      return;
    }
    this.clients.forEach(client => client.write(msg));
    console.log(`[NetServerTransport] Broadcast message sent to ${this.clients.length} clients.`);
  }

  /** Send message to a specific client by clientId; queue if not connected */
  sendToPhone(clientId: string, data: any): void {
    const client = this.clients.find(c => c.clientId === clientId);
    if (!client) {
      console.warn(`[NetServerTransport] Client ${clientId} not found - queuing message.`);
      this.messageQueue.push({ clientId, data });
      return;
    }
    const msg = JSON.stringify(data) + '\n';
    client.write(msg);
    console.log(`[NetServerTransport] Message sent to client ${clientId}.`);
  }

  /** Flush queued messages when transport/client becomes ready */
  private flushMessageQueue(): void {
    if (!this.transportReady) return;
    console.log(`[NetServerTransport] Flushing message queue of length ${this.messageQueue.length}`);

    const remainingQueue: typeof this.messageQueue = [];

    for (const item of this.messageQueue) {
      if (typeof item === 'string') {
        // Broadcast message
        if (this.clients.length > 0) {
          this.clients.forEach(client => client.write(item));
          console.log("[NetServerTransport] Flushed a broadcast message.");
        } else {
          remainingQueue.push(item);
        }
      } else if (item.clientId && item.data) {
        // Targeted message
        const client = this.clients.find(c => c.clientId === item.clientId);
        if (client) {
          client.write(JSON.stringify(item.data) + '\n');
          console.log(`[NetServerTransport] Flushed message to client ${item.clientId}`);
        } else {
          remainingQueue.push(item);
        }
      } else {
        // Unknown format; keep in queue
        remainingQueue.push(item);
      }
    }

    this.messageQueue = remainingQueue;
  }

  /**
   * Optional: provide access to userClientMap for other server modules
   */
  getUserClientMap(): Map<string, string> {
    return this.userClientMap;
  }
}
