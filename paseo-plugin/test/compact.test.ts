import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPercentShort, formatShortCountdown } from "../shared/format.ts";
import { SESSION_WINDOW_MS, WEEKLY_WINDOW_MS, elapsedPercent, paceTone } from "../shared/pace.ts";

const NOW = 1_800_000_000_000;
const M = 60_000, H = 60 * M, D = 24 * H;

test("short countdown matches the tile format", () => {
  assert.equal(formatShortCountdown(NOW + H + 33 * M, NOW), "1h 33m");
  assert.equal(formatShortCountdown(NOW + 4 * D + 11 * H + 5 * M, NOW), "4d 11h");
  assert.equal(formatShortCountdown(NOW + 33 * M, NOW), "33m");
  assert.equal(formatShortCountdown(NOW + 45_000, NOW), "45s");
  assert.equal(formatShortCountdown(NOW - 1, NOW), "ya");
  assert.equal(formatShortCountdown(null, NOW), "—");
});

test("whole percent, unknown stays a dash", () => {
  assert.equal(formatPercentShort(2), "2%");
  assert.equal(formatPercentShort(54.6), "55%");
  assert.equal(formatPercentShort(null), "—");
});

test("elapsed share of the window comes from the reset instant, clamped", () => {
  assert.equal(elapsedPercent(NOW + H + 33 * M, SESSION_WINDOW_MS, NOW), 69); // 1h33m left of 5h
  assert.equal(elapsedPercent(NOW + 4 * D + 11 * H, WEEKLY_WINDOW_MS, NOW), 36); // 4d11h left of 7d
  assert.equal(elapsedPercent(NOW - H, SESSION_WINDOW_MS, NOW), 100);
  assert.equal(elapsedPercent(NOW + 9 * D, WEEKLY_WINDOW_MS, NOW), 0);
  assert.equal(elapsedPercent(null, SESSION_WINDOW_MS, NOW), null);
});

test("pace tone reproduces the reference screenshot", () => {
  assert.equal(paceTone(55, 36), "ahead"); // CTO 7d: orange
  assert.equal(paceTone(94, 99), "series"); // Ojueguen 7d: purple
  assert.equal(paceTone(100, 79), "exhausted"); // CCastillo 7d: red
  assert.equal(paceTone(64, 63), "series");
  assert.equal(paceTone(2, 69), "series"); // low session use is never a warning
  assert.equal(paceTone(20, 0), "series"); // below 25 % nothing is "ahead"
  assert.equal(paceTone(null, 50), "unknown");
});
