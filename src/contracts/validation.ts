import * as v from 'valibot';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; code: 'invalid-contract' };

// Valibot issues can contain private input. Do not return/log them across a product boundary.
export function validate<T extends v.GenericSchema>(
  schema: T,
  input: unknown,
): ValidationResult<v.InferOutput<T>> {
  try {
    const result = v.safeParse(schema, input, { abortEarly: true, abortPipeEarly: true });
    return result.success
      ? { ok: true, value: result.output }
      : { ok: false, code: 'invalid-contract' };
  } catch {
    // Unexpected objects/getters must not leak their exception text into UI or diagnostics.
    return { ok: false, code: 'invalid-contract' };
  }
}

export function requireValid<T extends v.GenericSchema>(
  schema: T,
  input: unknown,
): v.InferOutput<T> {
  const result = validate(schema, input);
  if (!result.ok) throw new Error('Invalid contract context.');
  return result.value;
}
