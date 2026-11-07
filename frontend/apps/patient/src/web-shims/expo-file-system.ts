// Web only. A browser has no private app file system. Picked files are browser File objects behind temporary blob: addresses,
// so "deleting" one means releasing its address. Native builds never load this file.
export class File {
  readonly uri: string;
  constructor(uri: string) { this.uri = uri; }
  get exists(): boolean { return this.uri.startsWith("blob:"); }
  delete(): void { if (this.exists) URL.revokeObjectURL(this.uri); }
}
