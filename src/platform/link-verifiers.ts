import type { LinkVerifiers } from '../contracts';
import { verifyChatGptOriginalLink } from '../providers/chatgpt/wire';
import { verifyGoogleOriginalLink } from '../providers/google-ai-mode/wire';

export const providerLinkVerifiers: LinkVerifiers = {
  chatgpt: verifyChatGptOriginalLink,
  'google-ai-mode': verifyGoogleOriginalLink,
};
