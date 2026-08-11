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

// Converts any supported input to WebP, downscaled to fit MAX_IMAGE_DIMENSION.
//
// .rotate() with no argument applies the EXIF orientation tag and then drops
// it, so the pixels are physically upright. Without it every portrait photo
// from a phone publishes sideways, because WebP has no orientation tag for a
// viewer to honour. It must come before .resize() or the cap would be applied
// to the pre-rotation width/height.
//
// EXIF is not copied to the output (sharp's default), which also strips GPS
// coordinates — uploaders should not be publishing their home address with a
// photo of their lunch.
async function toWebp(srcPath, destPath, meta) {
  const animated = ANIMATED_FORMATS.includes(meta.format) && meta.pages > 1;

  let pipeline = sharp(srcPath, { ...baseOptions(), animated });

  // Animated sources carry no EXIF orientation, and rotating a frame strip
  // would corrupt the frame layout, so only stills get the rotate step.
  if (!animated) pipeline = pipeline.rotate();

  await pipeline
    .resize({
      width: config.MAX_IMAGE_DIMENSION,
      height: config.MAX_IMAGE_DIMENSION,
      fit: 'inside',          // preserve aspect ratio, cap the long edge
      withoutEnlargement: true, // never upscale a small image into a big file
    })
    .webp({
      quality: config.IMAGE_WEBP_QUALITY,
      effort: 4, // encode speed vs. size; 4 is the useful knee of the curve
    })
    .toFile(destPath);
}

// Dimensions of the file we actually published, which differ from the input
// whenever the long-edge cap or an EXIF rotation applied.
async function publishedSize(filePath) {
  const { width, height } = await sharp(filePath, baseOptions()).metadata();
  return { width, height };
}

module.exports = { probe, toWebp, publishedSize };
