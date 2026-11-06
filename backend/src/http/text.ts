/** Text a person will read (names, hospitals): no lone surrogates (they would be silently altered when stored),
 * no control characters and no text-direction overrides (they can make one name look like another). */
const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const hidden = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
export const safeDisplayText = (value: string): boolean => !lone.test(value) && !hidden.test(value) && /[\p{L}\p{N}]/u.test(value);
