(() => {
  const REDIRECT_URL = 'https://www.pornhub.com';
  const DEVTOOLS_GAP = 160;
  let hasRedirected = false;

  const redirectAway = () => {
    if (hasRedirected) return;
    hasRedirected = true;
    window.location.replace(REDIRECT_URL);
  };

  const devtoolsOpen = () => {
    const widthGap = Math.abs(window.outerWidth - window.innerWidth);
    const heightGap = Math.abs(window.outerHeight - window.innerHeight);
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
