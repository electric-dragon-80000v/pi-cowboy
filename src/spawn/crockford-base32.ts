import { Buffer } from "buffer";

const characters = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const checksumCharacters = "*~$=U";

type VariantWithChecksum =
  | { variant?: "crockford"; checksum?: boolean }
  | { variant: "ulid"; checksum?: never };

type EncodeOptions = VariantWithChecksum;
type DecodeAsNumberOptions = { asNumber: true } & VariantWithChecksum;
type DecodeAsBufferOptions = { asNumber?: false } & VariantWithChecksum;

export class InvalidChecksumCharacterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidChecksumCharacterError";
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- captureStackTrace is a V8 extension, absent on other engines
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export class InvalidChecksumError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidChecksumError";
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- captureStackTrace is a V8 extension, absent on other engines
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * An implementation of the Crockford Base32 algorithm.
 *
 * Spec: https://www.crockford.com/base32.html
 */
export class CrockfordBase32 {
  static encode(
    input: Buffer | number | bigint,
    options?: EncodeOptions,
  ): string {
    if (Buffer.isBuffer(input)) {
      input = Buffer.from(input);
    } else {
      input = this.createBuffer(input);
    }

    const variant = options?.variant ?? "crockford";
    const checksum = options?.checksum ?? false;

    if (variant === "ulid") {
      if (checksum) {
        throw new Error("Checksums are not supported with the ulid variant");
      }
      return this.encodeUlid(input);
    }

    const output: number[] = [];
    let bitsRead = 0;
    let buffer = 0;

    for (const byte of input) {
      // Add current byte to start of buffer
      buffer = (buffer << 8) | byte;
      bitsRead += 8;

      while (bitsRead >= 5) {
        output.push((buffer >>> (bitsRead - 5)) & 0x1f);
        bitsRead -= 5;
      }
    }

    if (bitsRead > 0) {
      output.push((buffer << (5 - bitsRead)) & 0x1f);
    }

    let result = output.map((byte) => characters.charAt(byte)).join("");

    if (checksum) {
      result += this.computeChecksum(input);
    }

    return result;
  }

  private static computeChecksum(bytes: Iterable<number>): string {
    // Crockford's check symbol is value mod 37, where value is the number the
    // symbols represent. Fold byte-by-byte to avoid materializing a bigint;
    // acc stays < 37 so (acc * 256 + byte) fits comfortably in a JS number.
    let acc = 0;
    for (const byte of bytes) {
      acc = (acc * 256 + byte) % 37;
    }

    return (characters + checksumCharacters).charAt(acc);
  }

  static decode(input: string, options: DecodeAsNumberOptions): bigint;
  static decode(input: string, options?: DecodeAsBufferOptions): Buffer;
  static decode(
    input: string,
    options?: DecodeAsNumberOptions | DecodeAsBufferOptions,
  ): bigint | Buffer {
    // 1. Translate input to all uppercase
    // 2. Translate I, L, and O to valid base 32 characters
    // 3. Remove all hyphens
    input = input
      .toUpperCase()
      .replace(/O/g, "0")
      .replace(/[IL]/g, "1")
      .replace(/-+/g, "");

    const variant = options?.variant ?? "crockford";
    const checksum = options?.checksum ?? false;

    if (variant === "ulid") {
      if (checksum) {
        throw new Error("Checksums are not supported with the ulid variant");
      }
      return this.decodeUlid(input, options);
    }

    let providedCheck: string | null = null;
    if (checksum) {
      if (input.length === 0) {
        throw new InvalidChecksumCharacterError(
          "Cannot validate checksum: input is empty",
        );
      }

      const last = input.charAt(input.length - 1);
      if ((characters + checksumCharacters).indexOf(last) === -1) {
        throw new InvalidChecksumCharacterError(
          `Invalid checksum character: ${last}`,
        );
      }

      providedCheck = last;
      input = input.slice(0, -1);
    }

    const output: number[] = [];
    let bitsRead = 0;
    let buffer = 0;

    for (const character of input) {
      const byte = characters.indexOf(character);
      if (byte === -1) {
        throw new Error(
          `Invalid base 32 character found in string: ${character}`,
        );
      }

      bitsRead += 5;

      if (bitsRead >= 8) {
        bitsRead -= 8;
        output.push(buffer | (byte >> bitsRead));
        buffer = (byte << (8 - bitsRead)) & 0xff;
      } else {
        buffer |= byte << (8 - bitsRead);
      }
    }

    // Flush a trailing partial byte when it carries data: either bits are
    // non-zero, or a whole character (>= 5 bits) went unpaired and so cannot
    // be canonical zero padding.
    if (buffer > 0 || bitsRead >= 5) {
      output.push(buffer);
    }

    if (providedCheck !== null) {
      const computedCheck = this.computeChecksum(output);
      if (providedCheck !== computedCheck) {
        throw new InvalidChecksumError(
          `Checksum mismatch: expected '${computedCheck}' but found '${providedCheck}'`,
        );
      }
    }

    if (options?.asNumber === true) {
      return this.asNumber(output);
    }

    return this.asBuffer(output);
  }

  /**
   * Validates whether `input` is a Crockford Base32 string with a correct
   * trailing check symbol. Returns false for any malformed input (invalid
   * characters, mismatched checksum, empty string), never throws.
   *
   * Use {@link decode} with `{ checksum: true }` if you need typed errors.
   */
  static verify(input: string): boolean {
    try {
      this.decode(input, { checksum: true });
      return true;
    } catch {
      return false;
    }
  }

  private static encodeUlid(input: Buffer): string {
    // Keep empty binary input empty so Buffer round-trips do not become 0x00.
    if (input.length === 0) {
      return "";
    }

    // ULID variant uses modulo-based encoding (right-to-left, padding left)
    // Convert buffer to bigint
    let value = 0n;
    for (const byte of input) {
      value = (value << 8n) | BigInt(byte);
    }

    // Use repeated division by 32 to extract base32 digits
    const output: string[] = [];
    while (value > 0n) {
      const remainder = Number(value % 32n);
      output.unshift(characters.charAt(remainder));
      value /= 32n;
    }

    // Pad to the expected length based on input size
    // Each base32 character encodes 5 bits, so n bytes = n*8 bits
    // require ceil(n*8/5) characters
    const expectedLength = Math.ceil((input.length * 8) / 5);

    return output.join("").padStart(expectedLength, "0");
  }

  private static decodeUlid(
    input: string,
    options?: DecodeAsNumberOptions | DecodeAsBufferOptions,
  ): bigint | Buffer {
    // Empty encoded data represents no bytes; asNumber has no empty numeric
    // value, so return the same numeric zero used by other empty decodes.
    if (input.length === 0) {
      return options?.asNumber === true ? 0n : Buffer.from([]);
    }

    // ULID variant uses modulo-based decoding (reverse of encoding)
    // Treat the base32 string as a number in base 32
    let value = 0n;

    for (const character of input) {
      const digit = characters.indexOf(character);
      if (digit === -1) {
        throw new Error(
          `Invalid base 32 character found in string: ${character}`,
        );
      }
      value = value * 32n + BigInt(digit);
    }

    // Calculate expected output length based on input string length
    // Each base32 character represents 5 bits, so n characters = n*5 bits
    // We use floor because the encoder may have added padding characters
    // to reach the expected length, creating extra bits we should ignore
    const expectedBytes = Math.floor((input.length * 5) / 8);

    // Convert bigint to byte array
    const output: number[] = [];
    let temp = value;
    while (temp > 0n) {
      output.unshift(Number(temp & 0xffn));
      temp >>= 8n;
    }

    // For all-zero input the bigint loop emits no bytes, so seed one zero
    // byte. The padding loop below then extends to expectedBytes when needed
    // (e.g. "0000" -> two bytes); single-character "0" decodes to one byte
    // even though expectedBytes is 0.
    if (value === 0n) {
      output.push(0);
    }

    // Pad with leading zeros to match expected length
    while (output.length < expectedBytes) {
      output.unshift(0);
    }

    if (options?.asNumber === true) {
      return this.asNumber(output);
    }

    return this.asBuffer(output);
  }

  private static createBuffer(input: number | bigint): Buffer {
    if (typeof input === "number") {
      if (!Number.isSafeInteger(input)) {
        throw new Error("Input must be a safe integer");
      }

      input = BigInt(input);
    }

    if (input < 0n) {
      throw new Error("Input cannot be a negative number");
    }

    const bytes = [];

    while (input > 0n) {
      bytes.unshift(Number(input & 0xffn));
      input >>= 8n;
    }

    return Buffer.from(bytes);
  }

  private static asNumber(output: number[]): bigint {
    let outputNumber = 0n;

    output.forEach((byte) => {
      outputNumber <<= 8n;
      outputNumber |= BigInt(byte);
    });

    return outputNumber;
  }

  private static asBuffer(output: number[]): Buffer {
    return Buffer.from(
      output.map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      "hex",
    );
  }
}
