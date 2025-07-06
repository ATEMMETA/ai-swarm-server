import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Telegraf } from "telegraf";
import { NetServerTransport } from './NetServerTransport.js';
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';
import express from 'express'; // Import Express

dotenv.config();

// --- MCP Server Setup ---
const mcpServer = new McpServer({
  name: "AI Swarm Gateway",
  version: "1.0.0",
  description: "Gateway for AI Swarm operations, routing to local phones and external APIs."
});

// --- Telegram Bot Setup ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// --- Google Gemini API Setup ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-pro" });

// --- Global State for Chat ID Mapping (Consider persistent storage for production) ---
const activeChats = new Map<string, string>(); // Maps userId to chatId

// --- MCP Tools for Phone Communication ---

// Tool for the Node.js agent to receive messages from Telegram and forward to phones
// This tool will be called by the HTTP webhook handler
mcpServer.tool(
  'receive_telegram_message',
  'Receive an incoming message from Telegram, used by the Node.js agent to forward to a specific phone or process.',
  {
    chat_id: z.string().describe("The Telegram chat ID for the conversation."),
    user_id: z.string().describe("The Telegram user ID of the sender."),
    text: z.string().describe("The text content of the Telegram message.")
  },
  async ({ chat_id, user_id, text }) => {
    console.log(`[MCP Tool: receive_telegram_message] Received from Telegram: Chat ID ${chat_id}, User ID ${user_id}, Text: "${text}"`);

    activeChats.set(user_id, chat_id); // Store chat_id for later response

    // This is where you'd select which phone to send the message to.
    // For now, let's just log and prepare the message to be sent to *any* connected phone.
    const messageForPhone = {
        type: 'telegram_input', // Custom type for your phone's TCP listener
        chat_id,
        user_id,
        text
    };

    // Assuming NetServerTransport has a way to send to a specific client,
    // or just broadcast to all connected clients for a prototype.
    // We'll add a `sendToAllPhones` or `sendToPhone` method to NetServerTransport.
    (mcpServer.transport as NetServerTransport).sendToAllPhones(messageForPhone); // Cast to access custom method

    return {
      content: [{ type: "text", text: `Message for chat ${chat_id} received and forwarded to phone swarm.` }]
    };
  }
);

// Tool for phones to send messages back to Telegram
mcpServer.tool(
  'send_telegram_message',
  'Send a message back to a Telegram chat.',
  {
    chat_id: z.string().describe("The Telegram chat ID to send the message to."),
    text: z.string().describe("The text message to send to Telegram.")
  },
  async ({ chat_id, text }) => {
    try {
      await bot.telegram.sendMessage(chat_id, text);
      console.log(`[MCP Tool: send_telegram_message] Sent to Telegram chat ${chat_id}: "${text}"`);
      return { content: [{ type: "text", text: "Message sent to Telegram successfully." }] };
    } catch (error) {
      console.error(`[MCP Tool: send_telegram_message] Error sending to Telegram chat ${chat_id}:`, error);
      return { content: [{ type: "text", text: `Error sending message: ${error.message}` }] };
    }
  }
);

// --- Optional: MCP Tool for Gemini API (if server-side Gemini is used) ---
mcpServer.tool(
    'gemini_chat',
    'Engage Google Gemini for advanced text generation or specific queries.',
    {
        prompt: z.string().describe("The prompt for the Gemini model."),
        model_name: z.string().optional().describe("Optional: Specific Gemini model to use (e.g., gemini-pro, gemini-1.5-pro-latest). Defaults to gemini-pro if not specified."),
        system_instruction: z.string().optional().describe("Optional: System instruction for Gemini."),
    },
    async ({ prompt, model_name, system_instruction }) => {
        try {
            const currentModel = model_name ? genAI.getGenerativeModel({ model: model_name }) : geminiModel;
            const result = await currentModel.generateContent(prompt);
            const response = result.response;
            const text = response.text();
            console.log(`[MCP Tool: gemini_chat] Gemini response: "${text.substring(0, 50)}..."`);
            return { content: [{ type: "text", text: text }] };
        } catch (error) {
            console.error(`[MCP Tool: gemini_chat] Error calling Gemini API:`, error);
            return { content: [{ type: "text", text: `Error from Gemini: ${error.message}` }] };
        }
    }
);

// --- Set up Communication Transports ---

// TCP communication with your phones
const tcpPort = parseInt(process.env.TCP_PORT || '8080'); // Port for phone communication
const netServerTransport = new NetServerTransport(tcpPort, mcpServer);
mcpServer.connect(netServerTransport); // Connect MCP server to this transport

// --- Express.js for HTTP Webhook ---
const app = express();
app.use(express.json()); // Middleware to parse JSON request bodies

// Render provides a PORT environment variable for HTTP traffic
const httpPort = parseInt(process.env.PORT || '3000');
const WEBHOOK_PATH = `/telegram-webhook`; // Consistent webhook path

// Telegram webhook endpoint
app.post(WEBHOOK_PATH, async (req, res) => {
    // Telegraf's webhookCallback handles the update processing and sends a 200 OK
    // This is crucial for Telegram to not retry
    bot.webhookCallback(WEBHOOK_PATH)(req, res);

    // After Telegraf handles it, we can extract the message and call our internal MCP tool
    // We parse it ourselves as bot.webhookCallback doesn't return the processed update
    const update = req.body;
    if (update && update.message) {
        const userId = update.message.from.id.toString();
        const chatId = update.message.chat.id.toString();
        const messageText = update.message.text || update.message.caption;

        if (messageText) {
            console.log(`[HTTP Webhook] Received Telegram message from chat ${chatId}: "${messageText}"`);
            try {
                // Call the MCP tool to process the incoming Telegram message
                await mcpServer.callTool('receive_telegram_message', {
                    chat_id: chatId,
                    user_id: userId,
                    text: messageText
                });
                console.log(`[HTTP Webhook] 'receive_telegram_message' tool called successfully.`);
            } catch (error) {
                console.error(`[HTTP Webhook] Error calling 'receive_telegram_message' MCP tool:`, error);
                // Even if internal error, still send 200 OK to Telegram to avoid retries
            }
        } else {
            console.log(`[HTTP Webhook] Received non-text message type, ignoring for now.`);
        }
    } else {
        console.log(`[HTTP Webhook] Received Telegram update without message content.`);
    }
});

// Start the Express HTTP server
app.listen(httpPort, () => {
    console.log(`[HTTP Server] Listening for webhooks on port ${httpPort} at path ${WEBHOOK_PATH}`);
    // Set the Telegram webhook to *this* server's public URL
    const publicRenderUrl = process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : `http://localhost:${httpPort}`;
    const webhookUrl = `${publicRenderUrl}${WEBHOOK_PATH}`;

    bot.telegram.setWebhook(webhookUrl).then(() => {
        console.log(`[Telegram] Webhook set to ${webhookUrl}`);
    }).catch(e => console.error("[Telegram] Error setting webhook:", e));
});

process.once('SIGINT', () => { bot.stop('SIGINT'); console.log('Shutting down...'); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); console.log('Shutting down...'); });

console.log(`[Server] AI Swarm Gateway server started. Listening for TCP connections on port ${tcpPort} and HTTP on ${httpPort}.`);
