const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, ApplicationCommandOptionType, ChannelType } = require('discord.js');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

// Configuration
const MOD_ROLE_NAME = "Moderator";
const ADMIN_ROLE_NAME = "Administrator";
const LOG_CHANNEL_NAME = "mod-logs";

// Initialize clients
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration
    ]
});

// Initialize Gemini with correct configuration
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Data storage
const warnings = new Map();
const notes = new Map();
const cases = new Map();
let caseCounter = 1;
const serverConfig = new Map();
const aiModerationEnabled = new Map();

// Slash commands configuration
const commands = [
    {
        name: 'warn',
        description: 'Issue a warning to a user',
        options: [
            {
                name: 'user',
                type: ApplicationCommandOptionType.User,
                description: 'The user to warn',
                required: true
            },
            {
                name: 'reason',
                type: ApplicationCommandOptionType.String,
                description: 'Reason for the warning',
                required: false
            }
        ]
    },
    {
        name: 'mute',
        description: 'Temporarily mute a user',
        options: [
            {
                name: 'user',
                type: ApplicationCommandOptionType.User,
                description: 'The user to mute',
                required: true
            },
            {
                name: 'duration',
                type: ApplicationCommandOptionType.String,
                description: 'Duration (e.g., 1h, 30m)',
                required: true
            },
            {
                name: 'reason',
                type: ApplicationCommandOptionType.String,
                description: 'Reason for the mute',
                required: false
            }
        ]
    },
    {
        name: 'kick',
        description: 'Kick a user from the server',
        options: [
            {
                name: 'user',
                type: ApplicationCommandOptionType.User,
                description: 'The user to kick',
                required: true
            },
            {
                name: 'reason',
                type: ApplicationCommandOptionType.String,
                description: 'Reason for the kick',
                required: false
            }
        ]
    },
    {
        name: 'ban',
        description: 'Ban a user from the server',
        options: [
            {
                name: 'user',
                type: ApplicationCommandOptionType.User,
                description: 'The user to ban',
                required: true
            },
            {
                name: 'days',
                type: ApplicationCommandOptionType.Integer,
                description: 'Days of messages to delete (0-7)',
                required: false,
                min_value: 0,
                max_value: 7
            },
            {
                name: 'reason',
                type: ApplicationCommandOptionType.String,
                description: 'Reason for the ban',
                required: false
            }
        ]
    },
    {
        name: 'ai_scan',
        description: 'Scan recent messages for toxic content using Gemini',
        options: [
            {
                name: 'channel',
                type: ApplicationCommandOptionType.Channel,
                description: 'Channel to scan',
                required: false,
                channel_types: [ChannelType.GuildText]
            },
            {
                name: 'limit',
                type: ApplicationCommandOptionType.Integer,
                description: 'Number of messages to scan (1-25)',
                required: false,
                min_value: 1,
                max_value: 25
            }
        ]
    },
    {
        name: 'ai_analyze',
        description: 'Analyze a specific message using Gemini',
        options: [
            {
                name: 'message_id',
                type: ApplicationCommandOptionType.String,
                description: 'ID of the message to analyze',
                required: true
            }
        ]
    },
    {
        name: 'ai_toggle',
        description: 'Enable or disable AI auto-moderation',
        options: [
            {
                name: 'status',
                type: ApplicationCommandOptionType.String,
                description: 'Enable or disable AI moderation',
                required: true,
                choices: [
                    { name: 'Enable', value: 'enable' },
                    { name: 'Disable', value: 'disable' }
                ]
            }
        ]
    },
    {
        name: 'ping',
        description: 'Check bot latency'
    }
];

// Helper functions
async function getModChannel(guild) {
    if (serverConfig.has(guild.id) && serverConfig.get(guild.id).log_channel) {
        return guild.channels.cache.get(serverConfig.get(guild.id).log_channel);
    }
    return guild.channels.cache.find(ch => ch.name === LOG_CHANNEL_NAME);
}

async function logAction(action, moderator, target, reason = null, duration = null) {
    const channel = await getModChannel(moderator.guild);
    if (!channel) return;

    const embed = new EmbedBuilder()
        .setTitle(`Case #${caseCounter} | ${action}`)
        .setColor(0x0099FF)
        .setTimestamp()
        .addFields(
            { name: 'Moderator', value: moderator.toString(), inline: true },
            { name: 'Target', value: target.toString(), inline: true }
        );

    if (reason) embed.addFields({ name: 'Reason', value: reason, inline: false });
    if (duration) embed.addFields({ name: 'Duration', value: duration, inline: true });

    await channel.send({ embeds: [embed] });
}

async function hasModPerms(member) {
    if (member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return true;
    return member.roles.cache.some(role => [MOD_ROLE_NAME, ADMIN_ROLE_NAME].includes(role.name));
}

async function hasAdminPerms(member) {
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
    return member.roles.cache.some(role => role.name === ADMIN_ROLE_NAME);
}

async function canTargetUser(moderator, target) {
    if (moderator.id === target.id) return { can: false, error: "You cannot moderate yourself." };
    if (moderator.roles.highest.position <= target.roles.highest.position && moderator.id !== moderator.guild.ownerId) {
        return { can: false, error: "You cannot moderate users with equal or higher roles." };
    }
    if (target.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return { can: false, error: "You cannot moderate administrators." };
    }
    return { can: true, error: null };
}

async function aiAnalyzeText(text) {
    try {
        // Use the latest model name - try different versions
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash-latest", // Try this first
            // model: "gemini-pro", // Fallback
            generationConfig: {
                maxOutputTokens: 150,
                temperature: 0.1
            }
        });

        const prompt = `Analyze this Discord message for moderation. Respond ONLY with valid JSON, no other text:

{
  "verdict": "SAFE" or "FLAG",
  "scores": {
    "toxicity": 0.0-1.0,
    "hate_speech": 0.0-1.0,
    "spam": 0.0-1.0,
    "harassment": 0.0-1.0
  }
}

Message: "${text.substring(0, 500)}"`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        let analysisText = response.text().trim();
        
        // Clean response - remove markdown code blocks
        analysisText = analysisText.replace(/```json|```/g, '').trim();
        
        // Parse JSON
        const analysis = JSON.parse(analysisText);
        
        // Validate response structure
        if (analysis && analysis.verdict && analysis.scores) {
            return analysis;
        }
        
        return null;
    } catch (error) {
        console.error('Gemini API error:', error.message);
        
        // Try with different model if first fails
        if (error.message.includes('not found') || error.status === 404) {
            console.log('Trying with gemini-pro model...');
            try {
                const model = genAI.getGenerativeModel({ 
                    model: "gemini-1.5-flash-8b",
                    generationConfig: {
                        maxOutputTokens: 150,
                        temperature: 0.1
                    }
                });
                
                const result = await model.generateContent(`Analyze: "${text.substring(0, 300)}" - Respond with JSON: {"verdict":"SAFE/FLAG","scores":{"toxicity":0.0,"hate_speech":0.0,"spam":0.0,"harassment":0.0}}`);
                const response = await result.response;
                let analysisText = response.text().trim();
                analysisText = analysisText.replace(/```json|```/g, '').trim();
                return JSON.parse(analysisText);
            } catch (fallbackError) {
                console.error('Fallback model also failed:', fallbackError.message);
                return null;
            }
        }
        
        return null;
    }
}

// Register slash commands
async function registerCommands() {
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Slash commands registered!');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
}

// Event handlers
client.once('ready', () => {
    console.log(`✅ Bot logged in as ${client.user.tag}`);
    console.log('🎯 Using FREE Gemini API for moderation');
    registerCommands();
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const { commandName, options, member, guild } = interaction;

    try {
        switch (commandName) {
            case 'warn':
                if (!await hasModPerms(member)) {
                    return interaction.reply({ content: "❌ No permission.", ephemeral: true });
                }

                const user = options.getUser('user');
                const reason = options.getString('reason') || 'No reason provided';
                const targetMember = await guild.members.fetch(user.id);

                const canAct = await canTargetUser(member, targetMember);
                if (!canAct.can) return interaction.reply({ content: canAct.error, ephemeral: true });

                if (!warnings.has(user.id)) warnings.set(user.id, []);
                warnings.get(user.id).push({ moderator: member.id, reason, timestamp: new Date().toISOString() });

                cases.set(caseCounter, { action: 'warn', moderator: member.id, target: user.id, reason, timestamp: new Date().toISOString() });

                await logAction('Warn', member, user, reason);
                await interaction.reply(`⚠️ ${user} warned. Reason: ${reason}`);
                caseCounter++;
                break;

            case 'ai_scan':
                if (!await hasAdminPerms(member)) {
                    return interaction.reply({ content: "❌ Admin only.", ephemeral: true });
                }

                const channel = options.getChannel('channel') || interaction.channel;
                const limit = Math.min(options.getInteger('limit') || 15, 25);

                await interaction.deferReply({ ephemeral: true });

                const messages = await channel.messages.fetch({ limit });
                const flagged = [];

                for (const message of messages.values()) {
                    if (message.author.bot) continue;
                    
                    const analysis = await aiAnalyzeText(message.content);
                    if (analysis?.verdict === 'FLAG') {
                        flagged.push({ message, analysis });
                    }
                    
                    // Rate limiting for free tier
                    await new Promise(resolve => setTimeout(resolve, 200));
                }

                if (flagged.length > 0) {
                    let report = `🔍 Found ${flagged.length} flagged messages:\n`;
                    for (const item of flagged.slice(0, 5)) {
                        const highScores = Object.entries(item.analysis.scores)
                            .filter(([_, score]) => score > 0.6)
                            .map(([key]) => key);
                        report += `- ${item.message.author}: "${item.message.content.slice(0, 50)}..." (${highScores.join(', ')})\n`;
                    }
                    await interaction.editReply(report);
                } else {
                    await interaction.editReply("✅ No problematic messages found.");
                }
                break;

            case 'ai_analyze':
                const messageId = options.getString('message_id');
                try {
                    const message = await interaction.channel.messages.fetch(messageId);
                    await interaction.deferReply();

                    const analysis = await aiAnalyzeText(message.content);
                    
                    if (analysis) {
                        const embed = new EmbedBuilder()
                            .setTitle('🧠 AI Analysis')
                            .setColor(analysis.verdict === 'SAFE' ? 0x00FF00 : 0xFF0000)
                            .addFields({ name: 'Verdict', value: analysis.verdict, inline: true });

                        for (const [category, score] of Object.entries(analysis.scores)) {
                            embed.addFields({
                                name: category.toUpperCase(),
                                value: `${(score * 100).toFixed(0)}%`,
                                inline: true
                            });
                        }

                        await interaction.editReply({ embeds: [embed] });
                    } else {
                        await interaction.editReply("❌ Analysis failed. Check API key and model availability.");
                    }
                } catch {
                    await interaction.reply({ content: "❌ Message not found.", ephemeral: true });
                }
                break;

            case 'ai_toggle':
                if (!await hasAdminPerms(member)) {
                    return interaction.reply({ content: "❌ Admin only.", ephemeral: true });
                }

                const status = options.getString('status');
                aiModerationEnabled.set(guild.id, status === 'enable');
                await interaction.reply({ content: `✅ AI moderation ${status}d.`, ephemeral: true });
                break;

            case 'ping':
                await interaction.reply({ content: `🏓 Pong! ${Math.round(client.ws.ping)}ms`, ephemeral: true });
                break;

            default:
                await interaction.reply({ content: "⚡ Command ready!", ephemeral: true });
        }
    } catch (error) {
        console.error('Command error:', error);
        await interaction.reply({ content: "❌ Error executing command.", ephemeral: true });
    }
});

// Auto-moderation
client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild || message.content.startsWith('/')) return;
    if (!(aiModerationEnabled.get(message.guild.id) ?? true)) return;

    try {
        const analysis = await aiAnalyzeText(message.content);
        
        if (analysis?.verdict === 'FLAG') {
            const logChannel = await getModChannel(message.guild);
            if (logChannel) {
                const embed = new EmbedBuilder()
                    .setTitle('🚨 Flagged Message')
                    .setDescription(message.content.slice(0, 1000))
                    .setColor(0xFF0000)
                    .addFields(
                        { name: 'Author', value: message.author.toString(), inline: true },
                        { name: 'Channel', value: message.channel.toString(), inline: true }
                    );

                await logChannel.send({ embeds: [embed] });
                try {
                    await message.react('⚠️');
                } catch (e) {
                    console.log('Could not add reaction');
                }
            }
        }
    } catch (error) {
        console.error('Auto-mod error:', error.message);
    }
});

// Error handling
client.on('error', console.error);

// Login with error handling
client.login(process.env.DISCORD_TOKEN).catch(error => {
    console.error('Login failed:', error.message);
    console.log('Please check your DISCORD_TOKEN in the .env file');
});
