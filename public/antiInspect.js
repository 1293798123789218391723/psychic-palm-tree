(() => {
  const REDIRECT_URL = 'https://www.pornhub.com';
  const DEVTOOLS_GAP = 160;
  const BASELINE_BUFFER = 40;
  const BASELINE_WINDOW_MS = 500;
  let hasRedirected = false;
  let initialWidthGap = 0;
  let initialHeightGap = 0;

  const redirectAway = () => {
    if (hasRedirected) return;
    hasRedirected = true;
    window.location.replace(REDIRECT_URL);
  };

  const measureBaselineGaps = () => {
    initialWidthGap = Math.abs(window.outerWidth - window.innerWidth);
    initialHeightGap = Math.abs(window.outerHeight - window.innerHeight);
  };

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

  const init = () => {
    measureBaselineGaps();
    window.addEventListener('resize', watchForResize, { passive: true });
    setInterval(watchForResize, 150);
    watchForConsole();
  };

  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init, { once: true });
  }
})();
