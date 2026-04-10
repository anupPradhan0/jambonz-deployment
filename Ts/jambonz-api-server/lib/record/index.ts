// @ts-nocheck

async function record(logger, socket) {
  return require('./upload')(logger, socket);
}

module.exports = record;

export {};
