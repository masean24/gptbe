require('dotenv').config();
const mongoose = require('mongoose');

// Connect to MongoDB first, then start everything
async function main() {
    console.log('📦 Connecting to MongoDB Atlas...');
    await mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 10000,
    });
    console.log('✅ MongoDB Connected!');

    // Import bot and register all handlers
    const { bot } = require('./bot/userHandlers');
    const { registerAdminHandlers } = require('./bot/adminHandlers');

    // Register admin commands on the same bot instance
    registerAdminHandlers(bot);

    // Connect notify service to bot (for channel/group webhooks)
    const { setBot } = require('./services/notifyService');
    setBot(bot);

    // Start Express server (for API + webhooks)
    const { startServer } = require('./server');
    startServer(bot);

    // Start the bot
    console.log('🤖 Starting Telegram Bot...');
    bot.start({
        onStart: (info) => console.log(`✅ Bot @${info.username} is running!`),
    }).catch((err) => {
        console.error('❌ Bot failed to start:', err.message);
        console.error('   Check BOT_TOKEN in .env — you may need to revoke and recreate via @BotFather');
    });

    // Resume any stuck queued jobs
    const { processQueue } = require('./services/queueService');
    processQueue();
}

main().catch((err) => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
