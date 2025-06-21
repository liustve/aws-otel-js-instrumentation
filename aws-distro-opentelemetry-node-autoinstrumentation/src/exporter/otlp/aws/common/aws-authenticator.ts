// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { diag } from '@opentelemetry/api';
import { getNodeVersion } from '../../../../utils';
let SignatureV4: any;
let HttpRequest: any;
let defaultProvider: any;
let Sha256: any;

let dependenciesLoaded = false;

if (getNodeVersion() >= 16) {
  try {
    defaultProvider = require('@aws-sdk/credential-provider-node').defaultProvider;
    Sha256 = require('@aws-crypto/sha256-js').Sha256;
    SignatureV4 = require('@smithy/signature-v4').SignatureV4;
    HttpRequest = require('@smithy/protocol-http').HttpRequest;
    dependenciesLoaded = true;
  } catch (error) {
    diag.error(`Failed to load required AWS dependency for SigV4 Signing: ${error}`);
  }
} else {
  diag.error('SigV4 signing requires at least Node major version 16');
}
// See: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html
const SIG_V4_HEADERS = ['x-amz-date', 'authorization', 'x-amz-content-sha256', 'x-amz-security-token'];

export class AwsAuthenticator {
  private endpoint: URL;
  private region: string;
  private service: string;

  constructor(endpoint: string, service: string) {
    this.endpoint = new URL(endpoint);
    this.region = endpoint.split('.')[1];
    this.service = service;
  }

  public async authenticate(headers: Record<string, string>, serializedData: Uint8Array | undefined) {
    // Only do SigV4 Signing if the required dependencies are installed.
    if (dependenciesLoaded && serializedData) {
      const cleanedHeaders = this.removeSigV4Headers(headers);

      const request = new HttpRequest({
        method: 'POST',
        protocol: 'https',
        hostname: this.endpoint.hostname,
        path: this.endpoint.pathname,
        body: serializedData,
        headers: {
          ...cleanedHeaders,
          host: this.endpoint.hostname,
        },
      });

      try {
        const signer = new SignatureV4({
          credentials: defaultProvider(),
          region: this.region,
          service: this.service,
          sha256: Sha256,
        });

        const signedRequest = await signer.sign(request);

        return signedRequest.headers;
      } catch (exception) {
        diag.debug(`Failed to sign/authenticate the given export request with error: ${exception}`);
      }
    }

    diag.debug('Given serialized data is undefined. Not authenticating.');
    return headers;
  }

  // Cleans up Sigv4 from headers to avoid accidentally copying them to the new headers
  private removeSigV4Headers(headers: Record<string, string>) {
    const newHeaders: Record<string, string> = {};

    for (const key in headers) {
      if (!SIG_V4_HEADERS.includes(key.toLowerCase())) {
        newHeaders[key] = headers[key];
      }
    }
    return newHeaders;
  }
}
