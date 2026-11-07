// Web only. A browser cannot block screenshots or screen recording, so this never pretends to.
// The app already treats a failure here as "not protected"; the web banner tells the person so in plain words.
export async function preventScreenCaptureAsync(): Promise<never> { throw new Error("SCREEN_CAPTURE_PROTECTION_UNAVAILABLE_ON_WEB"); }
export async function allowScreenCaptureAsync(): Promise<void> { return undefined; }
export async function isAvailableAsync(): Promise<boolean> { return false; }
