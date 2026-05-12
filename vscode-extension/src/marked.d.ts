declare module "marked" {
  interface MarkedOptions {
    breaks?: boolean;
    gfm?: boolean;
    async?: boolean;
    [key: string]: unknown;
  }
  interface MarkedStatic {
    (src: string, options?: MarkedOptions): string;
    parse(src: string, options?: MarkedOptions): string;
    use(options: MarkedOptions): void;
  }
  export const marked: MarkedStatic;
}
