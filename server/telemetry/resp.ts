export type Resp = string | number | null | { error: string } | Resp[];
const maxBytes = 8 * 1024 * 1024;
export function command(...args: string[]): Buffer {
  return Buffer.from(
    `*${args.length}\r\n` +
      args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join(""),
  );
}
export class RespDecoder {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer | string): Resp[] {
    if (typeof chunk === "string") chunk = Buffer.from(chunk);
    if (this.buffer.length + chunk.length > maxBytes)
      throw new Error("RESP frame too large");
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const result: Resp[] = [];
    let offset = 0;
    while (offset < this.buffer.length) {
      const parsed = this.parse(offset, 0);
      if (!parsed) break;
      result.push(parsed[0]);
      offset = parsed[1];
    }
    this.buffer = this.buffer.subarray(offset);
    return result;
  }
  private parse(offset: number, depth: number): [Resp, number] | undefined {
    if (depth > 16) throw new Error("RESP nesting too deep");
    const end = this.buffer.indexOf("\r\n", offset);
    if (end < 0) return;
    const prefix = String.fromCharCode(this.buffer[offset]!);
    const header = this.buffer.toString("utf8", offset + 1, end);
    const start = end + 2;
    if (prefix === "+") return [header, start];
    if (prefix === "-") return [{ error: header }, start];
    if (![":", "$", "*"].includes(prefix) || !/^-?\d+$/.test(header))
      throw new Error("Invalid RESP frame");
    const size = Number(header);
    if (!Number.isSafeInteger(size)) throw new Error("Invalid RESP integer");
    if (prefix === ":") return [size, start];
    if (size === -1) return [null, start];
    if (size < 0 || size > maxBytes || (prefix === "*" && size > 4096))
      throw new Error("Invalid RESP length");
    if (prefix === "$") {
      if (this.buffer.length < start + size + 2) return;
      if (
        this.buffer.toString("ascii", start + size, start + size + 2) !== "\r\n"
      )
        throw new Error("Invalid RESP terminator");
      return [
        this.buffer.toString("utf8", start, start + size),
        start + size + 2,
      ];
    }
    const items: Resp[] = [];
    let next = start;
    for (let i = 0; i < size; i++) {
      const part = this.parse(next, depth + 1);
      if (!part) return;
      items.push(part[0]);
      next = part[1];
    }
    return [items, next];
  }
}
