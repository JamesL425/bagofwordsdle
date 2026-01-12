# Embeddle

A multiplayer word deduction game where players try to guess each other's secret words using semantic similarity.

**Play now at [bagofwordsdle.vercel.app](https://bagofwordsdle.vercel.app)**

## How to Play

1. **Setup**: Each player joins a lobby and picks a secret word from a themed word pool
2. **Gameplay**: On your turn, guess any word
3. **Reveal**: Everyone sees how similar your guess is to ALL players' secret words
4. **Elimination**: Guess someone's exact word to eliminate them!
5. **Reward**: Eliminating a player lets you change your own secret word
6. **Win**: Be the last player standing

## Tech Stack

- **Backend**: Python serverless function on Vercel
- **Embeddings**: OpenAI `text-embedding-3-large`
- **Database**: Upstash Redis
- **Frontend**: Vanilla HTML/CSS/JS

## Development

### Prerequisites

- Node.js (for Vercel CLI)
- Python 3.11+
- OpenAI API key
- Upstash Redis account

### Environment Variables

Set these in your Vercel project settings:

```
OPENAI_API_KEY=your-openai-api-key
UPSTASH_REDIS_REST_URL=your-upstash-redis-url
UPSTASH_REDIS_REST_TOKEN=your-upstash-redis-token
```

Optional (for Google OAuth):
```
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
JWT_SECRET=your-jwt-secret
```

### Local Development

1. Install Vercel CLI:
```bash
npm i -g vercel
```

2. Link to your Vercel project and pull environment variables:
```bash
vercel link
vercel env pull
```

3. Run locally:
```bash
vercel dev
```

### Deployment

Push to main branch - Vercel will auto-deploy.

## Project Structure

```
├── api/
│   ├── index.py          # Serverless API handler
│   ├── requirements.txt  # Python dependencies
│   ├── config.json       # Game settings
│   ├── themes.json       # Pre-generated theme word lists
│   └── cosmetics.json    # Cosmetic items catalog
├── frontend/
│   ├── index.html        # Main page
│   ├── style.css         # Styles
│   ├── app.js            # Game logic
│   └── cosmetics.js      # Cosmetics UI
└── vercel.json           # Vercel configuration
```

## Game Rules

- **Players**: 2-6 per game
- **Elimination**: Guess someone's exact word
- **Word change reward**: Earned by eliminating another player

## Strategy Tips

- Pick a word that's unique but not too obscure
- Your guesses reveal info about YOUR word too - be careful!
- Use the similarity percentages to narrow down opponents' words
- If you eliminate someone, consider changing your word to reset their intel on you
