'use strict';

// Errors meant for the user. The renderer translates `key` with the params, so the
// main process never has to know the UI language for these.
class UserError extends Error {
  constructor(key, params) {
    super(key);
    this.key = key;
    this.params = params || {};
  }
}

module.exports = { UserError };
