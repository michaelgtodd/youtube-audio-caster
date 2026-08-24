'use strict';

function isLivePopup(popup) {
  return Boolean(popup
    && typeof popup.isDestroyed === 'function'
    && !popup.isDestroyed()
    && popup.webContents
    && typeof popup.webContents.isDestroyed === 'function'
    && !popup.webContents.isDestroyed());
}

function bindTrayActivation(tray, onActivate) {
  tray.on('click', onActivate);
  tray.on('right-click', onActivate);
}

function bindNavigationDenial(webContents) {
  const denyNavigation = event => event.preventDefault();
  webContents.on('will-navigate', denyNavigation);
  webContents.on('will-frame-navigate', denyNavigation);
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function bindBlurHiding(popup, onBlurred) {
  popup.on('blur', () => {
    if (popup.isDestroyed() || !popup.isVisible()) return;
    onBlurred();
    popup.hide();
  });
}

function bindEscapeHiding({ popup, isWindows, getTray }) {
  popup.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return;
    event.preventDefault();
    if (!popup.isDestroyed()) popup.hide();
    const tray = isWindows ? getTray() : null;
    if (tray && !tray.isDestroyed()) tray.focus();
  });
}

function bindTrayPopup({ popup, isWindows, getTray, onBlurred, onClosed }) {
  bindNavigationDenial(popup.webContents);
  bindBlurHiding(popup, onBlurred);
  popup.on('closed', onClosed);
  bindEscapeHiding({ popup, isWindows, getTray });
}

function isTrustedTrayPopupIpc({ event, args, popup, getExpectedUrl }) {
  if (!Array.isArray(args) || args.length !== 0 || !isLivePopup(popup)) return false;
  const popupContents = popup.webContents;
  const popupFrame = event && event.senderFrame;
  if (!popupFrame || event.sender !== popupContents || popupFrame !== popupContents.mainFrame) return false;
  const expectedUrl = getExpectedUrl();
  return typeof expectedUrl === 'string'
    && popupFrame.url === expectedUrl
    && popupContents.getURL() === expectedUrl;
}

module.exports = {
  bindTrayActivation,
  bindTrayPopup,
  isLivePopup,
  isTrustedTrayPopupIpc,
};
