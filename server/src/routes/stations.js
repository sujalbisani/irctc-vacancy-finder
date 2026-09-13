const express = require('express');
const stations = require('../lib/stations');

const router = express.Router();

router.get('/', async (req, res) => {
  const q = req.query.q || '';
  try {
    const results = await stations.search(q, 15);
    res.json({ results });
  } catch (err) {
    res.status(502).json({ error: 'station_search_failed', message: err.message });
  }
});

module.exports = router;
