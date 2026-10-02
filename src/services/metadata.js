const sharp = require('sharp');
const config = require('../config');
const ffmpeg = require('./ffmpeg');

// The check behind strip_metadata: conversion is meant to have removed these
// already, and this fails the job if it did not, before anything reaches S5,
// whose CIDs cannot be withdrawn.
const IDENTIFYING_TAG = /location|gps|©xyz|com\.apple\.quicktime\.(make|model|software|creationdate)/i;

function notStripped(found) {
  return Object.assign(new Error('metadata_not_stripped'), { code: 'metadata_not_stripped', found });
}

async function assertImageStripped(filePath) {
  const meta = await sharp(filePath, { limitInputPixels: config.MAX_IMAGE_PIXELS }).metadata();
  const found = ['exif', 'xmp', 'iptc'].filter((k) => meta[k]);
  if (found.length) throw notStripped(found);
}

async function assertMediaStripped(filePath) {
  const { format = {}, streams = [] } = await ffmpeg.probe(filePath);
  const found = [format, ...streams]
    .flatMap((part) => Object.keys(part.tags || {}))
    .filter((key) => IDENTIFYING_TAG.test(key));
  if (found.length) throw notStripped(found);
}

async function assertStripped(filePath, mediaType) {
  if (mediaType === 'image') return assertImageStripped(filePath);
  return assertMediaStripped(filePath);
}

module.exports = { assertStripped };
