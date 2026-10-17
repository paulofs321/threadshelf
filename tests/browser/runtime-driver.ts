import { browser } from 'wxt/browser';
import type { LocalSession } from '../../src/description/on-device/types';

// Compiled only into the temporary synthetic smoke extension. Permissions are pregranted there;
// component tests separately prove the production Connect gesture requests the exact origins.
browser.permissions.request = async () => true;
browser.runtime.onMessage.addListener((input: unknown, _sender, sendResponse) => {
  if (
    !input ||
    typeof input !== 'object' ||
    !('kind' in input) ||
    input.kind !== 'synthetic-panel-driver' ||
    !('command' in input)
  )
    return;

  const button = (text: string) =>
    [...document.querySelectorAll('button')].find(
      (item) => item.getAttribute('aria-label') === text || item.textContent === text,
    );

  if (input.command === 'show-connections') button('Connect')?.click();

  if (input.command === 'continue') button('Continue to search')?.click();

  if (input.command === 'connect-chat') button('Connect ChatGPT')?.click();

  if (input.command === 'connect-google') button('Connect Google Search AI Mode')?.click();

  if (input.command === 'check-ai') button('Check AI support')?.click();

  if (input.command === 'synthetic-ai') {
    const session = (): LocalSession => ({
      contextUsage: 20,
      contextWindow: 8192,
      measureContextUsage: async () => 200,
      prompt: async (prompt) => {
        if (String(prompt).startsWith('Interpret'))
          return JSON.stringify({ topics: ['fictional orchard'], keywords: [] });

        const data = JSON.parse(String(prompt).split('Untrusted input JSON:\n')[1] ?? '{}') as {
          candidates: { candidateId: string; evidence: { evidenceId: string }[] }[];
        };

        return JSON.stringify({
          selections: data.candidates.slice(0, 1).map((item) => ({
            candidateId: item.candidateId,
            score: 0.9,
            evidenceIds: item.evidence.slice(0, 1).map((part) => part.evidenceId),
          })),
        });
      },
      clone: async () => session(),
      destroy: () => {},
    });
    Object.defineProperty(globalThis, 'LanguageModel', {
      configurable: true,
      value: { availability: async () => 'available', create: async () => session() },
    });
    button('Search settings')?.click();
    button('Check AI support')?.click();
  }

  if (input.command === 'enable-ai') button('Enable local AI')?.click();

  if (input.command === 'description-mode') {
    const mode = document.querySelector<HTMLSelectElement>('#mode');

    if (mode) {
      mode.value = 'description';
      mode.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  if (input.command === 'search') {
    const query = document.querySelector<HTMLInputElement>('#query');

    if (query) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        query,
        'fictional orchard',
      );
      query.dispatchEvent(new Event('input', { bubbles: true }));
    }

    document.querySelector<HTMLButtonElement>('button[aria-label="Search"]')?.click();
  }

  sendResponse({
    ready: document.querySelector('h1')?.textContent === 'ThreadShelf',
    aiApi: typeof LanguageModel !== 'undefined',
    aiStatus: document.querySelector('[aria-label="Local AI"] [role="status"]')?.textContent,
    statuses: [...document.querySelectorAll('[role="status"]')].map((item) => item.textContent),
    results: document.querySelectorAll('[role="article"]').length,
    resultLinks: [...document.querySelectorAll<HTMLAnchorElement>('[role="article"] a')].map(
      (item) => item.href,
    ),
    dates: [...document.querySelectorAll<HTMLTimeElement>('[role="article"] time')].map(
      (item) => item.dateTime,
    ),
    explanations: [...document.querySelectorAll('summary')].filter(
      (item) => item.textContent === 'Why this matched',
    ).length,
    notes: [...document.querySelectorAll('[role="note"]')].map((item) => item.textContent),
    checkedProviders: [...document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
      .filter((item) => item.checked)
      .map((item) => item.parentElement?.textContent),
  });
});
