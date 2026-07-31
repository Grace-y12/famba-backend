-- ============================================================
--  Migration 002: phone verification (OTP) for signup
-- ============================================================
--  Riders and drivers both sign up with a phone number + a
--  one-time code (OTP). We store codes HASHED, never in plain
--  text — if the table ever leaked, raw codes would let someone
--  hijack a signup in progress. Codes also expire quickly.
-- ============================================================

CREATE TABLE phone_verifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        TEXT NOT NULL,                 -- E.164, e.g. +263771234567
  code_hash    TEXT NOT NULL,                 -- SHA-256 of the 6-digit code
  attempts     INTEGER NOT NULL DEFAULT 0,    -- wrong-guess counter
  expires_at   TIMESTAMPTZ NOT NULL,          -- short-lived (e.g. 10 min)
  consumed_at  TIMESTAMPTZ,                   -- set once used; prevents reuse
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Look up the latest code for a phone quickly.
CREATE INDEX idx_phone_verifications_phone
  ON phone_verifications (phone, created_at DESC);
