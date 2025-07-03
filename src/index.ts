import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Telegraf } from "telegraf"; // A popular wrapper for node-telegram-bot-api
import { NetServerTransport } from './NetServerTransport.js'; // Custom TCP Transport for MCP
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';

dotenv.config(); // Load environment variables

// --- MCP Server Setup ---
const mcpServer = new McpServer({
  name: "AI Swarm Gateway",
  version: "1.0.0",
  description: "Gateway for AI Swarm operations, routing to local phones and external APIs."
});

// --- Telegram Bot Setup ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL; // e.g., your Vercel/Render URL + /webhook
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// --- Google Gemini API Setup ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-pro" }); // Or "gemini-1.5-pro-latest" for higher context/multimodal

// --- Global State for Chat ID Mapping ---
// In a real production app, use a persistent store (Redis, lightweight DB)
// For prototype, a Map is fine, but remember it resets on server restart.
const activeChats = new Map<string, string>(); // Maps userId/chatId to phoneId (if conversation is ongoing with a specific phone)

// --- MCP Tools for Phone Communication ---

// Tool for the Node.js agent to receive messages from Telegram and forward to phones
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
    // This is where the pre-pre-orchestration logic decides which phone to send to.
    // For now, let's assume it sends to a "default" phone or intelligently routes.
    // In a real swarm, you'd query a registry of phones and their capabilities.

    // Store chat_id temporarily for later response
    activeChats.set(user_id, chat_id); // Using user_id as key for simplicity

    // Simulate sending to a phone via TCP (your NetServerTransport needs to implement client sending)
    // In a real scenario, this would involve a client connection to the specific phone
    // For this server, we're building the _server_ part of the TCP connection,
    // so this 'send to phone' part is conceptual for now until the phone connects.
    console.log(`[Server] Forwarding message to phone swarm for processing.`);
    // You'd have a mechanism here to send this data via TCP to the React Native app.
    // Example: `phoneClient.send(JSON.stringify({ type: 'telegram_input', chat_id, user_id, text }));`
    
    // Respond to MCP client (e.g., the local Node.js agent) that it was received.
    return {
      content: [{ type: "text", text: `Message for chat ${chat_id} received and queued for phone processing.` }]
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

// For local testing with MCP Inspector (or if another CLI/tool is an MCP client)
// const stdioTransport = new StdioServerTransport();
// mcpServer.connect(stdioTransport);

// For TCP communication with your phones
const tcpPort = parseInt(process.env.TCP_PORT || '8080'); // Port for phone communication
const netServerTransport = new NetServerTransport(tcpPort, mcpServer); // Custom transport
mcpServer.connect(netServerTransport); // Connect MCP server to this transport

// --- Telegram Webhook Setup ---
bot.start(async (ctx) => {
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat.id.toString();
    console.log(`[Telegram] Bot started by User ID: ${userId}, Chat ID: ${chatId}`);
    // Simulate initial message reception via MCP tool for consistent flow
    // In a real setup, your bot.on('message') handler would do this
    await mcpServer.callTool('receive_telegram_message', { chat_id: chatId, user_id: userId, text: "Hello! AI Swarm is online." });
    ctx.reply('Hello! I am your AI Swarm gateway. How can I help you?');
});

bot.on('message', async (ctx) => {
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat.id.toString();
    const messageText = (ctx.message as any).text || (ctx.message as any).caption; // Handle text or image caption
    
    if (!messageText) {
        ctx.reply("Sorry, I can only process text messages for now.");
        return;
    }

    console.log(`[Telegram] Message from User ID: ${userId}, Chat ID: ${chatId}, Text: "${messageText}"`);

    // Here, the Node.js agent acts as a pre-pre-orchestrator.
    // It calls the `receive_telegram_message` MCP tool defined above.
    // This makes the flow uniform: external input -> MCP tool -> internal processing.
    try {
        const mcpResponse = await mcpServer.callTool('receive_telegram_message', { chat_id: chatId, user_id: userId, text: messageText });
        // The mcpResponse content could be used for immediate feedback to Telegram if needed.
        // For now, assume the phone will handle the actual response via send_telegram_message.
        console.log(`[Telegram Handler] 'receive_telegram_message' tool called successfully.`);
    } catch (error) {
        console.error(`[Telegram Handler] Error calling 'receive_telegram_message' MCP tool:`, error);
        ctx.reply("An error occurred while processing your request. Please try again.");
    }
});

// Set up webhook (for Vercel/Render)
if (TELEGRAM_WEBHOOK_URL) {
    bot.telegram.setWebhook(TELEGRAM_WEBHOOK_URL + '/secret-path-for-webhook').then(() => {
        console.log(`[Telegram] Webhook set to ${TELEGRAM_WEBHOOK_URL}/secret-path-for-webhook`);
    }).catch(e => console.error("Error setting webhook:", e));

    // Handle webhook requests
    // This depends on your web server setup (e.g., Express.js if you add it)
    // For Telegraf with a serverless function, it's often handled implicitly
    // Example for a simple Express server:
    // const express = require('express');
    // const app = express();
    // app.use(bot.webhookCallback('/secret-path-for-webhook'));
    // app.listen(process.env.PORT || 3000, () => console.log('Webhook server running'));
} else {
    // Fallback for local development if no webhook URL is set (uses long polling)
    bot.launch();
    console.log("[Telegram] Bot polling started (no webhook URL configured).");
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

console.log(`[Server] AI Swarm Gateway server started. Listening for Telegram messages.`);
