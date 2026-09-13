const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const stationsRoute = require('./routes/stations');
const searchRoute = require('./routes/search');
const irctcChart = require('./lib/irctcChart');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/stations', stationsRoute);
app.use('/api/search', searchRoute);

// In production, the client is built into client/dist and served from this
// same process/port -- keeps deployment to a single service.
const clientDist = path.join(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

const server = app.listen(PORT, () => {
  console.log(`IRCTC vacancy server listening on http://localhost:${PORT}`);
});

async function shutdown() {
  console.log('Shutting down...');
  await irctcChart.closeBrowser();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
