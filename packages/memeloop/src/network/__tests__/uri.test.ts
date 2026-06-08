import { describe, expect, it } from "vitest";

import { buildMemeloopFileUri, buildMemeloopUri, parseMemeloopUri } from "../uri.js";

describe("memeloop:// uri", () => {
  it("buildMemeloopFileUri normalizes leading slashes and encodes segments", () => {
    const uri = buildMemeloopFileUri("node a", "/a b/%/c");
    expect(uri).toBe("memeloop://node/node%20a/file/a%20b/%25/c");
  });

  it("buildMemeloopUri is an alias of buildMemeloopFileUri", () => {
    expect(buildMemeloopUri("n", "p")).toBe(buildMemeloopFileUri("n", "p"));
  });

  it("parseMemeloopUri returns null for non-matching prefix or missing node segment", () => {
    expect(parseMemeloopUri("http://x")).toBeNull();
    expect(parseMemeloopUri("memeloop://node/")).toBeNull();
    expect(parseMemeloopUri("memeloop://node/n1")).toBeNull(); // no slash after nodeId
  });

  it("parseMemeloopUri returns null when nodeId decoding fails", () => {
    // invalid percent encoding in nodeId
    expect(parseMemeloopUri("memeloop://node/%E0%A4/file/a")).toBeNull();
  });

  it("parseMemeloopUri returns null when kind is not file", () => {
    expect(parseMemeloopUri("memeloop://node/n1/dir/a")).toBeNull();
  });

  it("parseMemeloopUri supports empty file path", () => {
    expect(parseMemeloopUri("memeloop://node/n1/file/")).toEqual({
      scheme: "memeloop",
      kind: "file",
      nodeId: "n1",
      filePath: "",
    });
  });

  it("parseMemeloopUri decodes file path segments and returns null if decoding fails", () => {
    expect(parseMemeloopUri("memeloop://node/n%20x/file/a%20b/%25/c")).toEqual({
      scheme: "memeloop",
      kind: "file",
      nodeId: "n x",
      filePath: "a b/%/c",
    });

    // invalid percent encoding in path segment
    expect(parseMemeloopUri("memeloop://node/n1/file/%E0%A4")).toBeNull();
  });
});
