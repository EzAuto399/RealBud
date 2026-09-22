import { describe, expect, it } from "vitest";
import { JOIN_CODE_MESSAGES, encodeCompanyJoinCode, invitationFromJoinInput, isCompanyJoinCode, joinCodeFailureMessage, readCompanyJoinTarget } from "./company-join-code";

// Fictional values with the production shapes; no real certificate or invitation.
const hostCode = "RB1." + Buffer.from(JSON.stringify({ version: 1, origin: "https://office-host.local:48123", certificatePem: "fictional", companyId: "11111111-1111-4111-8111-111111111111" })).toString("base64url");
const invitation = "Fict1onal_invitation-token.value~0123456789";

describe("company join code", () => {
  it("round trips the host code and invitation through one code", () => {
    const code = encodeCompanyJoinCode(hostCode, invitation);
    expect(code.startsWith("RBJ1!")).toBe(true);
    expect(isCompanyJoinCode(code)).toBe(true);
    expect(readCompanyJoinTarget(code)).toEqual({ kind: "join-code", hostCode, invitationToken: invitation });
    expect(invitationFromJoinInput(code)).toBe(invitation);
  });

  it("tolerates whitespace and line breaks added by email or chat", () => {
    const code = encodeCompanyJoinCode(hostCode, invitation);
    const wrapped = `  ${code.slice(0, 40)}\n${code.slice(40, 90)}\r\n ${code.slice(90)}  `;
    expect(readCompanyJoinTarget(wrapped)).toEqual({ kind: "join-code", hostCode, invitationToken: invitation });
  });

  it("rejects a tampered code in any part", () => {
    const code = encodeCompanyJoinCode(hostCode, invitation);
    const flip = (index: number) => code.slice(0, index) + (code[index] === "A" ? "B" : "A") + code.slice(index + 1);
    const hostIndex = code.indexOf("RB1.") + 10;
    const invitationIndex = code.indexOf(invitation) + 3;
    for (const tampered of [flip(hostIndex), flip(invitationIndex), code.slice(0, -1) + (code.endsWith("0") ? "1" : "0")]) {
      expect(() => readCompanyJoinTarget(tampered)).toThrow(JOIN_CODE_MESSAGES.damaged);
      expect(() => invitationFromJoinInput(tampered)).toThrow(JOIN_CODE_MESSAGES.damaged);
    }
    const swapped = `RBJ1!${invitation}!${hostCode}!00000000`;
    expect(() => readCompanyJoinTarget(swapped)).toThrow(JOIN_CODE_MESSAGES.damaged);
  });

  it("rejects a truncated code wherever the paste was cut", () => {
    const code = encodeCompanyJoinCode(hostCode, invitation);
    for (const length of [6, 40, code.indexOf(invitation) - 1, code.indexOf(invitation) + 30, code.length - 9, code.length - 1]) {
      expect(() => readCompanyJoinTarget(code.slice(0, length))).toThrow(JOIN_CODE_MESSAGES.damaged);
    }
  });

  it("recognises an older host code on its own and passes an older invitation through", () => {
    expect(readCompanyJoinTarget(`  ${hostCode}\n`)).toEqual({ kind: "host-code", hostCode });
    expect(isCompanyJoinCode(hostCode)).toBe(false);
    expect(invitationFromJoinInput(`  ${invitation} `)).toBe(invitation);
    expect(invitationFromJoinInput("short-legacy-value")).toBe("short-legacy-value");
  });

  it("names what was pasted instead of a join code", () => {
    expect(() => readCompanyJoinTarget(" \n ")).toThrow(JOIN_CODE_MESSAGES.empty);
    expect(() => readCompanyJoinTarget(invitation)).toThrow(JOIN_CODE_MESSAGES.invitationOnly);
    expect(() => readCompanyJoinTarget("https://office-host.local/join")).toThrow(JOIN_CODE_MESSAGES.unknown);
    expect(() => readCompanyJoinTarget("RB1.not valid!")).toThrow(JOIN_CODE_MESSAGES.unknown);
    expect(() => readCompanyJoinTarget("RBJ2!anything!else!00000000")).toThrow(JOIN_CODE_MESSAGES.newer);
    expect(() => readCompanyJoinTarget("RB1." + "a".repeat(16_001))).toThrow(JOIN_CODE_MESSAGES.damaged);
  });

  it("refuses to encode values outside the host code and invitation shapes", () => {
    for (const [host, token] of [["RB2.abc", invitation], [hostCode, "too-short"], [hostCode, `${invitation}!x`], [`${hostCode}!`, invitation], ["RB1." + "a".repeat(12_000), invitation]]) {
      expect(() => encodeCompanyJoinCode(host, token)).toThrow(JOIN_CODE_MESSAGES.cannotEncode);
    }
  });

  it("rewrites only the host replies that would mislead a join code user", () => {
    expect(joinCodeFailureMessage("connect", 400)).toMatch(/new join code/);
    expect(joinCodeFailureMessage("connect", 503)).toBeUndefined();
    for (const status of [401, 404, 410]) expect(joinCodeFailureMessage("join", status)).toMatch(/already been used or has expired/);
    expect(joinCodeFailureMessage("join", 409)).toBeUndefined();
    expect(joinCodeFailureMessage("join", undefined)).toBeUndefined();
  });
});
