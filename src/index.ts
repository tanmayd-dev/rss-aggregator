import express from 'express';
import path from 'path';
import { router } from './routes.js';

const app = express();
const port = parseInt(process.env.PORT ?? '', 10) || 3000;
// The API is a local service: cron ticks it over loopback. Override HOST only if you
// deliberately want to expose it on the network.
const host = process.env.HOST || '127.0.0.1';

app.use(express.json());

// Register API routes
app.use(router);

// Serve static assets from the frontend build directory
const frontendDistPath = path.join(process.cwd(), 'frontend/dist');
app.use(express.static(frontendDistPath));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

// Wildcard fallback for React Router SPA (serves index.html for client-side routing)
app.get('/*splat', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/feeds')) {
    return next();
  }
  // dotfiles must be allowed because this repo commonly sits under ~/.local:
  // send's default ('ignore') 404s any absolute path containing a dot-directory.
  res.sendFile(path.join(frontendDistPath, 'index.html'), { dotfiles: 'allow' });
});

app.listen(port, host, () => {
  console.log(`[Server] RSS Aggregator Server listening at http://${host}:${port}`);
});
