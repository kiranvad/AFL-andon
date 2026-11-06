'use strict';

const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 };

function registerTerminationHandlers(onTerminate, runtime = process) {
  let terminating = false;
  let parentTimer;
  const terminate = signal => {
    if (terminating) return;
    terminating = true;
    clearInterval(parentTimer);
    onTerminate(signal);
  };

  // Keep listeners installed while asynchronous server cleanup runs. A second
  // hangup must not restore Node's default action and terminate cleanup early.
  const handlers = Object.keys(signalExitCodes).map(signal => {
    const handler = () => terminate(signal);
    runtime.on(signal, handler);
    return [signal, handler];
  });

  const parentPid = runtime.ppid;
  const launchedFromTerminal = runtime.stdin?.isTTY || runtime.stdout?.isTTY ||
    runtime.stderr?.isTTY || runtime.env.npm_lifecycle_event;
  if (launchedFromTerminal && parentPid > 1) {
    // npm and Electron's CLI do not forward SIGHUP. If the terminal closes
    // and kills that wrapper, Electron can survive without receiving a signal.
    parentTimer = setInterval(() => {
      if (runtime.ppid !== parentPid) {
        terminate('SIGHUP');
        return;
      }
      try {
        runtime.kill(parentPid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') terminate('SIGHUP');
      }
    }, 1000);
    parentTimer.unref();
  }

  return () => {
    clearInterval(parentTimer);
    handlers.forEach(([signal, handler]) => runtime.removeListener(signal, handler));
  };
}

module.exports = { registerTerminationHandlers, signalExitCodes };
