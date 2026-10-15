import { browser } from 'wxt/browser';
import { registerChromeAccess } from '../platform/chrome-access';

export default defineBackground(() => {
  registerChromeAccess();
  const configureAction = () => {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
      // No browser exception text enters logs. The native side panel menu remains available.
    });
  };
  browser.runtime.onInstalled.addListener(configureAction);
  browser.runtime.onStartup.addListener(configureAction);
  configureAction();
});
