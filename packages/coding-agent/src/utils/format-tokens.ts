/**
 * Compact token count with decimal units (1k = 1000), e.g. `999`, `1.2k`, `43k`, `3.6M`, `12M`.
 * Shared by the footer and the subagent rows.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}
