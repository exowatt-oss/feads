// No hosted Access/Departments UI in the standalone release.
export async function accountsApi() { return { ok: false, error: 'provider_unavailable' }; }
export function accountsActive() { return false; }
export function currentSpaceOf() { return ''; }
export function createAccessView() { return { load: async () => {} }; }
export function createDepartmentsView() { return { load: async () => {} }; }
export function createSpaceSelect() { return { load: async () => {} }; }
export function slugFor(name) { return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
