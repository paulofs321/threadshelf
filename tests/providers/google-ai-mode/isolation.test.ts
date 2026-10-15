import { describe, expect, it } from 'vitest';
import {
  providerOutcomeSchemaFor,
  requireValid,
  searchOutcomeSchemaFor,
  SearchRequestSchema,
  SessionScopeSchema,
  validate,
} from '../../../src/contracts';
import { ChatGptProvider } from '../../../src/providers/chatgpt/adapter';
import { GoogleAiModeProvider } from '../../../src/providers/google-ai-mode/adapter';
import { chatGptRequest, verifiedChatGptScope } from '../../fixtures/chatgpt/requests';
import {
  googleAiModeRequest,
  verifiedGoogleAiModeScope,
} from '../../fixtures/google-ai-mode/requests';

const context = () => ({ signal: new AbortController().signal });

describe('Google Search AI Mode provider isolation', () => {
  it('does not accept a ChatGPT outcome with otherwise identical correlation and partitions', async () => {
    const googleScope = verifiedGoogleAiModeScope();
    const chatScope = requireValid(SessionScopeSchema, { ...googleScope, provider: 'chatgpt' });
    const googleRequest = googleAiModeRequest(googleScope);
    const chatRequest = chatGptRequest(chatScope);
    chatRequest.requestId = googleRequest.requestId;
    const result = await new ChatGptProvider(chatRequest.scope).search(chatRequest, context());
    expect(validate(providerOutcomeSchemaFor(googleRequest, {}), result).ok).toBe(false);
  });

  it('keeps retirement and cancellation local to the selected provider instance', async () => {
    const googleRequest = googleAiModeRequest();
    const chatRequest = chatGptRequest();
    const google = new GoogleAiModeProvider(googleRequest.scope);
    const chat = new ChatGptProvider(chatRequest.scope);
    const controller = new AbortController();
    google.invalidate();
    controller.abort();
    const [googleResult, chatResult] = await Promise.all([
      google.search(googleRequest, { signal: controller.signal }),
      chat.search(chatRequest, context()),
    ]);
    expect(googleResult.status).toBe('cancelled');
    expect(chatResult.status).toBe('unavailable');
    expect((await google.search(googleRequest, context())).status).toBe('scope-changed');
    expect(await chat.inspectSession(context())).toEqual({
      status: 'unavailable',
      provider: 'chatgpt',
      generation: chatRequest.scope.generation,
    });
  });

  it('rejects a delayed result when a different account becomes current', async () => {
    const scope = verifiedGoogleAiModeScope();
    const request = googleAiModeRequest(scope);
    const provider = new GoogleAiModeProvider(scope);
    const pending = provider.search(request, context());
    provider.invalidate();
    const replacement = googleAiModeRequest(
      requireValid(SessionScopeSchema, {
        ...scope,
        accountPartition: 'fictional-other-google-account',
        generation: scope.generation + 1,
      }),
    );
    expect(validate(providerOutcomeSchemaFor(replacement, {}), await pending).ok).toBe(false);
    expect((await provider.search(replacement, context())).status).toBe('scope-changed');
    expect(
      (await new GoogleAiModeProvider(replacement.scope).search(replacement, context())).status,
    ).toBe('unavailable');
  });

  it('preserves both unavailable outcomes without claiming successful or complete empty results', async () => {
    const googleRequest = googleAiModeRequest(verifiedGoogleAiModeScope());
    const chatRequest = chatGptRequest(verifiedChatGptScope());
    const request = requireValid(SearchRequestSchema, {
      requestId: 'fictional-both-providers',
      query: { ...googleRequest.query, providers: ['google-ai-mode', 'chatgpt'] },
      scopes: [googleRequest.scope, chatRequest.scope],
    });
    const outcomes = await Promise.all([
      new GoogleAiModeProvider(googleRequest.scope).search(
        { ...googleRequest, requestId: request.requestId, query: request.query },
        context(),
      ),
      new ChatGptProvider(chatRequest.scope).search(
        { ...chatRequest, requestId: request.requestId, query: request.query },
        context(),
      ),
    ]);
    const schema = searchOutcomeSchemaFor(request, {});
    const aggregate = {
      requestId: request.requestId,
      state: 'failure',
      results: [],
      outcomes,
      coverage: { extent: 'unknown', reasons: ['provider-failure'] },
    };
    expect(validate(schema, aggregate).ok).toBe(true);
    expect(validate(schema, { ...aggregate, state: 'success' }).ok).toBe(false);
    expect(validate(schema, { ...aggregate, outcomes: outcomes.slice(0, 1) }).ok).toBe(false);
    expect(
      validate(schema, { ...aggregate, coverage: { extent: 'complete', reasons: [] } }).ok,
    ).toBe(false);
  });
});
