const { execFile } = require('child_process');
const config = require('../config');

function run(bin, args, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(new Error(`${bin} failed: ${stderr || err.message}`), { stderr }));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

// Returns parsed ffprobe JSON ({ format, streams }) or throws if not a media file.
async function probe(filePath) {
  const { stdout } = await run(config.FFPROBE_PATH, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ], 60 * 1000);
  return JSON.parse(stdout);
}

// Stream-copy remux into MP4 with the moov atom up front (instant playback start).
// Only valid for codecs browsers already decode natively (h264) — no re-encode.
async function remuxToMp4(srcPath, destPath) {
  await run(config.FFMPEG_PATH, [
    '-y',
    '-i', srcPath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c', 'copy',
    '-movflags', '+faststart',
    '-f', 'mp4',
    destPath,
  ]);
}

// Re-encode to H.264/AAC. Used for codecs ffmpeg can decode but browsers can't
// play (HEVC — the default on iPhones since iOS 11), so the published file
// works everywhere instead of silently failing outside Safari. CPU-bound;
// gets a longer timeout than the other ffmpeg calls.
async function transcodeToH264(srcPath, destPath) {
  await run(config.FFMPEG_PATH, [
    '-y',
    '-i', srcPath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-f', 'mp4',
    destPath,
  ], 30 * 60 * 1000);
}

// Re-encode any input audio to AAC in an M4A container for universal browser
// support and consistent behavior, same rationale as HEVC->H.264 for video.
async function transcodeToAac(srcPath, destPath) {
  await run(config.FFMPEG_PATH, [
    '-y',
    '-i', srcPath,
    '-map', '0:a:0',
    '-vn',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-f', 'mp4',
    destPath,
  ], 30 * 60 * 1000);
}

async function makeThumbnail(srcPath, destPath, atSeconds) {
  await run(config.FFMPEG_PATH, [
    '-y',
    '-ss', String(atSeconds),
    '-i', srcPath,
    '-frames:v', '1',
    '-vf', 'scale=640:-2',
    '-q:v', '3',
    destPath,
  ], 60 * 1000);
}

module.exports = { probe, remuxToMp4, transcodeToH264, transcodeToAac, makeThumbnail };
