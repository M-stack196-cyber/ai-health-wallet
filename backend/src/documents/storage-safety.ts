export class StorageFailure extends Error {
  constructor(readonly mayHaveWritten=false){super("Private document storage operation failed.");}
}
export function validStorageReference(storage:{bucket:string;prefix:string},bucket:string,key:string):boolean{
  return bucket===storage.bucket&&key.startsWith(storage.prefix)
    &&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png)$/.test(key.slice(storage.prefix.length));
}
