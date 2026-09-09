// Lane concurrency: the scan lane runs several tasks at once because it waits
// on the network, while the ffmpeg/sharp lanes must stay strictly serial.
const assert = require('assert');

process.env.UPLOAD_API_KEY = 'queue-test';
process.env.SCAN_CONCURRENCY = '4';

const config = require('../src/config');
const queue = require('../src/services/queue');

let checks = 0;
const ok = (label, cond) => {
  assert.ok(cond, label);
  checks += 1;
  // eslint-disable-next-line no-console
  console.log(`  ok  ${label}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs `count` tasks on `lane` and reports the high-water mark of tasks that
// were in flight together.
async function peakInFlight(lane, count, taskMs = 30) {
  let inFlight = 0;
  let peak = 0;
  let done = 0;
  const finished = new Promise((resolve) => {
    for (let i = 0; i < count; i += 1) {
      queue.push(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await sleep(taskMs);
        inFlight -= 1;
        done += 1;
        if (done === count) resolve();
      }, lane);
    }
  });
  await finished;
  return { peak, done };
}

async function main() {
  const scan = await peakInFlight(queue.SCAN_LANE, 12);
  ok('every scan task runs', scan.done === 12);
  ok(`the scan lane runs ${config.SCAN_CONCURRENCY} at once`,
    scan.peak === config.SCAN_CONCURRENCY);
  ok('and never exceeds its limit', scan.peak <= config.SCAN_CONCURRENCY);

  // ffmpeg and sharp are CPU-bound; overlapping them would only thrash.
  const media = await peakInFlight(queue.MEDIA_LANE, 6);
  ok('every media task runs', media.done === 6);
  ok('the media lane stays serial', media.peak === 1);

  const image = await peakInFlight(queue.IMAGE_LANE, 6);
  ok('the image lane stays serial', image.peak === 1);

  const publish = await peakInFlight(queue.PUBLISH_LANE, 6);
  ok('the publish lane stays serial', publish.peak === 1);

  // Lanes must not share a worker budget, or a busy scan lane would stall
  // conversions -- the whole reason lanes exist.
  let mediaRan = false;
  const bothIdle = new Promise((resolve) => {
    let left = 2;
    const tick = () => { left -= 1; if (!left) resolve(); };
    for (let i = 0; i < 8; i += 1) {
      queue.push(async () => { await sleep(20); }, queue.SCAN_LANE);
    }
    queue.push(async () => { mediaRan = true; await sleep(5); tick(); }, queue.MEDIA_LANE);
    queue.push(async () => { await sleep(5); tick(); }, queue.SCAN_LANE);
  });
  await bothIdle;
  ok('a busy scan lane does not block the media lane', mediaRan);

  // A throwing task must not kill the lane's worker and strand the queue.
  let after = false;
  const survived = new Promise((resolve) => {
    queue.push(async () => { throw new Error('boom'); }, queue.SCAN_LANE);
    queue.push(async () => { after = true; resolve(); }, queue.SCAN_LANE);
  });
  await survived;
  ok('a thrown task does not strand the lane', after);

  // The limit is read per drain, so it cannot be pinned at boot.
  config.SCAN_CONCURRENCY = 1;
  const throttled = await peakInFlight(queue.SCAN_LANE, 6);
  ok('lowering the limit takes effect', throttled.peak === 1);
  config.SCAN_CONCURRENCY = 4;

  // eslint-disable-next-line no-console
  console.log(`\n${checks} checks passed`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
