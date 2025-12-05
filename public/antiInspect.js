(() => {
  const REDIRECT_URL = 'https://www.pornhub.com';
  const DISABLE_DEVTOOL_SRC = 'https://cdn.jsdelivr.net/npm/disable-devtool';

  const loadDisableDevtool = () => {
    const script = document.createElement('script');
    script.src = DISABLE_DEVTOOL_SRC;
    script.setAttribute('disable-devtool-auto', '');
    script.onload = () => {
      if (typeof disableDevtool === 'function') {
        disableDevtool({
          ondevtoolopen: () => {
            window.location.replace(REDIRECT_URL);
          },
        });
      }
    };
    document.head.appendChild(script);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadDisableDevtool, { once: true });
  } else {
    loadDisableDevtool();
  }
})();
