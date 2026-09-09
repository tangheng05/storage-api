const logger = require('./logger');

// Minimal in-process FIFO, concurrency 1 *per lane* -- lanes prevent
// head-of-line blocking (a 200ms WebP conversion must not sit behind a
// 30-minute HEVC transcode). Not extra processes: still one event loop.

const MEDIA_LANE = 'media'; // ffmpeg: video remux/transcode, audio transcode
const IMAGE_LANE = 'image'; // sharp: fast, must not wait behind the above
const PUBLISH_LANE = 'sia'; // retrying failed storage pushes, off the live-upload path
const SCAN_LANE = 'scan'; // scan gate + storage push; network I/O, off the ffmpeg/sharp lanes

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
