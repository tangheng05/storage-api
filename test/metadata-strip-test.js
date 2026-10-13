#!/usr/bin/env node
/*
| Metadata strip test: node test/metadata-strip-test.js (no framework). Proves
| no account's upload cannot carry its GPS position, device or
| capture time to S5: the tus flag lands on the job, ffmpeg drops the tags
| when it is set, sharp drops image metadata always, and convert() fails a
| flagged job whose output still carries them. Needs ffmpeg/ffprobe on PATH
| for the video and audio cases; skips those (loudly) without them.
*/
// Ignore any .env on this machine: a suite must not read production config.
process.env.STORAGE_TEST = '1';
const assert = require('assert');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
process.env.UPLOAD_API_KEY = 'strip-test-key';

let checks = 0;
const ok = (label, cond) => {
  assert.ok(cond, label);
  checks += 1;
  // eslint-disable-next-line no-console
  console.log(`  ok  ${label}`);
};

const LOCATION = '+11.5564+104.9282/';
const XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
  + '<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="11,33.3N"/>'
  + '</rdf:RDF></x:xmpmeta>';

function haveFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// A one-second clip tagged the way an iPhone tags one.
function makeClip(dest, { codec, format }) {
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '1',
    '-c:v', codec,
    ...(format === 'webm' ? ['-c:a', 'libopus'] : ['-c:a', 'aac']),
    '-metadata', `location=${LOCATION}`,
    '-metadata', 'com.apple.quicktime.make=Apple',
    '-metadata', 'title=Home',
    ...(format === 'mov' ? ['-movflags', 'use_metadata_tags'] : []),
    '-f', format,
    dest,
  ]);
}

function makeAudio(dest) {
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '1',
    '-c:a', 'aac',
    '-metadata', `location=${LOCATION}`,
    '-metadata', 'title=Voice memo at home',
    '-f', 'mp4',
    dest,
  ]);
}

const rejects = async (fn) => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
};

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strip-test-'));
  const dirs = {
    TUS_DIR: 'tus',
    JOBS_DIR: 'jobs',
    PENDING_VIDEOS_DIR: 'pending/videos',
    PENDING_AUDIO_DIR: 'pending/audio',
    PENDING_IMAGES_DIR: 'pending/images',
    PENDING_THUMBS_DIR: 'pending/thumbnails',
  };
  await Promise.all(Object.entries(dirs).map(async ([key, rel]) => {
    process.env[key] = path.join(root, rel);
    await fsp.mkdir(process.env[key], { recursive: true });
  }));

  const sharp = require('sharp');
  const jobs = require('../src/services/jobs');
  const queue = require('../src/services/queue');
  const ffmpeg = require('../src/services/ffmpeg');
  const image = require('../src/services/image');
  const { assertStripped } = require('../src/services/metadata');
  const processor = require('../src/services/processor');
  const tusServer = require('../src/tus');

  // Only convert() runs: anything it queues next (the scan) is captured, not run.
  const queued = [];
  queue.push = (fn) => { queued.push(fn); };
  const convert = async (id, mediaType) => {
    queued.length = 0;
    processor.enqueue(id, mediaType);
    await queued.shift()();
    return jobs.get(id);
  };

  // --- tus: the flag reaches the job ---

  const create = async (id, metadata) => {
    const res = { setHeader() {} };
    await tusServer.options.onUploadCreate({}, res, {
      id,
      size: 1024,
      metadata: { filename: 'upload.jpg', filetype: 'image/jpeg', ...metadata },
    });
    return jobs.get(id);
  };
  ok('strip_metadata=true is recorded on the job',
    (await create('01M3STR1PTESTTESTTESTTESAA', { strip_metadata: 'true' })).strip_metadata === true);
  ok('an absent flag strips too, so no client can forget it',
    (await create('01M3STR1PTESTTESTTESTTESAB', {})).strip_metadata === true);
  ok('an explicit no opts out',
    (await create('01M3STR1PTESTTESTTESTTESAC', { strip_metadata: 'false' })).strip_metadata === undefined);
  ok('an unrecognised value still strips',
    (await create('01M3STR1PTESTTESTTESTTESAD', { strip_metadata: 'maybe' })).strip_metadata === true);

  // --- images: sharp drops everything, for every upload ---

  const base = sharp({ create: { width: 64, height: 48, channels: 3, background: '#888' } });
  const tagged = (fmt) => base.clone()
    .withExif({ IFD0: { Make: 'Apple', Model: 'iPhone 15' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '11/1 33/1 0/1' } })
    .withXmp(XMP)[fmt]()
    .toBuffer();

  for (const fmt of ['jpeg', 'png', 'webp']) {
    const src = path.join(root, `in.${fmt}`);
    await fsp.writeFile(src, await tagged(fmt));
    const before = await sharp(src).metadata();
    assert.ok(before.exif && before.xmp, `fixture ${fmt} carries EXIF and XMP`);
    const meta = await image.probe(src);
    const dest = path.join(root, `out${image.extensionFor(meta)}`);
    await image.normalise(src, dest, meta);
    ok(`a ${fmt} loses its EXIF, GPS and XMP on normalise`, (await rejects(() => assertStripped(dest, 'image'))) === null);
  }
  ok('the check catches an image that still carries EXIF',
    (await rejects(() => assertStripped(path.join(root, 'in.jpeg'), 'image')))?.code === 'metadata_not_stripped');

  // A flagged image job runs the check and publishes as usual.
  const IMG = '01M3STR1PTESTTESTTESTTESBA';
  await jobs.create(IMG, { state: 'queued', media_type: 'image', strip_metadata: true });
  await fsp.copyFile(path.join(root, 'in.jpeg'), path.join(process.env.TUS_DIR, IMG));
  ok('a flagged image job passes the check and moves on to the scan', (await convert(IMG, 'image')).state === 'scanning');

  // --- video and audio: ffmpeg keeps tags unless told otherwise ---

  if (!haveFfmpeg()) {
    // eslint-disable-next-line no-console
    console.log('  SKIP video/audio cases: ffmpeg/ffprobe not on PATH');
  } else {
    const mov = path.join(root, 'clip.mov');
    makeClip(mov, { codec: 'libx264', format: 'mov' });
    ok('the fixture video carries a location',
      (await rejects(() => assertStripped(mov, 'video')))?.code === 'metadata_not_stripped');

    const kept = path.join(root, 'kept.mp4');
    await ffmpeg.remuxToMp4(mov, kept);
    const leak = await rejects(() => assertStripped(kept, 'video'));
    ok('a plain remux keeps the location (the default being guarded against)',
      leak?.code === 'metadata_not_stripped' && leak.found.some((k) => /location/i.test(k)));

    const remuxed = path.join(root, 'remuxed.mp4');
    await ffmpeg.remuxToMp4(mov, remuxed, { stripMetadata: true });
    ok('remuxToMp4 with stripMetadata drops it', (await rejects(() => assertStripped(remuxed, 'video'))) === null);

    const transcoded = path.join(root, 'transcoded.mp4');
    await ffmpeg.transcodeToH264(mov, transcoded, { stripMetadata: true });
    ok('transcodeToH264 with stripMetadata drops it', (await rejects(() => assertStripped(transcoded, 'video'))) === null);

    const webm = path.join(root, 'clip.webm');
    makeClip(webm, { codec: 'libvpx-vp9', format: 'webm' });
    ok('the fixture webm carries a location',
      (await rejects(() => assertStripped(webm, 'video')))?.code === 'metadata_not_stripped');
    const webmOut = path.join(root, 'out.webm');
    await ffmpeg.remuxWebm(webm, webmOut, { stripMetadata: true });
    ok('remuxWebm with stripMetadata drops it', (await rejects(() => assertStripped(webmOut, 'video'))) === null);

    const m4a = path.join(root, 'memo.m4a');
    makeAudio(m4a);
    const aac = path.join(root, 'memo-out.m4a');
    await ffmpeg.transcodeToAac(m4a, aac, { stripMetadata: true });
    ok('transcodeToAac with stripMetadata drops it', (await rejects(() => assertStripped(aac, 'audio'))) === null);
    const probed = await ffmpeg.probe(aac);
    ok('and drops the title with it', !(probed.format.tags || {}).title);

    // End to end through convert(): flagged and unflagged.
    const VID = '01M3STR1PTESTTESTTESTTESCA';
    await jobs.create(VID, { state: 'queued', media_type: 'video', strip_metadata: true });
    await fsp.copyFile(mov, path.join(process.env.TUS_DIR, VID));
    const vid = await convert(VID, 'video');
    ok('a flagged video converts and moves on to the scan', vid.state === 'scanning');
    ok('its published file carries no location',
      (await rejects(() => assertStripped(path.join(process.env.PENDING_VIDEOS_DIR, vid.pending_file), 'video'))) === null);

    const WEBM = '01M3STR1PTESTTESTTESTTESCB';
    await jobs.create(WEBM, { state: 'queued', media_type: 'video', strip_metadata: true });
    await fsp.copyFile(webm, path.join(process.env.TUS_DIR, WEBM));
    const wj = await convert(WEBM, 'video');
    ok('a flagged webm is remuxed rather than copied, and passes', wj.state === 'scanning' && wj.pending_file.endsWith('.webm'));

    // A VP9 .mkv with AAC audio takes the webm path, but the webm muxer refuses AAC.
    const mkv = path.join(root, 'mixed.mkv');
    execFileSync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '1', '-c:v', 'libvpx-vp9', '-c:a', 'aac',
      '-metadata', `location=${LOCATION}`,
      '-f', 'matroska', mkv,
    ]);
    const MKV = '01M3STR1PTESTTESTTESTTESCF';
    await jobs.create(MKV, { state: 'queued', media_type: 'video', strip_metadata: true });
    await fsp.copyFile(mkv, path.join(process.env.TUS_DIR, MKV));
    const mj = await convert(MKV, 'video');
    ok('a flagged VP9+AAC .mkv still converts, and passes', mj.state === 'scanning');

    const AUD = '01M3STR1PTESTTESTTESTTESCC';
    await jobs.create(AUD, { state: 'queued', media_type: 'audio', strip_metadata: true });
    await fsp.copyFile(m4a, path.join(process.env.TUS_DIR, AUD));
    ok('a flagged audio file converts and passes', (await convert(AUD, 'audio')).state === 'scanning');

    const PLAIN = '01M3STR1PTESTTESTTESTTESCD';
    await jobs.create(PLAIN, { state: 'queued', media_type: 'video' });
    await fsp.copyFile(mov, path.join(process.env.TUS_DIR, PLAIN));
    const plain = await convert(PLAIN, 'video');
    ok('an unflagged video converts exactly as before', plain.state === 'scanning');

    // The check is what stands between a regression and S5: break the strip
    // and the job must fail, with nothing left in the pending dir.
    const realRemux = ffmpeg.remuxToMp4;
    ffmpeg.remuxToMp4 = (src, dest) => realRemux(src, dest);
    const BROKEN = '01M3STR1PTESTTESTTESTTESCE';
    await jobs.create(BROKEN, { state: 'queued', media_type: 'video', strip_metadata: true });
    await fsp.copyFile(mov, path.join(process.env.TUS_DIR, BROKEN));
    const broken = await convert(BROKEN, 'video');
    ffmpeg.remuxToMp4 = realRemux;
    ok('a flagged video that kept its location fails', broken.state === 'failed' && broken.error === 'metadata_not_stripped');
    ok('and is never queued for the scan or S5', queued.length === 0);
    const left = await fsp.readdir(process.env.PENDING_VIDEOS_DIR);
    ok('and leaves no file in the pending dir', !left.some((f) => f.startsWith(BROKEN)));
    const thumbs = await fsp.readdir(process.env.PENDING_THUMBS_DIR);
    ok('nor a thumbnail', !thumbs.some((f) => f.startsWith(BROKEN)));
  }

  await fsp.rm(root, { recursive: true, force: true });
  // eslint-disable-next-line no-console
  console.log(`\n${checks} checks passed`);
  process.exit(0);
})().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('FAILED:', e.message);
  process.exit(1);
});
