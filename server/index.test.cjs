const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseLimitLine,
  parseCodexStatusSnapshotText,
  buildEffectiveQuota,
  formatResetLabelFromEpoch
} = require('./index.js');

test('parseLimitLine converts epoch reset labels to human-readable local label', () => {
  const epoch = Math.floor(Date.now() / 1000) + 3600;
  const parsed = parseLimitLine(`5h 22% ${epoch}`);
  assert.ok(parsed);
  assert.equal(parsed.remainingPercent, 22);
  assert.equal(typeof parsed.resetLabel, 'string');
  assert.ok(parsed.resetLabel.length > 0);
  assert.notEqual(parsed.resetLabel, String(epoch));
});

test('parseCodexStatusSnapshotText parses kv snapshot and normalizes epoch reset labels', () => {
  const epoch5h = Math.floor(Date.now() / 1000) + 1800;
  const epochWeekly = Math.floor(Date.now() / 1000) + 86400;
  const snapshot = [
    'source=codex_local_sessions',
    '5h_remaining_percent=23',
    '5h_used_percent=77',
    `5h_resets_at=${epoch5h}`,
    'weekly_remaining_percent=76',
    'weekly_used_percent=24',
    `weekly_resets_at=${epochWeekly}`
  ].join('\n');

  const parsed = parseCodexStatusSnapshotText(snapshot);
  assert.ok(parsed);
  assert.equal(parsed.fiveHour.remainingPercent, 23);
  assert.equal(parsed.weekly.remainingPercent, 76);
  assert.equal(typeof parsed.fiveHour.resetLabel, 'string');
  assert.equal(typeof parsed.weekly.resetLabel, 'string');
});

test('buildEffectiveQuota prioritizes canonical status.json effective quota payload', () => {
  const statusQuota = {
    source: 'codex_status_snapshot',
    five_hour: {
      status: 'ok',
      remaining_percent: 55,
      used_percent: 45,
      resets_at_epoch: Math.floor(Date.now() / 1000) + 1200
    },
    weekly: {
      status: 'ok',
      remaining_percent: 70,
      used_percent: 30,
      resets_at_epoch: Math.floor(Date.now() / 1000) + 86400
    }
  };

  const result = buildEffectiveQuota(null, null, null, statusQuota);
  assert.equal(result.source, 'codex_status_snapshot');
  assert.equal(result.fiveHour.remainingPercent, 55);
  assert.equal(result.weekly.remainingPercent, 70);
});

test('formatResetLabelFromEpoch returns null for invalid values', () => {
  assert.equal(formatResetLabelFromEpoch(null), null);
  assert.equal(formatResetLabelFromEpoch('bad'), null);
  assert.equal(formatResetLabelFromEpoch(0), null);
});
