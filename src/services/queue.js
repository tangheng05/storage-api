const logger = require('./logger');

// Minimal in-process FIFO, concurrency 1 *per lane*.
//
// Lanes are strictly about head-of-line blocking between cheap and expensive
// work — a 200ms WebP conversion must not sit behind a 30-minute HEVC
// transcode. They are NOT extra processes: the single-instance rule still
// holds and this is all one event loop.

const MEDIA_LANE = 'media'; // ffmpeg: video remux/transcode, audio transcode
const IMAGE_LANE = 'image'; // sharp: fast, must not wait behind the above
// Retrying storage pushes that failed earlier: background durability work that
// must never sit in front of a live upload.
const PUBLISH_LANE = 'sia';
// The scan gate and the storage push after it. Network I/O, kept off the
// ffmpeg and sharp lanes so a slow classifier cannot stall conversions.
const SCAN_LANE = 'scan';

const lanes = new Map();

function laneFor(name) {
  if (!lanes.has(name)) lanes.set(name, { tasks: [], running: false });
  return lanes.get(name);
}

async function drain(lane, name) {
  if (lane.running) return;
  lane.running = true;
  while (lane.tasks.length) {
    const task = lane.tasks.shift();
    try {
      await task();
    } catch (err) {
      logger.error({ lane: name, err: err.message }, 'queue task failed');
    }
  }
  lane.running = false;
}

function push(task, name = MEDIA_LANE) {
  const lane = laneFor(name);
  lane.tasks.push(task);
  drain(lane, name);
}

module.exports = {
  push,
  MEDIA_LANE,
  IMAGE_LANE,
  PUBLISH_LANE,
  SCAN_LANE,
};
