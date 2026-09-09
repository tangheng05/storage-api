const sharp = require('sharp');
const config = require('../config');

// Every file is seen once, so libvips' cache would only pin memory.
sharp.cache(false);
// One image job at a time already; don't let a resize starve a concurrent ffmpeg transcode.
sharp.concurrency(1);

const ANIMATED_FORMATS = ['gif', 'webp'];

const baseOptions = () => ({
  // A few-KB PNG can decompress to gigapixels; refuse before allocating.
  limitInputPixels: config.MAX_IMAGE_PIXELS,
  // 'warning' (sharp's default) rejects slightly-malformed but viewable JPEGs
  // that real phone cameras produce; only hard errors fail here.
  failOn: 'error',
});

async function probe(filePath) {
  const meta = await sharp(filePath, baseOptions()).metadata();
  if (!meta.format || !(meta.width > 0) || !(meta.height > 0)) {
    throw new Error('unreadable image');
  }
  return meta;
}

// Normalises an upload, preserving jpeg/png/webp as-is; everything else (gif,
// tiff, avif, heic) becomes WebP. EXIF (and GPS) is stripped on write, sharp's
// default. .rotate() must precede .resize() or the long-edge cap is applied to
// pre-rotation dimensions.
const KEEP_FORMAT = { jpeg: '.jpg', png: '.png', webp: '.webp' };

function extensionFor(meta) {
  return KEEP_FORMAT[meta.format] || '.webp';
}

async function normalise(srcPath, destPath, meta) {
  const animated = ANIMATED_FORMATS.includes(meta.format) && meta.pages > 1;

  let pipeline = sharp(srcPath, { ...baseOptions(), animated });

  // Rotating a frame strip would corrupt animated layout, so only stills rotate.
  if (!animated) pipeline = pipeline.rotate();

  pipeline = pipeline.resize({
    width: config.MAX_IMAGE_DIMENSION,
    height: config.MAX_IMAGE_DIMENSION,
    fit: 'inside',
    withoutEnlargement: true,
  });

  const ext = extensionFor(meta);
  if (ext === '.jpg') {
    // JPEG has no alpha; a transparent source would otherwise go black.
    pipeline = pipeline.flatten({ background: '#ffffff' })
      .jpeg({ quality: config.IMAGE_QUALITY, mozjpeg: true });
  } else if (ext === '.png') {
    pipeline = pipeline.png({ compressionLevel: 9 });
  } else {
    pipeline = pipeline.webp({ quality: config.IMAGE_QUALITY, effort: 4 });
  }

  await pipeline.toFile(destPath);
  return ext;
}

// Dimensions actually published, which differ from the input when the cap or an EXIF rotation applied.
async function publishedSize(filePath) {
  const { width, height } = await sharp(filePath, baseOptions()).metadata();
  return { width, height };
}

module.exports = { probe, normalise, extensionFor, publishedSize };
