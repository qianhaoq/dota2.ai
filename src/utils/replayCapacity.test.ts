import { expect, it } from 'vitest';
import * as c from '../../lib/matchReview/replayIngest/capacity.js';

it('reserves full traces within the existing 4Gi worker', () => {
  expect(c).toMatchObject({
    REPLAY_MAX_DOWNLOAD_BYTES: 256_000_000,
    REPLAY_MAX_DEMO_BYTES: 512_000_000,
    REPLAY_MAX_OUTPUT_BYTES: 1_500_000_000,
    REPLAY_DISK_BUDGET_BYTES: 3_000_000_000,
    REPLAY_FILE_OVERHEAD_BYTES: 8_000_000,
    REPLAY_FILE_RESERVATION_BYTES: 2_276_000_000,
    REPLAY_PROCESS_RESERVE_BYTES: 1_000_000_000,
    REPLAY_WORKER_MEMORY_BYTES: 4_294_967_296,
  });
  expect(c.REPLAY_MAX_OUTPUT_BYTES).toBeGreaterThan(512_000_000);
  expect(c.REPLAY_MAX_OUTPUT_BYTES).toBeGreaterThan(509_896_393);
  expect(c.REPLAY_FILE_RESERVATION_BYTES + c.REPLAY_PROCESS_RESERVE_BYTES).toBe(3_276_000_000);
  expect(c.REPLAY_FILE_RESERVATION_BYTES + c.REPLAY_PROCESS_RESERVE_BYTES).toBeLessThan(c.REPLAY_WORKER_MEMORY_BYTES);
  expect(c.REPLAY_FILE_RESERVATION_BYTES).toBeLessThan(c.REPLAY_DISK_BUDGET_BYTES);
  expect(c.REPLAY_DISK_BUDGET_BYTES + c.REPLAY_PROCESS_RESERVE_BYTES).toBeLessThan(c.REPLAY_WORKER_MEMORY_BYTES);
  expect(c.replayFileReservation({
    maxDownload: c.REPLAY_MAX_DOWNLOAD_BYTES,
    maxDemo: c.REPLAY_MAX_DEMO_BYTES,
    maxOutput: c.REPLAY_MAX_OUTPUT_BYTES,
    diskBudget: c.REPLAY_DISK_BUDGET_BYTES,
  })).toBe(c.REPLAY_FILE_RESERVATION_BYTES);
});

it.each([
  { maxDownload: c.REPLAY_MAX_DOWNLOAD_BYTES, maxDemo: c.REPLAY_MAX_DEMO_BYTES, maxOutput: 1_500_000_001, diskBudget: c.REPLAY_DISK_BUDGET_BYTES },
  { maxDownload: 256_000_001, maxDemo: c.REPLAY_MAX_DEMO_BYTES, maxOutput: c.REPLAY_MAX_OUTPUT_BYTES, diskBudget: c.REPLAY_DISK_BUDGET_BYTES },
  { maxDownload: c.REPLAY_MAX_DOWNLOAD_BYTES, maxDemo: 512_000_001, maxOutput: c.REPLAY_MAX_OUTPUT_BYTES, diskBudget: c.REPLAY_DISK_BUDGET_BYTES },
  { maxDownload: c.REPLAY_MAX_DOWNLOAD_BYTES, maxDemo: c.REPLAY_MAX_DEMO_BYTES, maxOutput: c.REPLAY_MAX_OUTPUT_BYTES, diskBudget: 3_294_967_296 },
  { maxDownload: c.REPLAY_MAX_DOWNLOAD_BYTES, maxDemo: c.REPLAY_MAX_DEMO_BYTES, maxOutput: c.REPLAY_MAX_OUTPUT_BYTES, diskBudget: 2_275_999_999 },
  { maxDownload: c.REPLAY_MAX_DOWNLOAD_BYTES, maxDemo: c.REPLAY_MAX_DEMO_BYTES, maxOutput: NaN, diskBudget: c.REPLAY_DISK_BUDGET_BYTES },
  { maxDownload: c.REPLAY_MAX_DOWNLOAD_BYTES, maxDemo: c.REPLAY_MAX_DEMO_BYTES, maxOutput: -1, diskBudget: c.REPLAY_DISK_BUDGET_BYTES },
])('rejects unsafe capacity %j', (limits) => {
  expect(() => c.replayFileReservation(limits)).toThrow(RangeError);
});

it('gives compact-on-read headroom above held traces and the reported rejection', () => {
  expect(c).toMatchObject({
    REPLAY_MAX_STATES_BYTES: 1_500_000_000,
    REPLAY_MAX_EVENT_BYTES: 256_000_000,
    REPLAY_MAX_RETAINED_EVENTS: 250_000,
    REPLAY_MAX_METADATA_BYTES: 8_000_000,
  });
  expect(c.REPLAY_MAX_STATES_BYTES).toBe(c.REPLAY_MAX_OUTPUT_BYTES);
  expect(c.REPLAY_MAX_STATES_BYTES).toBeGreaterThan(600_998_197);
  expect(c.REPLAY_MAX_STATES_BYTES).toBeGreaterThan(429_657_471);
  expect(c.REPLAY_MAX_EVENT_BYTES).toBeGreaterThan(3.8 * 65_798_134);
  expect(c.REPLAY_MAX_RETAINED_EVENTS).toBeGreaterThan(10 * 19_645);
});
