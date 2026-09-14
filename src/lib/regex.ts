/**
 * Makes user input safe to put inside a regular expression.
 *
 * The 2022 app searched with `new RegExp(userInput, 'i')`, so `.*` matched everything and
 * `(a+)+$` against a long string was a denial of service anyone could type into the
 * search box. Every admin lookup that uses `$regex` goes through this first and anchors
 * the result, so the input is a literal prefix and nothing else.
 */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
