const logger = require('./logger');

// Minimal in-process FIFO queue with concurrency 1.
// Video remux is I/O-bound; one job at a time keeps disk and CPU predictable.

const tasks = [];
let running = false;

async function drain() {
  if (running) return;
  running = true;
  while (tasks.length) {
    const task = tasks.shift();
    try {
      await task();
    } catch (err) {
      logger.error({ err: err.message }, 'queue task failed');
    }
  }
  running = false;
}

function push(task) {
  tasks.push(task);
  drain();
}

module.exports = { push, size: () => tasks.length };
