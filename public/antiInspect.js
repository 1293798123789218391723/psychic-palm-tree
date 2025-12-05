(() => {
  const REDIRECT_URL = 'https://www.pornhub.com';
  const DEVTOOLS_GAP = 160;
  const BASELINE_BUFFER = 24;
  const BASELINE_WINDOW_MS = 500;
  const CONSOLE_PROBE_MS = 1000;
  const DEBUG_PROBE_MS = 1200;
  const DEBUG_PAUSE_THRESHOLD = 50;
  let hasRedirected = false;
  let initialWidthGap = 0;
  let initialHeightGap = 0;
  let consoleProbeId;
  let debugProbeId;

  const redirectAway = () => {
    if (hasRedirected) return;
    hasRedirected = true;
    window.location.replace(REDIRECT_URL);
  };

  const settleBaselineGaps = () =>
    new Promise((resolve) => {
      const cutoff = performance.now() + BASELINE_WINDOW_MS;
      let minWidthGap = Infinity;
      let minHeightGap = Infinity;

      const sample = () => {
        const widthGap = Math.abs(window.outerWidth - window.innerWidth);
        const heightGap = Math.abs(window.outerHeight - window.innerHeight);

        minWidthGap = Math.min(minWidthGap, widthGap);
        minHeightGap = Math.min(minHeightGap, heightGap);

        if (performance.now() < cutoff) {
          requestAnimationFrame(sample);
        } else {
          if (minWidthGap > DEVTOOLS_GAP || minHeightGap > DEVTOOLS_GAP) {
            redirectAway();
            resolve();
            return;
          }

          initialWidthGap = minWidthGap + BASELINE_BUFFER;
          initialHeightGap = minHeightGap + BASELINE_BUFFER;
          resolve();
        }
      };

      sample();
    });

  const devtoolsOpen = () => {
    const widthGap = Math.max(0, Math.abs(window.outerWidth - window.innerWidth) - initialWidthGap);
    const heightGap = Math.max(0, Math.abs(window.outerHeight - window.innerHeight) - initialHeightGap);
    return widthGap > DEVTOOLS_GAP || heightGap > DEVTOOLS_GAP;
  };

  const watchForResize = () => {
    if (devtoolsOpen()) {
      redirectAway();
    }
  };

  const watchForConsole = () => {
    const detector = new Image();
    Object.defineProperty(detector, 'id', {
      get() {
        redirectAway();
      },
    });
    console.log(detector);
  };

  const watchForDebugger = () => {
    const start = performance.now();
    debugger; // eslint-disable-line no-debugger
    if (performance.now() - start > DEBUG_PAUSE_THRESHOLD) {
      redirectAway();
    }
  };

  const startDetection = () => {
    window.addEventListener('resize', watchForResize, { passive: true });
    setInterval(watchForResize, 150);
    watchForConsole();
    consoleProbeId = setInterval(watchForConsole, CONSOLE_PROBE_MS);
    debugProbeId = setInterval(watchForDebugger, DEBUG_PROBE_MS);
  };

  const init = () => {
    settleBaselineGaps().then(() => {
      if (hasRedirected) return;
      startDetection();
    });
  };

  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init, { once: true });
  }
})();
