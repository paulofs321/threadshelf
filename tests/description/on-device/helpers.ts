import { vi } from 'vitest';
import { OnDeviceModel } from '../../../src/description/on-device/model';
import type {
  LocalAiState,
  LocalModelFactory,
  LocalSession,
} from '../../../src/description/on-device/types';

export function fixture(
  response: unknown = { topics: ['hiring', 'interviews', 'applications'], keywords: ['careers'] },
) {
  const session = {
    contextUsage: 20,
    contextWindow: 8192,
    prompt: vi.fn<LocalSession['prompt']>().mockResolvedValue(JSON.stringify(response)),
    measureContextUsage: vi.fn<LocalSession['measureContextUsage']>().mockResolvedValue(200),
    clone: vi.fn<LocalSession['clone']>(),
    destroy: vi.fn(),
  };
  const base = {
    ...session,
    destroy: vi.fn(),
    clone: vi.fn<LocalSession['clone']>().mockResolvedValue(session),
  };
  const factory = {
    availability: vi.fn<LocalModelFactory['availability']>().mockResolvedValue('available'),
    create: vi.fn<LocalModelFactory['create']>().mockResolvedValue(base),
  };
  const publish = vi.fn<(state: LocalAiState) => void>();
  const model = new OnDeviceModel(() => factory, publish);

  const ready = async () => {
    await model.check();
    await model.enable();
  };

  return { model, factory, session, base, publish, ready };
}
