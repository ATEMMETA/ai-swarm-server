import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Telegraf } from "telegraf";
import { NetServerTransport } from './NetServerTransport.js';
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';
import express from 'express';

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

// --- Global State for Chat ID Mapping ---
const activeChats = new Map<string, string>();

// --- MCP Tools ---

// Tool to receive Telegram messages and forward to phones
mcpServer.tool(
  'receive_telegram_message',
  'Receive an incoming message from Telegram, forward to phones.',
  {
    chat_id: z.string().describe("Telegram chat ID"),
    user_id: z.string().describe("Telegram user ID"),
    text: z.string().describe("Message text")
  },
  async ({ chat_id, user_id, text }) => {
    console.log(`[MCP Tool: receive_telegram_message] From Telegram: Chat ID ${chat_id}, User ID ${user_id}, Text: "${text}"`);
    activeChats.set(user_id, chat_id);

    const messageForPhone = {
      type: 'telegram_input',
      chat_id,
      user_id,
      text
    };

    (mcpServer.transport as NetServerTransport).sendToAllPhones(messageForPhone);

    return {
      content: [{ type: "text", text: `Message for chat ${chat_id} received and forwarded to phone swarm.` }]
    };
  }
);

// Tool for phones to send messages back to Telegram
mcpServer.tool(
  'send_telegram_message',
  'Send a message to a Telegram chat.',
  {
    chat_id: z.string().describe("Telegram chat ID"),
    text: z.string().describe("Message text")
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

// Tool for Google Gemini API chat
mcpServer.tool(
  'gemini_chat',
  'Engage Google Gemini for text generation.',
  {
    prompt: z.string().describe("Prompt for Gemini"),
    model_name: z.string().optional().describe("Optional Gemini model name"),
    system_instruction: z.string().optional().describe("Optional system instruction")
  },
  async ({ prompt, model_name }) => {
    try {
      const currentModel = model_name ? genAI.getGenerativeModel({ model: model_name }) : geminiModel;
      const result = await currentModel.generateContent(prompt);
      const text = result.response.text();
      console.log(`[MCP Tool: gemini_chat] Gemini response: "${text.substring(0, 50)}..."`);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      console.error(`[MCP Tool: gemini_chat] Error calling Gemini API:`, error);
      return { content: [{ type: "text", text: `Error from Gemini: ${error.message}` }] };
    }
  }
);

// --- Telegram Bot Handlers ---

// Register message handler BEFORE webhook processing
bot.on('message', async (ctx) => {
  const userId = ctx.from.id.toString();
  const chatId = ctx.chat.id.toString();
  const messageText = ctx.message['text'] || ctx.message['caption'];

  if (messageText) {
    console.log(`[Telegram Bot] Received message from chat ${chatId}: "${messageText}"`);
    try {
      await mcpServer.callTool('receive_telegram_message', {
        chat_id: chatId,
        user_id: userId,
        text: messageText
      });
      console.log(`[Telegram Bot] 'receive_telegram_message' tool called successfully.`);
    } catch (error) {
      console.error(`[Telegram Bot] Error calling 'receive_telegram_message' MCP tool:`, error);
    }
  } else {
    console.log(`[Telegram Bot] Received non-text message, ignoring.`);
  }
});

// Example command handler
bot.start((ctx) => ctx.reply('Welcome to AI Swarm Gateway! Send me a message.'));

// --- Set up Communication Transports ---

const tcpPort = parseInt(process.env.TCP_PORT || '8080');
const netServerTransport = new NetServerTransport(tcpPort, mcpServer);
await mcpServer.connect(netServerTransport);

// --- Express HTTP Server for Telegram Webhook ---

const app = express();
app.use(express.json());

const httpPort = parseInt(process.env.PORT || '3000');
const WEBHOOK_PATH = `/telegram-webhook`;

app.post(WEBHOOK_PATH, async (req, res) => {
  // Await webhookCallback to ensure processing completes before response
  await bot.webhookCallback(WEBHOOK_PATH)(req, res);
});

app.listen(httpPort, () => {
  console.log(`[HTTP Server] Listening on port ${httpPort} at path ${WEBHOOK_PATH}`);

  const publicRenderUrl = process.env.RENDER_EXTERNAL_HOSTNAME
    ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
    : `http://localhost:${httpPort}`;
  const webhookUrl = `${publicRenderUrl}${WEBHOOK_PATH}`;

  bot.telegram.setWebhook(webhookUrl)
    .then(() => console.log(`[Telegram] Webhook set to ${webhookUrl}`))
    .catch(e => console.error("[Telegram] Error setting webhook:", e));
});

// Graceful shutdown
process.once('SIGINT', () => { bot.stop('SIGINT'); console.log('Shutting down...'); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); console.log('Shutting down...'); });

console.log(`[Server] AI Swarm Gateway started. TCP port: ${tcpPort}, HTTP port: ${httpPort}.`);
