// ════════════════════════════════════════════════════════
// ADD THESE TWO LINES near the bottom of your existing index.js
// ────────────────────────────────────────────────────────
// (anywhere after `admin.initializeApp();` — the order does not
//  matter as long as it's at module-top scope, not inside another
//  function)
// ════════════════════════════════════════════════════════

// ── NEW: Google Sheets archive (daily 06:00 IST + manual trigger) ──
const sheetsSync = require('./sheetsSync');
exports.archiveToSheets = sheetsSync.archiveToSheets;
exports.manualArchive   = sheetsSync.manualArchive;
