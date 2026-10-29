export interface SharingConfig {origin:string;qrSeconds:number;linkSeconds:number;otpSeconds:number;sessionSeconds:number;resendSeconds:number;attempts:number;requests:number;}
export function sharingConfig(env:NodeJS.ProcessEnv):SharingConfig|undefined{
 if(!env.SHARING_PUBLIC_ORIGIN)return undefined;
 const u=new URL(env.SHARING_PUBLIC_ORIGIN);if((u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','[::1]'].includes(u.hostname)))||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('Invalid sharing origin.');
 const value=(key:string,fallback:number,max:number)=>{const v=Number(env[key]??fallback);if(!Number.isSafeInteger(v)||v<1||v>max)throw Error('Invalid sharing policy.');return v;};
 return {origin:u.origin,qrSeconds:value('SHARING_QR_SECONDS',3600,86400),linkSeconds:value('SHARING_LINK_SECONDS',86400,604800),otpSeconds:value('SHARING_OTP_SECONDS',600,1800),sessionSeconds:value('SHARING_SESSION_SECONDS',3600,86400),resendSeconds:value('SHARING_RESEND_SECONDS',60,600),attempts:value('SHARING_OTP_ATTEMPTS',5,10),requests:value('SHARING_OTP_REQUESTS_PER_HOUR',5,20)};
}
