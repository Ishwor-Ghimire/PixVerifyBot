# PixVerifyBot

Production-ready Telegram bot for Google One verification link generation.

## Features

- **Link Generation** (`/run`) — Conversational flow to generate Google One trial links via external API
- **Credit System** — Built-in user credit balance with atomic reservation/refund
- **Payment** — Modular payment system (plug in Stripe, crypto, or manual)
- **History** — Paginated generation history per user
- **Queue Monitoring** — Real-time queue and device status
- **Health Checks** — Admin-only API health monitoring
- **Rate Limiting** — Per-user abuse prevention
- **Auto-Registration** — Users registered on first interaction

## Quick Start

### Prerequisites

- Node.js 18+ 
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- An API key for the Google One generation service

### Setup

```bash
# Clone and enter project
cd PixVerifyBot

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your values
```

### Required `.env` Values

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `EXTERNAL_API_KEY` | Google One API key (`ak_XXXX-...`) |
| `ADMIN_USER_IDS` | Your Telegram user ID (comma-separated for multiple) |
| `COMMUNITY_LINK` | Your community channel/group link |
| `SUPPORT_CONTACT` | Support username or link |

### Run

```bash
# Production
npm start

# Development (auto-restart on changes)
npm run dev
```

## Commands

| Command | Description | Access |
|---|---|---|
| `/start` | Welcome + registration | All |
| `/run` | Generate verification link | All |
| `/balance` | Check credit balance | All |
| `/buy` | Purchase credits | All |
| `/myhistory` | View generation history | All |
| `/queue` | Queue status | All |
| `/community` | Community link | All |
| `/support` | Support contact | All |
| `/menu` | Main menu with buttons | All |
| `/help` | Usage guide | All |
| `/health` | API health status | Admin |

## Project Structure

```
PixVerifyBot/
├── src/
│   ├── bot/
│   │   ├── index.js               # Bot init + handler registration
│   │   ├── handlers/              # One file per command
│   │   └── middleware/            # Auth, rate limit, admin
│   ├── services/                  # Business logic layer
│   ├── api/                       # External API client
│   ├── db/
│   │   ├── database.js            # SQLite connection
│   │   ├── migrations.js          # Schema
│   │   └── models/                # User, Generation, Purchase
│   ├── config/                    # Environment config
│   └── utils/                     # Logger, helpers, constants
├── data/                          # SQLite DB + logs (gitignored)
├── index.js                       # Entry point
├── .env.example                   # Config template
└── README.md
```

## Extending

### Adding a Payment Provider

Edit `src/services/paymentService.js`:
- Implement `createOrder()` to initiate payment with your provider
- Implement `confirmPayment()` for webhook/callback handling
- Credit addition is handled automatically via `CreditService`

### Swapping the External API

Edit `src/api/googleOneClient.js`:
- Modify request/response handling
- Update polling logic if needed
- Error codes are mapped in `src/bot/handlers/run.js`

### Adding Admin Commands

1. Create handler in `src/bot/handlers/`
2. Use `User.isAdmin()` or the `adminOnly` middleware
3. Register in `src/bot/index.js`

## Deployment

### PM2 (Recommended)

```bash
npm install -g pm2
pm2 start index.js --name pixverifybot
pm2 save
pm2 startup
```

### Docker

Create a `Dockerfile`:
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN mkdir -p data/logs
CMD ["node", "index.js"]
```

```bash
docker build -t pixverifybot .
docker run -d --env-file .env -v ./data:/app/data pixverifybot
```

## Database

SQLite with WAL mode. Database file is stored at `./data/pixverify.db`.

### Tables
- **users** — Telegram user profiles, admin flag, credit balance
- **generations** — Link generation history with status tracking
- **purchases** — Credit purchase transaction records

## License

UNLICENSED — Private project.
