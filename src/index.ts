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
if (!TELEGRAM_BOT_TOKEN) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN in environment variables");
}
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// --- Google Gemini API Setup ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  throw new Error("Missing GEMINI_API_KEY in environment variables");
}
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-pro" });

// --- Global State for Chat ID Mapping ---
const activeChats = new Map<string, string>(); // Maps userId to chatId

// --- Set up Communication Transports ---
const tcpPort = parseInt(process.env.TCP_PORT || '8080');
const netServerTransport = new NetServerTransport(tcpPort, mcpServer); // Initialize NetServerTransport

// IMPORTANT: Connect MCP Server Transport *before* defining handlers that use it
await mcpServer.connect(netServerTransport); // This sets mcpServer.transport

// --- NOW Define Handler function for receiving Telegram messages ---
// This function can now safely access mcpServer.transport
const handleReceiveTelegramMessage = async ({
  chat_id,
  user_id,
  text
}: {
  chat_id: string;
  user_id: string;
  text: string;
}) => {
  console.log(`[MCP Tool: receive_telegram_message] Received from Telegram: Chat ID ${chat_id}, User ID ${user_id}, Text: "${text}"`);

  activeChats.set(user_id, chat_id);

  const messageForPhone = {
    type: 'telegram_input',
    chat_id,
    user_id,
    text
  };

  // mcpServer.transport is guaranteed to be defined here now!
  (mcpServer.transport as NetServerTransport).sendToAllPhones(messageForPhone);

  return {
    content: [{ type: "text", text: `Message for chat ${chat_id} received and forwarded to phone swarm.` }]
  };
};

// --- MCP Tools ---

// 1. receive_telegram_message tool - NOW define it AFTER handleReceiveTelegramMessage
mcpServer.tool(
  'receive_telegram_message',
  'Receive an incoming message from Telegram, forward to phones.',
  {
    chat_id: z.string().describe("Telegram chat ID"),
    user_id: z.string().describe("Telegram user ID"),
    text: z.string().describe("Message text")
  },
  handleReceiveTelegramMessage // This function is now fully defined and ready
);

// 2. send_telegram_message tool (no changes needed for this one's definition)
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
    } catch (error: any) {
      console.error(`[MCP Tool: send_telegram_message] Error sending to Telegram chat ${chat_id}:`, error);
      return { content: [{ type: "text", text: `Error sending message: ${error.message}` }] };
    }
  }
);

// 3. gemini_chat tool (no changes needed for this one's definition)
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
    } catch (error: any) {
      console.error(`[MCP Tool: gemini_chat] Error calling Gemini API:`, error);
      return { content: [{ type: "text", text: `Error from Gemini: ${error.message}` }] };
    }
  }
);


// --- Telegram Bot Handlers (can now be defined/placed anywhere after handleReceiveTelegramMessage) ---
bot.on('message', async (ctx) => {
  const userId = ctx.from?.id?.toString();
  const chatId = ctx.chat?.id?.toString();
  const messageText = ctx.message?.text || ctx.message?.caption;

  if (!userId || !chatId) {
    console.warn("[Telegram Bot] Missing userId or chatId in message context, ignoring.");
    return;
  }

  if (messageText) {
    console.log(`[Telegram Bot] Received message from chat ${chatId}: "${messageText}"`);
    try {
      await handleReceiveTelegramMessage({
        chat_id: chatId,
        user_id: userId,
        text: messageText
      });
      console.log(`[Telegram Bot] 'receive_telegram_message' handler executed successfully.`);
    } catch (error) {
      console.error(`[Telegram Bot] Error calling 'receive_telegram_message' handler:`, error);
    }
  } else {
    console.log(`[Telegram Bot] Received non-text message, ignoring.`);
  }
});

bot.start((ctx) => ctx.reply('Welcome to AI Swarm Gateway! Send me a message.'));


// --- Express HTTP Server for Telegram Webhook ---
const app = express();
app.use(express.json());

const httpPort = parseInt(process.env.PORT || '3000');
const WEBHOOK_PATH = `/telegram-webhook`;

app.post(WEBHOOK_PATH, async (req, res) => {
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
