'use strict';

// SynchronousWorker was originally a separate module developed by
// Anna Henningsen and published separately on npm as the
// synchronous-worker module under the MIT license. It has been
// incorporated into Node.js with Anna's permission.
// See the LICENSE file for LICENSE and copyright attribution.

const {
  Promise,
} = primordials;

const {
  SynchronousWorker: SynchronousWorkerImpl,
  UV_RUN_DEFAULT,
  UV_RUN_ONCE,
  UV_RUN_NOWAIT,
} = internalBinding('worker');

const { setImmediate } = require('timers');

const EventEmitter = require('events');

let debug = require('internal/util/debuglog').debuglog('localworker', (fn) => {
  debug = fn;
});

const {
  codes: {
    ERR_INVALID_STATE,
  },
} = require('internal/errors');

class SynchronousWorker extends EventEmitter {
  #handle = undefined;
  #process = undefined;
  #global = undefined;
  #module = undefined;
  #stoppedPromise = undefined;

  /**
   * @typedef {{
   * }} SynchronousWorkerOptions
   * @param {SynchronousWorkerOptions} [options]
   */
  constructor() {
    super();
    this.#handle = new SynchronousWorkerImpl();
    this.#handle.onexit = (code) => {
      this.stop();
      this.emit('exit', code);
    };
    try {
      this.#handle.start();
      this.#handle.load((process, nativeRequire, globalThis) => {
        const origExit = process.reallyExit;
        process.reallyExit = (...args) => {
          const ret = origExit.call(process, ...args);
          // Make a dummy call to make sure the termination exception is
          // propagated. For some reason, this isn't necessarily the case
          // otherwise.
          process.memoryUsage();
          return ret;
        };
        this.#process = process;
        this.#module = nativeRequire('module');
        this.#global = globalThis;
        process.on('uncaughtException', (err) => {
          if (process.listenerCount('uncaughtException') === 1) {
            this.emit('error', err);
            process.exit(1);
          }
        });
      });
    } catch (err) {
      this.#handle.stop();
      throw err;
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async stop() {
    // TODO(@mcollina): add support for AbortController, we want to abort this,
    // or add a timeout.
    return this.#stoppedPromise ??= new Promise((resolve) => {
      const onExit = () => {
        debug('stopping localworker');
        this.#handle.stop();
        resolve();
      }

      const tryClosing = () => {
        const closed = this.#handle.tryCloseAllHandles();
        debug('closed %d handles', closed)
        if (closed > 0) {
          // This is an active wait for the handles to close.
          // We might want to change this in the future to use a callback,
          // but at this point it seems like a premature optimization.
          // TODO(@mcollina): refactor to use a close callback
          setTimeout(tryClosing, 100);
        } else {
          this.#handle.signalStop();

          setTimeout(onExit, 100);
        }
      }
      
      // We use setTimeout instead of setImmediate because it runs in a different
      // phase of the event loop. This is important because the immediate queue
      // would crash if the environment it refers to has been already closed.
      setTimeout(tryClosing, 100);
    });
  }

  get process() {
    return this.#process;
  }

  get globalThis() {
    return this.#global;
  }

  createRequire(...args) {
    return this.#module.createRequire(...args);
  }

  /**
   * @param {() => any} method
   */
  runInWorkerScope(method) {
    return this.#handle.runInCallbackScope(method);
  }
}

module.exports = SynchronousWorker;
