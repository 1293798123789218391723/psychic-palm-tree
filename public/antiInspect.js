(() => {
  const REDIRECT_URL = 'https://www.pornhub.com';
  const DEVTOOLS_GAP = 160;
  const baseline = {
    widthGap: Math.abs(window.outerWidth - window.innerWidth),
    heightGap: Math.abs(window.outerHeight - window.innerHeight),
  };
  let hasRedirected = false;

  const redirectAway = () => {
    if (hasRedirected) return;
    hasRedirected = true;
    window.location.replace(REDIRECT_URL);
  };

  const devtoolsOpen = () => {
    const widthGap = Math.abs(window.outerWidth - window.innerWidth) - baseline.widthGap;
    const heightGap = Math.abs(window.outerHeight - window.innerHeight) - baseline.heightGap;
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

  window.addEventListener('resize', watchForResize, { passive: true });
  setInterval(watchForResize, 150);
  watchForConsole();
})();
