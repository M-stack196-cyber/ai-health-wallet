export interface SecurityPolicy {
  refreshAbsoluteSeconds: number;
  refreshIdleSeconds: number;
  verificationSeconds: number;
  resetSeconds: number;
  resendCooldownSeconds: number;
  rateWindowSeconds: number;
  challengeRateMax: number;
}
export function getSecurityPolicy(): SecurityPolicy {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = process.env[name] ?? String(fallback), value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw Error('Invalid identity security configuration: ' + name);
    return value;
  };
  const policy = {
    refreshAbsoluteSeconds: integer('AUTH_REFRESH_ABSOLUTE_SECONDS',2592000,300,2592000),
    refreshIdleSeconds: integer('AUTH_REFRESH_IDLE_SECONDS',604800,60,604800),
    verificationSeconds: integer('AUTH_VERIFICATION_SECONDS',86400,60,86400),
    resetSeconds: integer('AUTH_RESET_SECONDS',900,60,1800),
    resendCooldownSeconds: integer('AUTH_RESEND_COOLDOWN_SECONDS',60,1,3600),
    rateWindowSeconds: integer('AUTH_SECURITY_RATE_WINDOW_SECONDS',900,60,3600),
    challengeRateMax: integer('AUTH_CHALLENGE_RATE_MAX',5,1,20),
  };
  if(policy.refreshIdleSeconds > policy.refreshAbsoluteSeconds) throw Error('Invalid refresh lifetime bounds.');
  return Object.freeze(policy);
}
