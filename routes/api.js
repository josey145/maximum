// ── Add this route to your main app router (e.g. routes/api.js or app.js) ──
// GET /api/rate?from=USD&to=PHP
// Used by the investments page JS to show live converted preview amounts.

const express = require('express');
const router  = express.Router();
const { resolveRate } = require('../utils/currency');

router.get('/rate', async (req, res) => {
    try {
        const from = (req.query.from || 'USD').toUpperCase();
        const to   = (req.query.to   || 'USD').toUpperCase();

        if (from === to) return res.json({ rate: 1, from, to });

        const rate = await resolveRate(from, to);

        if (rate === null) {
            return res.status(404).json({ error: `Rate not available for ${from} → ${to}` });
        }

        res.json({ rate, from, to });
    } catch (err) {
        console.error('Rate API error:', err);
        res.status(500).json({ error: 'Failed to fetch rate' });
    }
});

module.exports = router;

// ── In app.js, mount it: ─────────────────────────────────────────────────────
// const apiRouter = require('./routes/api');
// app.use('/api', apiRouter);