const sharp = require('sharp');
const config = require('../config');

// Every file is seen exactly once, so libvips' operation cache can never hit —
// it would only pin memory and keep file handles open across the rename below.
sharp.cache(false);
// Match the queue: one image job at a time already, so don't let a single
// resize fan out across every core and starve a concurrent ffmpeg transcode.
sharp.concurrency(1);

// Animated formats we preserve as animated. Anything else is flattened to a
// single frame — a multi-page TIFF publishing as an "animation" is never what
// the uploader meant.
const ANIMATED_FORMATS = ['gif', 'webp'];

const baseOptions = () => ({
  // A few-KB PNG can decompress to gigapixels; refuse before allocating.
  limitInputPixels: config.MAX_IMAGE_PIXELS,
  // Default 'warning' rejects slightly-malformed-but-viewable JPEGs, which real
  // phone cameras produce often enough to matter. Only hard errors fail here.
  failOn: 'error',
});

// Returns sharp metadata ({ format, width, height, pages, ... }) or throws if
// the bytes aren't a decodable image. This is the image analogue of ffprobe:
// the check that the upload is real media and not a renamed executable.
async function probe(filePath) {
  const meta = await sharp(filePath, baseOptions()).metadata();
  if (!meta.format || !(meta.width > 0) || !(meta.height > 0)) {
    throw new Error('unreadable image');
  }
  return meta;
}

// Normalises an upload without changing its format when we recognise it.
//
// jpeg, png and webp are kept as they arrived, because an uploader who chose
// PNG for a screenshot or JPEG for a photo made a reasonable choice and a
// silent re-encode to WebP is not ours to make. Everything else -- gif, tiff,
// avif, heic -- becomes WebP, because those are either huge or unsupported by
// enough browsers to be a liability. Returns the extension actually written.
//
// .rotate() with no argument applies the EXIF orientation tag and then drops
// it, so the pixels are physically upright. Without it every portrait photo
// from a phone publishes sideways. It must come before .resize() or the cap
// would be applied to the pre-rotation width/height.
//
// EXIF is not copied to the output (sharp's default) whichever format we write,
// which also strips GPS coordinates -- uploaders should not be publishing their
// home address with a photo of their lunch.
const KEEP_FORMAT = { jpeg: '.jpg', png: '.png', webp: '.webp' };

function extensionFor(meta) {
  return KEEP_FORMAT[meta.format] || '.webp';
}

async function normalise(srcPath, destPath, meta) {
  const animated = ANIMATED_FORMATS.includes(meta.format) && meta.pages > 1;

  let pipeline = sharp(srcPath, { ...baseOptions(), animated });

  // Animated sources carry no EXIF orientation, and rotating a frame strip
  // would corrupt the frame layout, so only stills get the rotate step.
  if (!animated) pipeline = pipeline.rotate();

  pipeline = pipeline.resize({
    width: config.MAX_IMAGE_DIMENSION,
    height: config.MAX_IMAGE_DIMENSION,
    fit: 'inside',          // preserve aspect ratio, cap the long edge
    withoutEnlargement: true, // never upscale a small image into a big file
  });

  const ext = extensionFor(meta);
  if (ext === '.jpg') {
    // JPEG has no alpha; a transparent source would otherwise go black.
    pipeline = pipeline.flatten({ background: '#ffffff' })
      .jpeg({ quality: config.IMAGE_QUALITY, mozjpeg: true });
  } else if (ext === '.png') {
    pipeline = pipeline.png({ compressionLevel: 9 });
  } else {
    pipeline = pipeline.webp({
      quality: config.IMAGE_QUALITY,
      effort: 4, // encode speed vs. size; 4 is the useful knee of the curve
    });
  }

  await pipeline.toFile(destPath);
  return ext;
}

// Dimensions of the file we actually published, which differ from the input
// whenever the long-edge cap or an EXIF rotation applied.
async function publishedSize(filePath) {
  const { width, height } = await sharp(filePath, baseOptions()).metadata();
  return { width, height };
}

module.exports = { probe, normalise, extensionFor, publishedSize };
