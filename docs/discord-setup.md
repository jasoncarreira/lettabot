# Discord Setup for LettaBot

This guide walks you through setting up Discord as a channel for LettaBot.

## Overview

LettaBot connects to Discord using a **Bot Application** with the Gateway API:
- No public URL required (uses WebSocket connection)
- Works behind firewalls
- Real-time bidirectional communication

## Prerequisites

- A Discord server where you have permission to add bots
- LettaBot installed and configured with at least `LETTA_API_KEY`

## Step 1: Create a Discord Application

1. Go to **https://discord.com/developers/applications**
2. Click **"New Application"**
3. Enter a name (e.g., `LettaBot`)
4. Click **"Create"**

## Step 2: Create the Bot

1. In the left sidebar, click **"Bot"**
2. Click **"Reset Token"** (or "Add Bot" if this is new)
3. **Copy the token** - this is your `DISCORD_BOT_TOKEN`

   > **Important**: You can only see this token once. If you lose it, you'll need to reset it.

## Step 3: Enable Message Content Intent

This is required for the bot to read message content.

1. Still in the **"Bot"** section
2. Scroll down to **"Privileged Gateway Intents"**
3. Enable **"MESSAGE CONTENT INTENT"**
4. Click **"Save Changes"**

## Step 4: Generate Invite URL

1. In the left sidebar, go to **"OAuth2"** → **"URL Generator"**
2. Under **"Scopes"**, select:
   - `bot`
3. Under **"Bot Permissions"**, select:
   - `Send Messages`
   - `Read Message History`
   - `View Channels`
4. Copy the generated URL at the bottom

Or use this URL template (replace `YOUR_CLIENT_ID`):
```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=68608&scope=bot
```

> **Tip**: Your Client ID is in **"General Information"** or in the URL when viewing your app.

## Step 5: Add Bot to Your Server

1. Open the invite URL from Step 4 in your browser
2. Select the server you want to add the bot to
3. Click **"Authorize"**
4. Complete the CAPTCHA if prompted

You should see `[Bot Name] has joined the server` in Discord.

## Step 6: Configure LettaBot

Run the onboarding wizard and select Discord:

```bash
lettabot onboard
```

Or add directly to your `lettabot.yaml`:

```yaml
channels:
  discord:
    enabled: true
    token: "your-bot-token-here"
    dmPolicy: pairing  # or 'allowlist' or 'open'
```

## Step 7: Start LettaBot

```bash
lettabot server
```

You should see:
```
Registered channel: Discord
[Discord] Connecting...
[Discord] Bot logged in as YourBot#1234
[Discord] DM policy: pairing
```

## Step 8: Test the Integration

### In a Server Channel
1. Go to a text channel in your Discord server
2. Type `@YourBot hello!`
3. The bot should respond

### Direct Message
1. Right-click on the bot in the server member list
2. Click **"Message"**
3. Send a message: `Hello!`
4. The bot should respond (may require pairing approval first)

## Access Control

LettaBot supports three DM policies for Discord:

### Pairing (Recommended)
```yaml
dmPolicy: pairing
```
- New users receive a pairing code
- Approve with: `lettabot pairing approve discord <CODE>`
- Most secure for personal use

### Allowlist
```yaml
dmPolicy: allowlist
allowedUsers:
  - "123456789012345678"  # Discord user IDs
```
- Only specified users can interact
- Find user IDs: Enable Developer Mode in Discord settings, then right-click a user → "Copy User ID"

### Open
```yaml
dmPolicy: open
```
- Anyone can message the bot
- Not recommended for personal bots

## Adding Reactions

LettaBot can react to messages using the `lettabot-react` CLI:

```bash
# React to the most recent message
lettabot-react add --emoji ":eyes:"

# React to a specific message
lettabot-react add --emoji ":thumbsup:" --channel discord --chat 123456789 --message 987654321
```

## Troubleshooting

### Bot shows as offline

1. Make sure LettaBot is running (`lettabot server`)
2. Check for errors in the console
3. Verify your bot token is correct

### Bot doesn't respond to messages

1. **Check MESSAGE CONTENT INTENT** is enabled:
   - Discord Developer Portal → Your App → Bot → Privileged Gateway Intents
   - Toggle ON "MESSAGE CONTENT INTENT"

2. **Check bot has permissions** in the channel:
   - Server Settings → Roles → Your Bot's Role
   - Or check channel-specific permissions

3. **Check pairing status** if using pairing mode:
   - New users need to be approved via `lettabot pairing list`

### "0 Servers" in Developer Portal

The bot hasn't been invited to any servers yet. Use the invite URL from Step 4.

### Bot can't DM users

Discord bots can only DM users who:
- Share a server with the bot, OR
- Have previously DM'd the bot

This is a Discord limitation, not a LettaBot issue.

### Rate limiting

If the bot stops responding temporarily, it may be rate-limited by Discord. Wait a few minutes and try again. Avoid sending many messages in quick succession.

## Security Notes

- **Bot tokens** should be kept secret - never commit them to git
- Use `dmPolicy: pairing` or `allowlist` in production
- The bot can only see messages in channels it has access to
- DMs are only visible between the bot and that specific user

## Cross-Channel Memory

Since LettaBot uses a single agent across all channels:
- Messages you send on Discord continue the same conversation as Telegram/Slack
- The agent remembers context from all channels
- You can start a conversation on Telegram and continue it on Discord

## Next Steps

- [Slack Setup](./slack-setup.md)
- [WhatsApp Setup](./whatsapp-setup.md)
- [Signal Setup](./signal-setup.md)
