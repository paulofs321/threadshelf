import * as v from 'valibot';
import { validate } from '../contracts/validation';

const PreferencesSchema = v.strictObject({
  version: v.literal(1),
  mode: v.picklist(['keyword', 'description']),
});
export type Preferences = v.InferOutput<typeof PreferencesSchema>;
export const defaultPreferences: Preferences = Object.freeze({ version: 1, mode: 'keyword' });
const key = 'threadshelf:preferences:v1';

/** Only this allowlisted setting persists. No query, scopes, consent, identity or excerpts. */
export class LocalPreferences {
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {}

  read(): Preferences {
    try {
      const result = validate(PreferencesSchema, JSON.parse(this.storage.getItem(key) ?? 'null'));

      return result.ok ? result.value : { ...defaultPreferences };
    } catch {
      return { ...defaultPreferences };
    }
  }

  write(input: Preferences): void {
    const result = validate(PreferencesSchema, input);

    if (!result.ok) return;

    try {
      this.storage.setItem(key, JSON.stringify(result.value));
    } catch {
      /* Settings are optional. */
    }
  }

  clear(): void {
    try {
      this.storage.removeItem(key);
    } catch {
      /* Private content is never persisted here. */
    }
  }
}
