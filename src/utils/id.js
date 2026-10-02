const crypto = require('crypto');

// ULID-shaped but fully random. A real ULID's first ten characters are its
// creation time to the millisecond, and the id is in every public URL; on an
// anonymous account that time can be matched against other records. Same
// alphabet and length, so every route, nginx rule and consumer regex that
// checks the shape still matches.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomId() {
  const bytes = crypto.randomBytes(26);
  // 0-7 first, as in a ULID, so a strict ULID parser still accepts it.
  let id = CROCKFORD[bytes[0] & 7];
  for (let i = 1; i < 26; i += 1) id += CROCKFORD[bytes[i] & 31];
  return id;
}

module.exports = { randomId };
