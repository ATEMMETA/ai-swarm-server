// api/telegram-webhook.ts (on Vercel)
import { Telegraf } from 'telegraf';
import { createConnection } from 'net'; // Node's net module for TCP client
import { Buffer } from 'buffer'; // To handle data as buffers

// IMPORTANT: Define this outside the handler for potential warm starts
// but be aware that serverless functions are stateless and connections
// are not guaranteed to persist across invocations.
let tcpClient = null;

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).send('Method Not Allowed');
        return;
    }

    const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // Needed for Telegraf's internal checks if you use webhookCallback
    const RENDER_TCP_SERVER_URL = process.env.RENDER_TCP_SERVER_URL; // e.g., "ai-swarm-server.onrender.com:8080"

    if (!TELEGRAM_BOT_TOKEN || !RENDER_TCP_SERVER_URL) {
        console.error("Missing environment variables for Vercel webhook.");
        res.status(500).send("Server configuration error.");
        return;
    }

    const [host, portStr] = RENDER_TCP_SERVER_URL.split(':');
    const port = parseInt(portStr);

    if (!host || isNaN(port)) {
        console.error("Invalid RENDER_TCP_SERVER_URL format.");
        res.status(500).send("Server configuration error.");
        return;
    }

    try {
        // Telegraf can handle the webhook processing internally
        const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
        await bot.handleUpdate(req.body, res); // This tells Telegraf to process the update and send a 200 OK.

        // Now, forward the raw Telegram update to your Render TCP server
        // Ensure the Render TCP server knows how to parse this
        const rawUpdate = JSON.stringify(req.body) + '\n'; // Add newline for stream parsing

        // Establish TCP connection and send data
        // This needs to be robust for serverless environments (reconnect on each call or pool)
        await new Promise((resolve, reject) => {
            const client = createConnection({ host, port }, () => {
                console.log(`Vercel: Connected to Render TCP server at ${host}:${port}`);
                client.write(rawUpdate);
                client.end(); // End the connection after sending the data
                resolve(true);
            });

            client.on('error', (err) => {
                console.error(`Vercel: TCP connection error to Render: ${err.message}`);
                reject(err);
            });

            client.on('close', () => {
                console.log('Vercel: TCP connection to Render closed.');
            });
        });

        // Telegraf's handleUpdate already sends a response, so no need for res.status(200).send('OK') here.
        // But if you didn't use handleUpdate, you'd send a 200 OK here to Telegram.
        console.log('Vercel: Telegram update forwarded to Render TCP server successfully.');

    } catch (error) {
        console.error('Vercel: Error processing Telegram webhook or forwarding:', error);
        res.status(500).send('Internal Server Error'); // Send 500 if an error occurs
    }
}

