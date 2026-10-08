import { Buffer } from "buffer";
import { describe, expect, it } from "vitest";
import {
  CrockfordBase32,
  InvalidChecksumCharacterError,
  InvalidChecksumError,
} from "../../src/spawn/crockford-base32.js";

describe("Base32Encoder", () => {
  describe("when encoding", () => {
    it("can encode a multiple of 5 bits", () => {
      expect(
        CrockfordBase32.encode(Buffer.from([0xa6, 0xe5, 0x63, 0x34, 0x5f])),
      ).toBe("MVJP6D2Z");
    });

    it("can encode a single byte", () => {
      expect(CrockfordBase32.encode(Buffer.from([0x74]))).toBe("EG");
    });

    it("can encode two bytes", () => {
      expect(CrockfordBase32.encode(Buffer.from([0x74, 0x74]))).toBe("EHT0");
    });

    it("can encode a large number", () => {
      expect(
        CrockfordBase32.encode(Buffer.from("593f8759e8431f5f", "hex")),
      ).toBe("B4ZREPF88CFNY");
    });

    it("does not strip off leading zeros", () => {
      expect(CrockfordBase32.encode(Buffer.from([0, 0, 0xa9]))).toBe("000AJ");
    });

    it("can encode a number", () => {
      expect(CrockfordBase32.encode(388_864)).toBe("0QQG0");
    });

    it("can encode a bigint", () => {
      expect(
        CrockfordBase32.encode(10_336_657_440_695_546_835_250_649_691n),
      ).toBe("45K4GPNC1860BH2339DG");
    });

    it("cannot take a negative number", () => {
      expect(() => CrockfordBase32.encode(-323213)).toThrowError(
        "Input cannot be a negative number",
      );
    });

    it.each`
      label                       | input
      ${"above MAX_SAFE_INTEGER"} | ${Number.MAX_SAFE_INTEGER + 1}
      ${"fractional"}             | ${3.14}
      ${"NaN"}                    | ${Number.NaN}
      ${"Infinity"}               | ${Number.POSITIVE_INFINITY}
      ${"-Infinity"}              | ${Number.NEGATIVE_INFINITY}
    `("rejects $label number inputs", ({ input }: { input: number }) => {
      expect(() => CrockfordBase32.encode(input)).toThrowError(
        "Input must be a safe integer",
      );
    });

    it("cannot take a negative bigint", () => {
      expect(() => CrockfordBase32.encode(-21233n)).toThrowError(
        "Input cannot be a negative number",
      );
    });

    it("can encode a UUID into base 32", () => {
      expect(
        CrockfordBase32.encode(
          Buffer.from("017cb3b93bcb40b6147d7813c5ad2339", "hex"),
        ),
      ).toBe("05YB7E9VSD0BC53XF09WBB9374");
    });

    it("doesn't modify the input buffer", () => {
      const buffer = Buffer.from("test");
      expect(CrockfordBase32.encode(buffer)).toBe("EHJQ6X0");
      expect(buffer.toString()).toBe("test");
    });
  });

  describe("when encoding with a checksum", () => {
    it("appends a single check symbol", () => {
      // 0xff = 255, encoded as 'ZW'; 255 % 37 = 33 -> '~'
      expect(
        CrockfordBase32.encode(Buffer.from([0xff]), { checksum: true }),
      ).toBe("ZW~");
    });

    it("computes the checksum from the numeric value, not the encoded chars", () => {
      // 0xa6e563345f as a bigint mod 37 = 27, characters[27] = 'V'
      expect(
        CrockfordBase32.encode(Buffer.from([0xa6, 0xe5, 0x63, 0x34, 0x5f]), {
          checksum: true,
        }),
      ).toBe("MVJP6D2ZV");
    });

    it("can encode a number with checksum", () => {
      // 1 % 37 = 1 -> '1'; encode(1) is '04'
      expect(CrockfordBase32.encode(1, { checksum: true })).toBe("041");
    });

    it("can encode a bigint with checksum", () => {
      // 255n % 37 = 33 -> '~'; encode(255n) is 'ZW'
      expect(CrockfordBase32.encode(255n, { checksum: true })).toBe("ZW~");
    });

    it('produces a "0" check symbol when input is the number zero', () => {
      // encode(0) is ''; 0 % 37 = 0 -> '0'
      expect(CrockfordBase32.encode(0, { checksum: true })).toBe("0");
    });

    it('produces a "0" check symbol for an empty buffer', () => {
      expect(CrockfordBase32.encode(Buffer.from([]), { checksum: true })).toBe(
        "0",
      );
    });

    it.each`
      byte    | char
      ${0x20} | ${"*"}
      ${0x21} | ${"~"}
      ${0x22} | ${"$"}
      ${0x23} | ${"="}
      ${0x24} | ${"U"}
    `(
      "can produce extended check character $char",
      ({ byte, char }: { byte: number; char: string }) => {
        const result = CrockfordBase32.encode(Buffer.from([byte]), {
          checksum: true,
        });
        expect(result.charAt(result.length - 1)).toBe(char);
      },
    );

    it("does not append a checksum when checksum option is false", () => {
      expect(
        CrockfordBase32.encode(Buffer.from([0xff]), { checksum: false }),
      ).toBe("ZW");
    });

    it("does not append a checksum when checksum option is omitted", () => {
      expect(
        CrockfordBase32.encode(Buffer.from([0xff]), { variant: "crockford" }),
      ).toBe("ZW");
    });

    it("doesn't modify the input buffer", () => {
      // 'test' = 0x74 0x65 0x73 0x74; folded mod 37 = 27 -> 'V'
      const buffer = Buffer.from("test");
      expect(CrockfordBase32.encode(buffer, { checksum: true })).toBe(
        "EHJQ6X0V",
      );
      expect(buffer.toString()).toBe("test");
    });

    it("rejects checksum: true with the ulid variant at runtime", () => {
      expect(() =>
        CrockfordBase32.encode(Buffer.from([0xff]), {
          variant: "ulid",
          // @ts-expect-error - the type system should reject this combination
          checksum: true,
        }),
      ).toThrowError("Checksums are not supported with the ulid variant");
    });
  });

  describe("when encoding ULIDs", () => {
    it("can encode", () => {
      // Test that variant option is accepted and produces ULID-style output
      // ULID uses modulo-based encoding (right-to-left, padding left)
      // 0xFF = 255 in decimal
      // Crockford: 11111|11100 -> ZW (pads right)
      // ULID: 00111|11111 -> 7Z (pads left)
      expect(
        CrockfordBase32.encode(Buffer.from([0xff]), { variant: "ulid" }),
      ).toBe("7Z");
    });

    it("can encode zero", () => {
      // 1-byte buffer: ceil(8/5) = 2 characters
      expect(
        CrockfordBase32.encode(Buffer.from([0x00]), { variant: "ulid" }),
      ).toBe("00");
    });

    it("can encode an empty buffer", () => {
      expect(CrockfordBase32.encode(Buffer.from([]), { variant: "ulid" })).toBe(
        "",
      );
    });

    it("can encode multiple zeros", () => {
      // 3-byte all-zero buffer: ceil(24/5) = 5 characters
      expect(
        CrockfordBase32.encode(Buffer.from([0x00, 0x00, 0x00]), {
          variant: "ulid",
        }),
      ).toBe("00000");
    });

    it("can encode a number", () => {
      // 255 should encode to '7Z' like Buffer.from([0xff])
      expect(CrockfordBase32.encode(255, { variant: "ulid" })).toBe("7Z");
    });

    it("can encode zero as a number", () => {
      // Numeric zero has no bits to encode, so it produces an empty string
      expect(CrockfordBase32.encode(0, { variant: "ulid" })).toBe("");
    });

    it("can encode a bigint", () => {
      expect(CrockfordBase32.encode(255n, { variant: "ulid" })).toBe("7Z");
    });

    it("can encode zero as a bigint", () => {
      expect(CrockfordBase32.encode(0n, { variant: "ulid" })).toBe("");
    });

    it("can encode a real ULID", () => {
      // The ULID from issue #4: 01FZD39998855SS2YG4XP4T14P
      expect(
        CrockfordBase32.encode(
          Buffer.from("017fda34a528414b9c8bd0276c4d0496", "hex"),
          { variant: "ulid" },
        ),
      ).toBe("01FZD39998855SS2YG4XP4T14P");
    });

    it("pads encoding for values with leading zeros - 16 bytes", () => {
      // 16-byte buffer starting with 0x00 should pad to 26 characters
      const result = CrockfordBase32.encode(
        Buffer.from("00ffffffffffffffffffffffffffffff", "hex"),
        { variant: "ulid" },
      );
      expect(result.length).toBe(26);
      expect(result[0]).toBe("0"); // Should have leading zero
    });

    it("pads encoding for values with multiple leading zeros - 16 bytes", () => {
      // 16-byte buffer with multiple leading zeros
      const result = CrockfordBase32.encode(
        Buffer.from("00000000000000000000000000000001", "hex"),
        { variant: "ulid" },
      );
      expect(result).toBe("00000000000000000000000001");
      expect(result.length).toBe(26);
    });

    it("pads encoding correctly for smaller buffers - 8 bytes", () => {
      // 8-byte buffer: ceil(64/5) = 13 characters
      const result = CrockfordBase32.encode(
        Buffer.from("00ffffffffffffff", "hex"),
        { variant: "ulid" },
      );
      expect(result.length).toBe(13);
      expect(result[0]).toBe("0"); // Should have leading zero
    });

    it("pads encoding correctly for smaller buffers - 10 bytes", () => {
      // 10-byte buffer: ceil(80/5) = 16 characters
      const result = CrockfordBase32.encode(
        Buffer.from("00ffffffffffffffffff", "hex"),
        { variant: "ulid" },
      );
      expect(result.length).toBe(16);
      expect(result[0]).toBe("0"); // Should have leading zero
    });

    it("pads encoding for all-zero buffer", () => {
      // 2-byte all-zero buffer: ceil(16/5) = 4 characters
      const result = CrockfordBase32.encode(Buffer.from([0x00, 0x00]), {
        variant: "ulid",
      });
      expect(result).toBe("0000");
      expect(result.length).toBe(4);
    });

    it("pads encoding for 16-byte all-zero buffer", () => {
      // 16-byte all-zero buffer: ceil(128/5) = 26 characters
      const result = CrockfordBase32.encode(
        Buffer.from("00000000000000000000000000000000", "hex"),
        { variant: "ulid" },
      );
      expect(result).toBe("00000000000000000000000000");
      expect(result.length).toBe(26);
    });
  });

  describe("when decoding", () => {
    it("can decode a multiple of 5 bits", () => {
      expect(CrockfordBase32.decode("MVJP6D2Z").toString("hex")).toBe(
        "a6e563345f",
      );
    });

    it("can decode a single byte", () => {
      expect(CrockfordBase32.decode("EG").toString()).toBe("t");
    });

    it("can decode two bytes", () => {
      expect(CrockfordBase32.decode("EHT0").toString()).toBe("tt");
    });

    it("can decode a large number", () => {
      expect(CrockfordBase32.decode("B4ZREPF88CFNY").toString("hex")).toBe(
        "593f8759e8431f5f",
      );
    });

    it("keeps leading zeros when decoding", () => {
      expect(CrockfordBase32.decode("000AJ").toString("hex")).toBe("0000a9");
    });

    it.each`
      inputChar | translatedChar | input     | output
      ${"I"}    | ${"1"}         | ${"AIm0"} | ${"5068"}
      ${"i"}    | ${"1"}         | ${"Aim0"} | ${"5068"}
      ${"L"}    | ${"1"}         | ${"ALm0"} | ${"5068"}
      ${"l"}    | ${"1"}         | ${"Alm0"} | ${"5068"}
      ${"O"}    | ${"0"}         | ${"AOM0"} | ${"5028"}
      ${"o"}    | ${"0"}         | ${"AoM0"} | ${"5028"}
    `(
      "translates $inputChar to $translatedChar when decoding",
      ({ input, output }: { input: string; output: string }) => {
        expect(CrockfordBase32.decode(input).toString("hex")).toBe(output);
      },
    );

    it("can decode a ULID", () => {
      expect(
        CrockfordBase32.decode("05YB7E9VSD0BC53XF09WBB9374").toString("hex"),
      ).toBe("017cb3b93bcb40b6147d7813c5ad2339");
    });

    it("does not add up to a complete byte", () => {
      expect(CrockfordBase32.decode("A1M").toString("hex")).toBe("5068");
    });

    it("decodes a single zero character to a zero byte", () => {
      expect(CrockfordBase32.decode("0").toString("hex")).toBe("00");
    });

    it("decodes a single non-zero character to a padded byte", () => {
      expect(CrockfordBase32.decode("1").toString("hex")).toBe("08");
    });

    it("preserves non-zero trailing bits in non-canonical input", () => {
      expect(CrockfordBase32.decode("01").toString("hex")).toBe("0040");
    });

    it("decodes an all-zero non-canonical input without dropping the trailing zero byte", () => {
      // 3 chars * 5 bits = 15 bits: one byte from the inner loop plus 7 trailing
      // bits that should flush as a second zero byte. The previous check
      // (buffer > 0) skipped this flush because the bits happened to be zero.
      expect(CrockfordBase32.decode("000").toString("hex")).toBe("0000");
    });

    it("can return a number", () => {
      expect(CrockfordBase32.decode("81X0", { asNumber: true })).toBe(16_506n);
    });

    it("rejects any invalid base 32 character", () => {
      expect(() => CrockfordBase32.decode("T&ZQ")).toThrowError(
        "Invalid base 32 character found in string: &",
      );
    });

    it("ignores hyphens", () => {
      expect(CrockfordBase32.decode("EDQPTS-90EDT7-4TBECW").toString()).toBe(
        "some string",
      );
    });

    it("ignores multiple adjacent hyphens", () => {
      expect(CrockfordBase32.decode("EDQPTS--90EDT7---4TBECW").toString()).toBe(
        "some string",
      );
    });
  });

  describe("when decoding with a checksum", () => {
    it("round-trips a single byte", () => {
      // 0xff encodes to 'ZW~' with checksum
      expect(
        CrockfordBase32.decode("ZW~", { checksum: true }).toString("hex"),
      ).toBe("ff");
    });

    it("decodes a multi-byte value with checksum", () => {
      expect(
        CrockfordBase32.decode("MVJP6D2ZV", { checksum: true }).toString("hex"),
      ).toBe("a6e563345f");
    });

    it("decodes a value with leading zeros", () => {
      // Buffer.from([0, 0, 0xa9]) -> '000AJ', checksum = 0xa9 % 37 = 21 -> 'N'
      expect(
        CrockfordBase32.decode("000AJN", { checksum: true }).toString("hex"),
      ).toBe("0000a9");
    });

    it('decodes "test" with checksum', () => {
      expect(
        CrockfordBase32.decode("EHJQ6X0V", { checksum: true }).toString(),
      ).toBe("test");
    });

    it("returns a number when asNumber is true", () => {
      expect(
        CrockfordBase32.decode("ZW~", { checksum: true, asNumber: true }),
      ).toBe(255n);
    });

    it('decodes "0" (empty data + zero checksum) to an empty buffer', () => {
      const result = CrockfordBase32.decode("0", { checksum: true });
      expect(result.length).toBe(0);
    });

    it('decodes "0" as 0n when asNumber is true', () => {
      expect(
        CrockfordBase32.decode("0", { checksum: true, asNumber: true }),
      ).toBe(0n);
    });

    it("strips hyphens before validating the checksum", () => {
      expect(
        CrockfordBase32.decode("EHJQ6X-0V", { checksum: true }).toString(),
      ).toBe("test");
    });

    it("accepts a lowercase check symbol", () => {
      // 0x24 encodes to '4GU'; lowercase 'u' should normalize to 'U'
      expect(
        CrockfordBase32.decode("4Gu", { checksum: true }).toString("hex"),
      ).toBe("24");
    });

    it.each`
      byte    | char
      ${0x20} | ${"*"}
      ${0x21} | ${"~"}
      ${0x22} | ${"$"}
      ${0x23} | ${"="}
      ${0x24} | ${"U"}
    `(
      "accepts extended check character $char",
      ({ byte, char }: { byte: number; char: string }) => {
        const encoded = CrockfordBase32.encode(Buffer.from([byte]), {
          checksum: true,
        });
        expect(encoded.endsWith(char)).toBe(true);
        const decoded = CrockfordBase32.decode(encoded, { checksum: true });
        expect(decoded.toString("hex")).toBe(
          byte.toString(16).padStart(2, "0"),
        );
      },
    );

    it("still applies I/L/O substitution to the data portion", () => {
      // 'AIm0' decodes to bytes [0x50, 0x68]; their checksum folds to 'C'
      expect(
        CrockfordBase32.decode("AIm0C", { checksum: true }).toString("hex"),
      ).toBe("5068");
    });

    it("throws InvalidChecksumCharacterError on empty input", () => {
      expect(() => CrockfordBase32.decode("", { checksum: true })).toThrow(
        InvalidChecksumCharacterError,
      );
    });

    it("throws InvalidChecksumCharacterError on invalid trailing character", () => {
      expect(() => CrockfordBase32.decode("ZW!", { checksum: true })).toThrow(
        InvalidChecksumCharacterError,
      );
    });

    it("auto-corrects I to 1 in the check symbol position", () => {
      // Buffer.from([1]) encodes to '04' with checksum '1'; typing 'I' for
      // '1' at the end should still validate after I->1 normalization.
      expect(
        CrockfordBase32.decode("04I", { checksum: true }).toString("hex"),
      ).toBe("01");
    });

    it("auto-corrects L to 1 in the check symbol position", () => {
      expect(
        CrockfordBase32.decode("04L", { checksum: true }).toString("hex"),
      ).toBe("01");
    });

    it("auto-corrects O to 0 in the check symbol position", () => {
      // Empty buffer encodes to '0' with checksum '0'; typing 'O' for '0'
      // at the end should still validate after O->0 normalization.
      expect(CrockfordBase32.decode("O", { checksum: true }).length).toBe(0);
    });

    it("throws InvalidChecksumError on a mismatched checksum", () => {
      // 0xff's correct checksum is '~'; '0' is wrong
      expect(() => CrockfordBase32.decode("ZW0", { checksum: true })).toThrow(
        InvalidChecksumError,
      );
    });

    it("rejects U in the data portion when checksum is enabled", () => {
      // The check symbol is the LAST char only; an earlier U is still invalid
      expect(() => CrockfordBase32.decode("UA0", { checksum: true })).toThrow(
        "Invalid base 32 character found in string: U",
      );
    });

    it("does not validate a checksum when option is omitted", () => {
      // Without checksum: true, '~' is just an invalid base32 character
      expect(() => CrockfordBase32.decode("ZW~")).toThrow(
        "Invalid base 32 character",
      );
    });

    it("rejects checksum: true with the ulid variant at runtime", () => {
      expect(() =>
        // @ts-expect-error - the type system should reject this combination
        CrockfordBase32.decode("ZW~", {
          variant: "ulid",
          checksum: true,
        }),
      ).toThrowError("Checksums are not supported with the ulid variant");
    });

    it("exports error classes that extend Error and have proper names", () => {
      const charErr = new InvalidChecksumCharacterError("msg");
      const sumErr = new InvalidChecksumError("msg");
      expect(charErr).toBeInstanceOf(Error);
      expect(sumErr).toBeInstanceOf(Error);
      expect(charErr.name).toBe("InvalidChecksumCharacterError");
      expect(sumErr.name).toBe("InvalidChecksumError");
    });
  });

  describe("when verifying", () => {
    it("returns true for a valid checksummed string", () => {
      expect(CrockfordBase32.verify("ZW~")).toBe(true);
    });

    it("returns true for a multi-byte checksummed string", () => {
      expect(CrockfordBase32.verify("MVJP6D2ZV")).toBe(true);
    });

    it("returns true for a checksummed string with hyphens", () => {
      expect(CrockfordBase32.verify("EHJQ6X-0V")).toBe(true);
    });

    it("returns true for lowercase input", () => {
      expect(CrockfordBase32.verify("mvjp6d2zv")).toBe(true);
    });

    it.each`
      input    | description
      ${"04I"} | ${"I in check position"}
      ${"04L"} | ${"L in check position"}
      ${"O"}   | ${"O in check position"}
    `(
      "returns true with auto-corrected $description",
      ({ input }: { input: string }) => {
        expect(CrockfordBase32.verify(input)).toBe(true);
      },
    );

    it('returns true for "0" (empty data with zero checksum)', () => {
      expect(CrockfordBase32.verify("0")).toBe(true);
    });

    it("returns true for an encode round-trip", () => {
      const encoded = CrockfordBase32.encode(Buffer.from("test"), {
        checksum: true,
      });
      expect(CrockfordBase32.verify(encoded)).toBe(true);
    });

    it("returns false for empty input", () => {
      expect(CrockfordBase32.verify("")).toBe(false);
    });

    it("returns false for an invalid check character", () => {
      expect(CrockfordBase32.verify("ZW!")).toBe(false);
    });

    it("returns false for a mismatched checksum", () => {
      // 0xff's correct checksum is '~'; '0' is wrong
      expect(CrockfordBase32.verify("ZW0")).toBe(false);
    });

    it("returns false for an invalid base32 character in the data portion", () => {
      // U is not allowed in the data; 'X' at the end is a valid check char
      expect(CrockfordBase32.verify("UAX")).toBe(false);
    });

    it('returns false for a "U" check symbol that does not match', () => {
      // 'U' = 36; for empty data, checksum is 0, so 'U' alone is a mismatch
      expect(CrockfordBase32.verify("U")).toBe(false);
    });

    it("does not throw for non-string input", () => {
      // verify is a yes/no contract — even programmer-error calls return false
      expect(() =>
        CrockfordBase32.verify(null as unknown as string),
      ).not.toThrow();
      expect(CrockfordBase32.verify(null as unknown as string)).toBe(false);
    });
  });

  describe("when decoding ULIDs", () => {
    it("can decode", () => {
      // Test round-trip: encoding should decode back correctly
      // '7Z' should decode back to Buffer.from([0xff])
      const result = CrockfordBase32.decode("7Z", { variant: "ulid" });
      expect(result.toString("hex")).toBe("ff");
    });

    it("can decode zero", () => {
      const result = CrockfordBase32.decode("0", { variant: "ulid" });
      expect(result.toString("hex")).toBe("00");
    });

    it("can decode an empty string", () => {
      const result = CrockfordBase32.decode("", { variant: "ulid" });
      expect(result.length).toBe(0);
      expect(result.toString("hex")).toBe("");
    });

    it("can decode as number", () => {
      const result = CrockfordBase32.decode("7Z", {
        variant: "ulid",
        asNumber: true,
      });
      expect(result).toBe(255n);
    });

    it("can decode an empty string as a number", () => {
      const result = CrockfordBase32.decode("", {
        variant: "ulid",
        asNumber: true,
      });
      expect(result).toBe(0n);
    });

    it("rejects invalid base 32 character", () => {
      expect(() => {
        CrockfordBase32.decode("Z$Z", { variant: "ulid" });
      }).toThrow("Invalid base 32 character found in string: $");
    });

    it("can decode a real ULID", () => {
      // The ULID from issue #4: 01FZD39998855SS2YG4XP4T14P
      expect(
        CrockfordBase32.decode("01FZD39998855SS2YG4XP4T14P", {
          variant: "ulid",
        }).toString("hex"),
      ).toBe("017fda34a528414b9c8bd0276c4d0496");
    });

    it("translates I to 1", () => {
      expect(
        CrockfordBase32.decode("7I", { variant: "ulid" }).toString("hex"),
      ).toBe("e1");
    });

    it("translates L to 1", () => {
      expect(
        CrockfordBase32.decode("7L", { variant: "ulid" }).toString("hex"),
      ).toBe("e1");
    });

    it("translates O to 0", () => {
      expect(
        CrockfordBase32.decode("7O", { variant: "ulid" }).toString("hex"),
      ).toBe("e0");
    });

    it("ignores hyphens", () => {
      expect(
        CrockfordBase32.decode("01FZD399-98855SS2-YG4XP4T14P", {
          variant: "ulid",
        }).toString("hex"),
      ).toBe("017fda34a528414b9c8bd0276c4d0496");
    });

    it("can decode all-zero string - 4 characters", () => {
      // 4 zeros: floor(4*5/8) = floor(2.5) = 2 bytes
      const result = CrockfordBase32.decode("0000", { variant: "ulid" });
      expect(result.toString("hex")).toBe("0000");
    });

    it("can decode all-zero string - 26 characters", () => {
      // 26 zeros: floor(26*5/8) = floor(16.25) = 16 bytes
      const result = CrockfordBase32.decode("00000000000000000000000000", {
        variant: "ulid",
      });
      expect(result.toString("hex")).toBe("00000000000000000000000000000000");
    });

    it("can decode max value (all 0xFF)", () => {
      // Maximum 16-byte value: all FFs
      const maxEncoded = CrockfordBase32.encode(
        Buffer.from("ffffffffffffffffffffffffffffffff", "hex"),
        { variant: "ulid" },
      );
      const decoded = CrockfordBase32.decode(maxEncoded, { variant: "ulid" });
      expect(decoded.toString("hex")).toBe("ffffffffffffffffffffffffffffffff");
    });
  });

  describe("when round-tripping ULIDs", () => {
    it("can round-trip with leading zeros", () => {
      const original = Buffer.from("007fda34a528414b9c8bd0276c4d0496", "hex");
      const encoded = CrockfordBase32.encode(original, { variant: "ulid" });
      const decoded = CrockfordBase32.decode(encoded, { variant: "ulid" });
      expect(decoded.toString("hex")).toBe("007fda34a528414b9c8bd0276c4d0496");
    });

    it("can round-trip with many leading zeros", () => {
      const original = Buffer.from("00000000000000001234567890abcdef", "hex");
      const encoded = CrockfordBase32.encode(original, { variant: "ulid" });
      const decoded = CrockfordBase32.decode(encoded, { variant: "ulid" });
      expect(decoded.toString("hex")).toBe("00000000000000001234567890abcdef");
    });

    it("can round-trip all-zero buffer", () => {
      const original = Buffer.from([0x00, 0x00]);
      const encoded = CrockfordBase32.encode(original, { variant: "ulid" });
      const decoded = CrockfordBase32.decode(encoded, { variant: "ulid" });
      expect(decoded.toString("hex")).toBe("0000");
    });

    it("can round-trip an empty buffer", () => {
      const original = Buffer.from([]);
      const encoded = CrockfordBase32.encode(original, { variant: "ulid" });
      const decoded = CrockfordBase32.decode(encoded, { variant: "ulid" });
      expect(encoded).toBe("");
      expect(decoded.length).toBe(0);
    });

    it("can round-trip 16-byte all-zero buffer", () => {
      // All-zero 16-byte buffer (like a zeroed ULID)
      const original = Buffer.from("00000000000000000000000000000000", "hex");
      const encoded = CrockfordBase32.encode(original, { variant: "ulid" });
      const decoded = CrockfordBase32.decode(encoded, { variant: "ulid" });
      expect(decoded.toString("hex")).toBe("00000000000000000000000000000000");
    });

    it("can round-trip a number", () => {
      const original = 123_456_789n;
      const encoded = CrockfordBase32.encode(original, { variant: "ulid" });
      const decoded = CrockfordBase32.decode(encoded, {
        variant: "ulid",
        asNumber: true,
      });
      expect(decoded).toBe(original);
    });

    it("can round-trip a bigint", () => {
      const original = 10_336_657_440_695_546_835_250_649_691n;
      const encoded = CrockfordBase32.encode(original, { variant: "ulid" });
      const decoded = CrockfordBase32.decode(encoded, {
        variant: "ulid",
        asNumber: true,
      });
      expect(decoded).toBe(original);
    });

    it("can round-trip max value (all 0xFF)", () => {
      const original = Buffer.from("ffffffffffffffffffffffffffffffff", "hex");
      const encoded = CrockfordBase32.encode(original, { variant: "ulid" });
      const decoded = CrockfordBase32.decode(encoded, { variant: "ulid" });
      expect(decoded.toString("hex")).toBe("ffffffffffffffffffffffffffffffff");
    });
  });
});
