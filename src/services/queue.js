const logger = require('./logger');

// Minimal in-process FIFO queue, concurrency 1 *per lane*.
//
// Everything used to share one lane, which was fine while every job was
// ffmpeg. Images broke that: a 200ms WebP conversion queued behind a 30-minute
// HEVC transcode would leave the uploader staring at a spinner for half an
// hour. Lanes are strictly about head-of-line blocking between cheap and
// expensive work — they are NOT extra processes. The single-instance rule in
// CLAUDE.md still holds; this is all one event loop.
//
// Two lanes means at most two concurrent encodes, which is deliberate: ffmpeg
// is given the cores (see image.js pinning sharp to concurrency 1) so a burst
// of photo uploads can't starve a video transcode.

const MEDIA_LANE = 'media'; // ffmpeg: video remux/transcode, audio transcode
const IMAGE_LANE = 'image'; // sharp: fast, must not wait behind the above

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
  size: (name = MEDIA_LANE) => laneFor(name).tasks.length,
  MEDIA_LANE,
  IMAGE_LANE,
};
