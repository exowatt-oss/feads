/* Public export: no trusted internal MCP edge is bundled. */
export const INTERNAL_ACK_PATH = '/api/accounts/internal/notifications/ack';
export const INTERNAL_FLARES_PATH = '/api/accounts/internal/flares';
export function attachAccountsInternalEdgeRoutes(app) {
  app.use('/api/accounts/internal', (_req, res) => res.status(404).json({ error: 'accounts_provider_unavailable' }));
}
