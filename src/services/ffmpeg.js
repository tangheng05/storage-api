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

module.exports = { probe, remuxToMp4, makeThumbnail };
