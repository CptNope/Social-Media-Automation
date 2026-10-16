import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { presignUrl, signRequest, sha256Hex } from "../src/index.ts";

describe("SigV4 (checked against AWS's published examples)", () => {
  it("signs the 'get-vanilla' request from the AWS SigV4 test suite", () => {
    const h = signRequest(
      { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "service" },
      { method: "GET", url: new URL("https://example.amazonaws.com/"), payloadHash: sha256Hex(""), now: new Date("2015-08-30T12:36:00Z") },
    );
    assert.equal(h.authorization, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  });

  it("builds the S3 presigned-URL example from the S3 documentation", () => {
    const url = presignUrl(
      { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "s3" },
      { method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), expiresSec: 86400, now: new Date("2013-05-24T00:00:00Z") },
    );
    assert.equal(new URL(url).searchParams.get("X-Amz-Signature"), "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  });

  it("signs the S3 'GET object' example (Range header, x-amz-content-sha256)", () => {
    const h = signRequest(
      { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "s3" },
      { method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), headers: { range: "bytes=0-9" }, payloadHash: sha256Hex(""), now: new Date("2013-05-24T00:00:00Z"), s3: true },
    );
    assert.match(h.authorization!, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  });
});
