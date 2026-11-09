// No development SSO bypass in the standalone build.
export function devSsoBlocker() { return null; }
export function assertDevSsoSafe() {}
export function createDevSsoVerifier() { return null; }
