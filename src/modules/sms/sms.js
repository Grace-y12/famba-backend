// Temporary stub so the server boots without the real SMS provider.
// In dev, OTP codes come back as dev_code, so nothing is actually sent.
// Replace with the real provider (Africa's Talking, etc.) before production.
const noop = async (...args) => { console.log('[sms stub]', ...args); return { ok: true, stub: true }; };
module.exports = new Proxy({}, { get: () => noop });