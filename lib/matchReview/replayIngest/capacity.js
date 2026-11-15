// Writable storage counts toward Cloud Run memory; reserve room for processes.
export const REPLAY_MAX_DOWNLOAD_BYTES = 256_000_000;
export const REPLAY_MAX_DEMO_BYTES = 512_000_000;
export const REPLAY_MAX_OUTPUT_BYTES = 1_500_000_000;
export const REPLAY_DISK_BUDGET_BYTES = 3_000_000_000;
export const REPLAY_FILE_OVERHEAD_BYTES = 8_000_000;
export const REPLAY_PROCESS_RESERVE_BYTES = 1_000_000_000;
export const REPLAY_WORKER_MEMORY_BYTES = 4_294_967_296;
export const REPLAY_FILE_RESERVATION_BYTES = REPLAY_MAX_DOWNLOAD_BYTES + REPLAY_MAX_DEMO_BYTES + REPLAY_MAX_OUTPUT_BYTES + REPLAY_FILE_OVERHEAD_BYTES;

export function replayFileReservation({ maxDownload, maxDemo, maxOutput, diskBudget }) {
  for (const [value, ceiling] of [
    [maxDownload, REPLAY_MAX_DOWNLOAD_BYTES], [maxDemo, REPLAY_MAX_DEMO_BYTES],
    [maxOutput, REPLAY_MAX_OUTPUT_BYTES], [diskBudget, REPLAY_DISK_BUDGET_BYTES],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) throw new RangeError('Replay capacity exceeds hard limits');
  }
  const reservation = maxDownload + maxDemo + maxOutput + REPLAY_FILE_OVERHEAD_BYTES;
  if (reservation > diskBudget || diskBudget + REPLAY_PROCESS_RESERVE_BYTES >= REPLAY_WORKER_MEMORY_BYTES) throw new RangeError('Replay capacity exceeds worker memory budget');
  return reservation;
}
