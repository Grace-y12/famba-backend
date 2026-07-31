/**
 * courier.js — pure logic for parcel delivery.
 *
 * Reuses the marketplace engine; this module adds only the parcel-specific
 * rules: validating delivery details, generating the recipient handover code,
 * and deciding when a delivery can be marked delivered.
 */
'use strict';

const crypto = require('crypto');

const VALID_SIZES = new Set(['small', 'medium', 'large']);

/**
 * Validate the delivery-specific parts of a request.
 * Returns { ok, reason }.
 */
function validateDeliveryDetails(d) {
  if (!d) return { ok: false, reason: 'delivery_details_required' };
  if (!VALID_SIZES.has(d.parcel_size)) return { ok: false, reason: 'invalid_parcel_size' };
  if (!d.parcel_desc || typeof d.parcel_desc !== 'string' || d.parcel_desc.trim().length < 2) {
    return { ok: false, reason: 'parcel_desc_required' };
  }
  if (!d.recipient_name || typeof d.recipient_name !== 'string') {
    return { ok: false, reason: 'recipient_name_required' };
  }
  // recipient_phone validated/normalised by the caller via phone-auth.
  if (!d.recipient_phone) return { ok: false, reason: 'recipient_phone_required' };
  return { ok: true, reason: null };
}

/** Short handover code (4 digits) the recipient gives the courier. */
function generateHandoverCode() {
  return crypto.randomInt(0, 10000).toString().padStart(4, '0');
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

/**
 * Can this delivery be marked delivered?
 * Requires the trip to be in_progress AND either a correct handover code
 * OR an explicit proof-of-delivery photo (fallback when recipient absent).
 *   trip: { status, delivery_code_hash }
 *   opts: { code?, hasDeliveryPhoto? }
 */
function canMarkDelivered(trip, opts = {}) {
  if (!trip) return { ok: false, reason: 'trip_not_found' };
  if (trip.status !== 'in_progress') return { ok: false, reason: 'trip_not_in_progress' };

  const codeOk = opts.code != null &&
    trip.delivery_code_hash != null &&
    hashCode(opts.code) === trip.delivery_code_hash;

  if (codeOk) return { ok: true, reason: null, method: 'code' };
  if (opts.hasDeliveryPhoto) return { ok: true, reason: null, method: 'photo' };

  return { ok: false, reason: 'need_code_or_delivery_photo' };
}

module.exports = {
  VALID_SIZES,
  validateDeliveryDetails,
  generateHandoverCode,
  hashCode,
  canMarkDelivered,
};
