const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const axios = require('axios');

// Bot configuration
const config = {
    token: 'YMTM3OTU4OTU5NjMyODc1OTMxNg.G1tAiG.xT8eyog7_cMArUMX2x4iOMH5QEgtOaVEqbqe6Y',
    
    // Llama API Configuration (adjust based on your setup)
    llamaApiUrl: 'http://localhost:11434/api/generate', // Ollama default
    // llamaApiUrl: 'https://your-llama-api-endpoint.com/v1/chat/completions', // Alternative API
    
    model: 'llama3.1:8b', // Ollama model name
    // model: 'llama-3.1-8b-instant', // Alternative API model name
    
    // Bot behavior settings
    maxTokens: 500,
    temperature: 0.7,
    systemPrompt: `You are a helpful and friendly Discord chatbot. Keep your responses conversational, engaging, and appropriate for a Discord server. Be concise but informative. You can discuss various topics, help with questions, and engage in casual conversation.`,
    
    // Channel settings
    allowedChannels: [], // Empty = all channels, or specify channel IDs: ['123456789', '987654321']
    botMention: true, // Respond when mentioned
    directMessage: true, // Respond to DMs
    channelChat: false, // Respond to all messages in allowed channels (can be spammy)
    
    // Rate limiting
    userCooldown: 3000, // 3 seconds between requests per user
    maxMessageLength: 2000 // Discord's message limit
};

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ]
});

// Store conversation history and user cooldowns
const conversationHistory = new Map(); // userId -> array of messages
const userCooldowns = new Map(); // userId -> timestamp
const typingUsers = new Set(); // users currently being "typed" to

// Utility functions
function isOnCooldown(userId) {
    const cooldown = userCooldowns.get(userId);
    if (!cooldown) return false;
    
    const timeLeft = cooldown + config.userCooldown - Date.now();
    return timeLeft > 0;
}

function setCooldown(userId) {
    userCooldowns.set(userId, Date.now());
}

function shouldRespond(message) {
    // Don't respond to bots
    if (message.author.bot) return false;
    
    // Always respond to DMs
    if (message.channel.type === 1 && config.directMessage) return true;
    
    // Check if in allowed channels
    if (config.allowedChannels.length > 0 && !config.allowedChannels.includes(message.channel.id)) {
        return false;
    }
    
    // Check if bot was mentioned
    if (config.botMention && message.mentions.has(client.user)) return true;
    
    // Check if should respond to all channel messages
    if (config.channelChat && message.channel.type === 0) return true;
    
    return false;
}

function getConversationHistory(userId, limit = 10) {
    const history = conversationHistory.get(userId) || [];
    return history.slice(-limit);
}

function addToHistory(userId, role, content) {
    if (!conversationHistory.has(userId)) {
        conversationHistory.set(userId, []);
    }
    
    const history = conversationHistory.get(userId);
    history.push({ role, content, timestamp: Date.now() });
    
    // Keep only last 20 messages to prevent memory issues
    if (history.length > 20) {
        history.splice(0, history.length - 20);
    }
}

// Llama API integration
async function generateResponse(prompt, userId) {
    try {
        const history = getConversationHistory(userId);
        
        // Prepare messages for the API
        const messages = [
            { role: 'system', content: config.systemPrompt },
            ...history,
            { role: 'user', content: prompt }
        ];
        
        // Different API formats based on your setup
        const requestData = {
            // Ollama format
            model: config.model,
            prompt: formatPromptForOllama(messages),
            stream: false,
            options: {
                temperature: config.temperature,
                num_predict: config.maxTokens
            }
            
            // Alternative OpenAI-compatible format (uncomment if using different API):
            // model: config.model,
            // messages: messages,
            // max_tokens: config.maxTokens,
            // temperature: config.temperature
        };
        
        const response = await axios.post(config.llamaApiUrl, requestData, {
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json',
                // 'Authorization': 'Bearer YOUR_API_KEY' // If required
            }
        });
        
        // Extract response based on API format
        let aiResponse;
        if (response.data.response) {
            // Ollama format
            aiResponse = response.data.response.trim();
        } else if (response.data.choices && response.data.choices[0]) {
            // OpenAI-compatible format
            aiResponse = response.data.choices[0].message.content.trim();
        } else {
            throw new Error('Unexpected API response format');
        }
        
        // Add to conversation history
        addToHistory(userId, 'user', prompt);
        addToHistory(userId, 'assistant', aiResponse);
        
        return aiResponse;
        
    } catch (error) {
        console.error('❌ Error generating AI response:', error.message);
        
        if (error.code === 'ECONNREFUSED') {
            return "🚫 I'm having trouble connecting to my AI brain right now. Is the Llama server running?";
        } else if (error.response?.status === 429) {
            return "⏳ I'm a bit overwhelmed right now. Please try again in a moment!";
        } else {
            return "🤖 Oops! Something went wrong with my AI processing. Please try again!";
        }
    }
}

// Format messages for Ollama (simple prompt format)
function formatPromptForOllama(messages) {
    let prompt = '';
    
    for (const msg of messages) {
        if (msg.role === 'system') {
            prompt += `System: ${msg.content}\n\n`;
        } else if (msg.role === 'user') {
            prompt += `Human: ${msg.content}\n\n`;
        } else if (msg.role === 'assistant') {
            prompt += `Assistant: ${msg.content}\n\n`;
        }
    }
    
    prompt += 'Assistant: ';
    return prompt;
}

// Split long messages for Discord
function splitMessage(text, maxLength = config.maxMessageLength) {
    if (text.length <= maxLength) return [text];
    
    const messages = [];
    let current = '';
    const sentences = text.split('. ');
    
    for (const sentence of sentences) {
        if ((current + sentence + '. ').length > maxLength) {
            if (current) {
                messages.push(current.trim());
                current = sentence + '. ';
            } else {
                // Sentence is too long, force split
                messages.push(sentence.substring(0, maxLength - 3) + '...');
                current = sentence.substring(maxLength - 3) + '. ';
            }
        } else {
            current += sentence + '. ';
        }
    }
    
    if (current.trim()) {
        messages.push(current.trim());
    }
    
    return messages;
}

// Bot events
client.once('ready', () => {
    console.log(`🤖 ${client.user.tag} AI Chatbot is online!`);
    console.log(`📊 Connected to ${client.guilds.cache.size} servers`);
    console.log(`🧠 Using model: ${config.model}`);
    console.log(`🔗 API endpoint: ${config.llamaApiUrl}`);
    
    // Set bot status
    client.user.setActivity('conversations with humans', { type: 'LISTENING' });
});

// Handle messages
client.on('messageCreate', async (message) => {
    try {
        // Check if should respond
        if (!shouldRespond(message)) return;
        
        // Check cooldown
        if (isOnCooldown(message.author.id)) {
            const cooldownEmbed = new EmbedBuilder()
                .setColor('#FFA500')
                .setDescription('⏳ Please wait a moment before sending another message!');
            
            const cooldownMsg = await message.reply({ embeds: [cooldownEmbed] });
            setTimeout(() => cooldownMsg.delete().catch(() => {}), 3000);
            return;
        }
        
        // Set cooldown
        setCooldown(message.author.id);
        
        // Clean the message content (remove bot mention if present)
        let cleanContent = message.content.replace(/<@!?\d+>/g, '').trim();
        
        if (!cleanContent) {
            cleanContent = "Hello!";
        }
        
        // Show typing indicator
        if (!typingUsers.has(message.author.id)) {
            typingUsers.add(message.author.id);
            message.channel.sendTyping();
            
            // Continue typing every 5 seconds if response takes long
            const typingInterval = setInterval(() => {
                if (typingUsers.has(message.author.id)) {
                    message.channel.sendTyping();
                } else {
                    clearInterval(typingInterval);
                }
            }, 5000);
        }
        
        // Generate AI response
        const aiResponse = await generateResponse(cleanContent, message.author.id);
        
        // Stop typing
        typingUsers.delete(message.author.id);
        
        // Split long responses
        const messageParts = splitMessage(aiResponse);
        
        // Send response(s)
        for (let i = 0; i < messageParts.length; i++) {
            const embed = new EmbedBuilder()
                .setColor('#00D4AA')
                .setDescription(messageParts[i])
                .setFooter({ 
                    text: `🤖 Powered by ${config.model}${messageParts.length > 1 ? ` • Part ${i + 1}/${messageParts.length}` : ''}`,
                    iconURL: client.user.displayAvatarURL()
                });
            
            if (i === 0) {
                await message.reply({ embeds: [embed] });
            } else {
                await message.channel.send({ embeds: [embed] });
            }
            
            // Small delay between parts
            if (i < messageParts.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
    } catch (error) {
        console.error('❌ Error handling message:', error);
        typingUsers.delete(message.author.id);
        
        const errorEmbed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('❌ Error')
            .setDescription('Sorry, I encountered an error while processing your message. Please try again!');
        
        message.reply({ embeds: [errorEmbed] }).catch(() => {});
    }
});

// Slash command for clearing conversation history
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    
    if (interaction.commandName === 'clear-history') {
        conversationHistory.delete(interaction.user.id);
        
        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setDescription('🗑️ Your conversation history has been cleared!');
        
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
});

// Error handling
client.on('error', error => {
    console.error('❌ Discord client error:', error);
});

process.on('unhandledRejection', error => {
    console.error('❌ Unhandled promise rejection:', error);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('🛑 Shutting down gracefully...');
    client.destroy();
    process.exit(0);
});

// Login to Discord
client.login(config.token);

// Export for testing
module.exports = { client, config };