const fsp = require('fs/promises');

// Returns free bytes on the volume containing dirPath, or null if the
// platform/runtime doesn't support statfs (e.g. older Node on Windows).
async function checkDiskSpace(dirPath) {
  try {
    if (typeof fsp.statfs !== 'function') return null;
    const stats = await fsp.statfs(dirPath);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

module.exports = { checkDiskSpace };
