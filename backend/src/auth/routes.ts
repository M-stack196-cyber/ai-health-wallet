import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import type { AuthenticationConfig } from "../config/auth.js";
import { ApiError } from "../http/errors.js";
import { createPatientRepository, type PatientDatabase } from "../patients/repository.js";
import { validateLogin, validateRegistration, validateProfilePatch } from "../patients/validation.js";
import { patientIdentity, rejectRequestBody, rejectQueryParameters, requireJson, requirePatient } from "./middleware.js";
import { createPasswordService } from "./passwords.js";
import { createTokenService } from "./tokens.js";

export function createPatientRoutes(database: PatientDatabase, config: AuthenticationConfig) {
  const patients = createPatientRepository(database);
  const passwords = createPasswordService(config);
  const tokens = createTokenService(config);
  const auth = Router();
  const profile = Router();
  const limiter = rateLimit({
    windowMs: config.rateLimitWindowMs, limit: config.rateLimitMax,
    standardHeaders: "draft-8", legacyHeaders: false,
    // trust proxy remains false; forwarded addresses never select limiter keys.
    validate: { xForwardedForHeader: false },
    message: { success: false, error: { code: "RATE_LIMITED", message: "Too many authentication attempts. Try again later." } },
  });
  auth.use(limiter, rejectQueryParameters);
  auth.post("/register", requireJson, async (req, res) => {
    const input = validateRegistration(req.body);
    const patient = await patients.register(input, await passwords.hash(input.password));
    res.status(201).json({ success: true, patient });
  });
  auth.post("/login", requireJson, async (req, res) => {
    const input = validateLogin(req.body);
    const credentials = await patients.credentials(input.email);
    const valid = await passwords.verify(input.password, credentials?.password_hash);
    if (!credentials || !valid) throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
    res.status(200).json({ success: true, access_token: await tokens.issue(credentials.id),
      token_type: "Bearer", expires_in: config.jwtLifetimeSeconds });
  });

  profile.use(requirePatient(tokens), rejectQueryParameters);
  profile.get("/me", rejectRequestBody, async (req, res) => {
    res.status(200).json({ success: true, patient: await patients.get(patientIdentity(req)) });
  });
  profile.patch("/me", requireJson, async (req, res) => {
    const changes = validateProfilePatch(req.body);
    res.status(200).json({ success: true, patient: await patients.update(patientIdentity(req), changes) });
  });
  return { auth, profile };
}
