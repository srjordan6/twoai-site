/**
 * Which MCP servers may be attributed to a company.
 *
 * WHY THIS EXISTS. The pipeline matched registry servers to companies by
 * looking for the company name anywhere in the server name. That is a
 * substring test, and short company names are substrings of unrelated words:
 * Box matched mailbox, toolbox and dropbox-mcp-server; SAP matched whatsapp
 * and trendsapi; Meta matched metadock and primeta; Vanta matched vantaj.
 * Measured across the built content set, 101 of 105 attributions were wrong.
 * Every one of them published a sentence claiming a company had shipped
 * software it had nothing to do with.
 *
 * THE RULE. MCP registry names are reverse-DNS namespaces: ai.anthropic/...,
 * com.microsoft/..., co.vantaj/... The namespace is everything before the
 * slash, and its last label is the organisation's own domain label. We
 * attribute a server to a company only when that label equals the company
 * name exactly once both are reduced to letters and digits. Nothing is
 * inferred from a partial match.
 *
 * WHAT THIS COSTS. Legitimate servers published under a namespace that does
 * not carry the company's name are dropped too. That is the right trade:
 * silence is recoverable, a false attribution on a page that says it draws
 * only from records is not. Where a real one is dropped, the fix is an
 * explicit alias, not a looser test.
 */

export interface McpRef {
  name: string;
  slug?: string;
  description?: string;
}

const flatten = (s: string): string => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The organisation label of a reverse-DNS registry namespace. */
export function namespaceLabel(serverName: string): string {
  const ns = String(serverName || '').split('/')[0];
  const labels = ns.split('.').filter(Boolean);
  return labels.length ? labels[labels.length - 1] : ns;
}

/** True when this server's namespace names this company exactly. */
export function attributableTo(serverName: string, companyName: string): boolean {
  const label = flatten(namespaceLabel(serverName));
  const company = flatten(companyName);
  return label.length > 0 && company.length > 0 && label === company;
}

/** The subset of servers we are willing to say a company published. */
export function ownedServers(servers: McpRef[] | null | undefined, companyName: string): McpRef[] {
  return (servers || []).filter((s) => attributableTo(s.name, companyName));
}
