/* End-to-end upload test: node test/upload-test.js <file> [--interrupt]
 * --interrupt aborts mid-upload once, then resumes — proves resumability. */
const fs = require('fs');
const path = require('path');
const tus = require('tus-js-client');

const ENDPOINT = process.env.ENDPOINT || 'http://localhost:8080';
const KEY = process.env.UPLOAD_API_KEY || 'change-me-to-a-long-random-string';
const file = process.argv[2];
const interrupt = process.argv.includes('--interrupt');

if (!file) {
  console.error('usage: node test/upload-test.js <video|audio|image-file> [--interrupt]');
  process.exit(1);
}

// The service classifies an upload by mimetype AND extension, and each media
// type polls a different status route, so both are derived from the filename.
const TYPES = {
  '.mp4': ['video/mp4', 'videos'],
  '.m4v': ['video/mp4', 'videos'],
  '.mov': ['video/quicktime', 'videos'],
  '.mkv': ['video/x-matroska', 'videos'],
  '.webm': ['video/webm', 'videos'],
  '.avi': ['video/x-msvideo', 'videos'],
  '.mp3': ['audio/mpeg', 'audio'],
  '.wav': ['audio/wav', 'audio'],
  '.m4a': ['audio/mp4', 'audio'],
  '.aac': ['audio/aac', 'audio'],
  '.ogg': ['audio/ogg', 'audio'],
  '.opus': ['audio/opus', 'audio'],
  '.flac': ['audio/flac', 'audio'],
  '.jpg': ['image/jpeg', 'images'],
  '.jpeg': ['image/jpeg', 'images'],
  '.png': ['image/png', 'images'],
  '.webp': ['image/webp', 'images'],
  '.gif': ['image/gif', 'images'],
  '.tif': ['image/tiff', 'images'],
  '.tiff': ['image/tiff', 'images'],
  '.avif': ['image/avif', 'images'],
  '.heic': ['image/heic', 'images'],
  '.heif': ['image/heif', 'images'],
};

const ext = path.extname(file).toLowerCase();
if (!TYPES[ext]) {
  console.error(`unsupported extension "${ext}" — known: ${Object.keys(TYPES).join(' ')}`);
  process.exit(1);
}
const [filetype, statusPath] = TYPES[ext];

const stream = fs.createReadStream(file);
const size = fs.statSync(file).size;
let interrupted = false;

const upload = new tus.Upload(stream, {
  endpoint: `${ENDPOINT}/files`,
  uploadSize: size,
  chunkSize: 64 * 1024, // small chunks locally so --interrupt can hit mid-upload
  retryDelays: [0, 1000, 3000],
  headers: { 'x-upload-key': KEY },
  metadata: { filename: path.basename(file), filetype },
  onProgress(sent, total) {
    process.stdout.write(`\rupload: ${sent}/${total}`);
    if (interrupt && !interrupted && sent > total / 2) {
      interrupted = true;
      console.log('\n-- aborting mid-upload to test resume --');
      upload.abort().then(() => {
        setTimeout(() => {
          console.log('-- resuming --');
          upload.start();
        }, 1500);
      });
    }
  },
  onError(err) {
    console.error('\nupload failed:', err.message);
    process.exit(1);
  },
  async onSuccess() {
    const id = upload.url.split('/').pop();
    console.log(`\nuploaded, id=${id} (${filetype}) — polling status...`);
    for (;;) {
      const res = await fetch(`${ENDPOINT}/${statusPath}/${id}/status`, {
        headers: { 'x-upload-key': KEY },
      });
      const job = await res.json();
      console.log('state:', job.state, job.error || '');
      if (job.state === 'ready') {
        console.log('READY:', JSON.stringify(job, null, 2));
        process.exit(0);
      }
      if (job.state === 'failed') {
        console.log('FAILED:', job.error);
        process.exit(2);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  },
});

upload.start();
