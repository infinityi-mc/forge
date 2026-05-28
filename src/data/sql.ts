/**
 * Parameterized SQL fragments.
 *
 * Values passed to the tag are always collected as parameters unless
 * they are already SQL fragments, which allows deliberate composition
 * without string-concatenating user input.
 *
 * @module
 */

export interface SqlFragment {
  readonly text: string;
  readonly params: readonly unknown[];
}

export function sql(
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): SqlFragment {
  let text = "";
  const params: unknown[] = [];

  for (let index = 0; index < strings.length; index += 1) {
    text += strings[index] ?? "";
    if (index >= values.length) continue;

    const value = values[index];
    if (isSqlFragment(value)) {
      text += value.text;
      params.push(...value.params);
    } else {
      text += "?";
      params.push(value);
    }
  }

  return Object.freeze({ text, params });
}

export function raw(text: string): SqlFragment {
  return Object.freeze({ text, params: [] });
}

export function isSqlFragment(value: unknown): value is SqlFragment {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { text?: unknown }).text === "string" &&
    Array.isArray((value as { params?: unknown }).params)
  );
}
