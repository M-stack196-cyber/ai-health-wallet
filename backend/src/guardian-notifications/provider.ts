import {httpSecurityEmailProvider,EmailDeliveryFailure,type SecurityEmailConfig} from '../auth/security-email.js';
import type {SyntheticGuardianProvider} from './service.js';
// Reuse M01's bounded HTTP/receipt/idempotency transport, with a distinct medical sandbox endpoint.
// No real-recipient or production medical-provider activation is exposed in Phase 7.
export function syntheticGuardianEmailProvider(config:SecurityEmailConfig):SyntheticGuardianProvider{
 const url=new URL(config.endpoint);
 if(config.mode!=='sandbox'||url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.pathname!=='/guardian-medical-email'||url.username||url.password||url.hash||url.search||config.timeoutMs<1||config.timeoutMs>3000)throw Error('Separate loopback synthetic medical endpoint required.');
 const transport=httpSecurityEmailProvider(config);
 return {mode:'synthetic-offline',async send(message,signal){if(!/^[^\s@]+@[^\s@]+\.invalid$/.test(message.to)||message.from!=='guardian-demo@example.invalid'||!message.subject.startsWith('SYNTHETIC ONLY — ')||!message.text.startsWith('NON-CLINICAL DEMONSTRATION.'))throw new EmailDeliveryFailure('rejected',false);return transport.send(message,signal);}};
}
