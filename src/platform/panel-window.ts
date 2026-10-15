import { browser } from 'wxt/browser';
import { validate } from '../contracts/validation';
import { PanelWindowSchema } from './policy';
import { clientTimeoutMs } from './protocol';

// Call only from the side panel: a worker's current window can be the last focused window.
export function currentPanelWindow(signal: AbortSignal): Promise<number | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    let finished = false;
    const finish = (windowId: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      resolve(windowId);
    };
    const cancel = () => finish(null);
    const timer = setTimeout(cancel, clientTimeoutMs);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      void browser.windows.getCurrent({ populate: false }).then((window) => {
        const result = validate(PanelWindowSchema, window);
        finish(result.ok ? result.value.id : null);
      }, cancel);
    } catch {
      cancel();
    }
  });
}
