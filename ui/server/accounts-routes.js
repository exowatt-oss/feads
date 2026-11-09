/* Public export: hosted accounts/SSO and directory routes are not installed. */
export const ACCOUNTS_INTERNAL_HEADER = 'x-feads-accounts-internal';
export const ACCOUNTS_INTERNAL_SECRET_ENV = 'FEADS_ACCOUNTS_INTERNAL_SECRET';
export function attachAccountsRoutes(app) {
  app.use('/api/accounts', (_req, res) => res.status(404).json({ error: 'accounts_provider_unavailable' }));
  app.use('/api/spaces', (_req, res) => res.status(404).json({ error: 'accounts_provider_unavailable' }));
  app.use('/api/admin/accounts', (_req, res) => res.status(404).json({ error: 'accounts_provider_unavailable' }));
}
