/** Internal helpers for matching transport subscription topics. */

/**
 * Return the literal prefix for a trailing-`*` topic pattern.
 *
 * `*` itself is reserved as the catch-all topic. Non-trailing `*`
 * characters are treated literally by the transport matchers.
 */
export function topicWildcardPrefix(topic: string): string | undefined {
  if (topic === "*" || !topic.endsWith("*")) return undefined;
  return topic.slice(0, -1);
}

/** Match a subscription topic against a record type. */
export function topicMatches(topic: string, type: string): boolean {
  const prefix = topicWildcardPrefix(topic);
  return topic === "*" || topic === type || (prefix !== undefined && type.startsWith(prefix));
}
