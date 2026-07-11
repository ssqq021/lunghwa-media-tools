declare module 'upng-js' {
  const UPNG: {
    decode(buffer: ArrayBuffer): unknown;
    encode(imgs: ArrayBuffer[], w: number, h: number, cnum: number, dels?: number[]): ArrayBuffer;
    toRGBA8(img: unknown): Uint8Array[];
  };
  export default UPNG;
}
