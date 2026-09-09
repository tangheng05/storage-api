const config = require('../config');
const logger = require('./logger');

// Minimal in-process FIFO, one queue per lane -- lanes prevent head-of-line
// blocking (a 200ms WebP conversion must not sit behind a 30-minute HEVC
// transcode). Not extra processes: still one event loop.
//
// ffmpeg and sharp stay at 1: CPU-bound, overlapping only thrashes. The scan
// lane waits on the network, so serialising it queues every uploader behind
// every other one.

const MEDIA_LANE = 'media'; // ffmpeg: video remux/transcode, audio transcode
const IMAGE_LANE = 'image'; // sharp: fast, must not wait behind the above
const PUBLISH_LANE = 'sia'; // retrying failed storage pushes, off the live-upload path
const SCAN_LANE = 'scan'; // scan gate + storage push; network I/O, off the ffmpeg/sharp lanes

const lanes = new Map();

const limitFor = (name) => (name === SCAN_LANE ? Math.max(1, config.SCAN_CONCURRENCY) : 1);

function laneFor(name) {
  if (!lanes.has(name)) lanes.set(name, { tasks: [], running: 0 });
  return lanes.get(name);
}

// One call per push: workers are added up to the limit, each draining until
// the queue is empty.
async function drain(lane, name) {
  if (lane.running >= limitFor(name)) return;
  lane.running += 1;
  while (lane.tasks.length) {
    const task = lane.tasks.shift();
    try {
      // eslint-disable-next-line no-await-in-loop
      await task();
    } catch (err) {
      logger.error({ lane: name, err: err.message }, 'queue task failed');
    }
  }
  lane.running -= 1;
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
