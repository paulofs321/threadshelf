import type { ProviderOutcome } from '../contracts';

export const providerFailureText = {
  'login-expired': 'Login expired. Sign in on the provider site, then reconnect.',
  'permission-needed': 'Site permission is required. Reconnect to request access.',
  unavailable: 'Provider unavailable. Open the supported provider page and try again.',
  'schema-changed': 'Provider response changed. Search is unavailable until support is updated.',
  'rate-limited': 'Rate limited. Wait before retrying.',
  timeout: 'Search timed out. You can retry.',
  cancelled: 'Search cancelled.',
  'scope-changed': 'Account or selected context changed. Reconnect before searching.',
  interrupted: 'Connection interrupted. Reconnect to retry.',
} satisfies Record<Exclude<ProviderOutcome['status'], 'success'>, string>;
